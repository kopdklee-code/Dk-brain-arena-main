// DK BRAIN ARENA — Cloud Functions (서버 판정).
// 게임 규칙은 functions/generated/games.js 에서 가져온다. 이 파일은 src/games 원본을 빌드해 생성한 것으로
// Functions 디렉터리 안에 포함되므로 배포 묶음만으로 동작한다 (저장소의 다른 경로를 참조하지 않음).
import { randomInt, createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, FieldPath } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
// 'firebase-functions/v2' 묶음 모듈은 Realtime Database 제공자까지 즉시 로드하며, 그 하위 의존성
// (@firebase/database-compat)은 Node >=24.12 를 요구한다. 목표 런타임(nodejs22)에서 쓰지 않는 모듈을
// 불러오지 않도록 필요한 하위 경로만 import 한다.
import { setGlobalOptions } from 'firebase-functions/v2/options';
import {
  getGame, ROOM_STATUS, normalizeCode, normalizeNickname, isValidRequestId, sanitizeAction, CODE_ALPHABET, CODE_LENGTH,
} from '../generated/games.js';

const REGION = 'asia-northeast3';
setGlobalOptions({ region: REGION, maxInstances: 10 });

initializeApp();
const db = getFirestore();

// ── 공통 검증 ─────────────────────────────────────────────
function requireAuth(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  return uid;
}

// 진행자 = Google 로그인 + 관리자가 승인한 계정 (hostAccounts/{소문자 이메일}, enabled !== false).
// 승인 목록은 관리자가 Firebase 콘솔에서 관리하며 클라이언트는 읽기·쓰기 모두 불가(보안 규칙).
// 에뮬레이터에서는 자동 검증용으로 이메일/비밀번호 계정도 허용하되, 승인 목록 검사는 똑같이 적용한다.
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';
const HOST_PROVIDERS = IS_EMULATOR ? ['google.com', 'password'] : ['google.com'];

async function requireApprovedHost(request) {
  const uid = requireAuth(request);
  const token = request.auth.token || {};
  const provider = token.firebase?.sign_in_provider;
  if (!HOST_PROVIDERS.includes(provider)) {
    throw new HttpsError('permission-denied', '진행자는 Google 계정으로 로그인해야 방을 만들 수 있습니다.');
  }
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
  if (!email) throw new HttpsError('permission-denied', '이메일이 있는 계정으로 로그인해야 합니다.');
  if (provider === 'google.com' && token.email_verified !== true) {
    throw new HttpsError('permission-denied', '이메일 인증이 완료된 Google 계정이 필요합니다.');
  }
  const approval = await db.collection('hostAccounts').doc(email).get();
  if (!approval.exists || approval.data().enabled === false) {
    throw new HttpsError('permission-denied', `진행자 승인이 필요합니다. 관리자에게 ${email} 계정의 진행자 등록을 요청하세요.`);
  }
  return uid;
}

function requireRoomId(data) {
  const roomId = data?.roomId;
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(roomId)) {
    throw new HttpsError('invalid-argument', '방 ID가 올바르지 않습니다.');
  }
  return roomId;
}

function requireRequestId(data) {
  if (!isValidRequestId(data?.requestId)) throw new HttpsError('invalid-argument', '요청 ID가 올바르지 않습니다.');
  return data.requestId;
}

/** 방 시작 시 고정한 gameId·gameVersion 과 현재 서버에 등록된 규칙이 같은지 확인 */
function lockedGame(room) {
  const game = getGame(room.gameId);
  if (!game) throw new HttpsError('failed-precondition', '이 서버에 등록되지 않은 게임입니다.');
  if (game.manifest.gameVersion !== room.gameVersion) {
    throw new HttpsError('failed-precondition', `방의 게임 버전(${room.gameVersion})과 서버 규칙 버전(${game.manifest.gameVersion})이 다릅니다.`);
  }
  return game;
}

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const roomRef = (roomId) => db.collection('rooms').doc(roomId);
const serverRef = (roomId) => roomRef(roomId).collection('server').doc('state');
const privateRef = (roomId, uid) => roomRef(roomId).collection('private').doc(uid);
const playerRef = (roomId, uid) => roomRef(roomId).collection('players').doc(uid);
const requestRef = (roomId, requestId) => roomRef(roomId).collection('requests').doc(requestId);
// 참가자 개인 입력 (게임이 playerInput 계약을 선언한 경우). 서버 전용 — 참가자마다 문서를 나눠 동시 제출 경합을 없앤다.
const inputRef = (roomId, playerId) => serverRef(roomId).collection('inputs').doc(playerId);

/** 같은 문서에 트랜잭션이 몰려 잠금 시간 초과(ABORTED)가 나면 잠시 뒤 다시 시도. 요청 ID·사용자 기준으로 한 번만 반영되므로 안전 */
const isContention = (e) => e?.code === 10 || e?.code === 'aborted' || /ABORTED|contention|lock timeout/i.test(String(e?.message));
async function withContentionRetry(fn, attempts = 8) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpsError || !isContention(e) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 40 + randomInt(80 * (i + 1))));
    }
  }
}

/** 트랜잭션 안에서 모든 참가자 입력 읽기 → { playerId: input } */
async function readInputs(tx, roomId) {
  const snap = await tx.get(serverRef(roomId).collection('inputs'));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().input]));
}

/**
 * 공개 문서·개인 문서에 사용자별로 허용된 정보만 기록 (트랜잭션 내부, 외부 부수효과 없음).
 * prevState 가 있으면 내용이 바뀐 개인 문서만 다시 쓴다 (다수 참가자 동시 제출 시 쓰기·경합 감소).
 */
function writeViews(tx, roomId, room, seats, gameState, extra = {}, prevState = null, inputs = {}) {
  const { rules } = lockedGame(room);
  const changed = (viewer) => {
    const next = rules.getView(gameState, viewer);
    if (prevState && JSON.stringify(rules.getView(prevState, viewer)) === JSON.stringify(next)) return null;
    return next;
  };
  const result = rules.getResult(gameState);
  const status = result.finished ? ROOM_STATUS.FINISHED : ROOM_STATUS.PLAYING;
  tx.update(roomRef(roomId), {
    status,
    publicView: rules.getView(gameState, { role: 'public' }),
    result: result.finished ? result : null,
    revision: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
    ...(result.finished ? { finishedAt: FieldValue.serverTimestamp() } : {}),
    ...extra,
  });
  const hostView = changed({ role: 'host' });
  if (hostView) tx.set(privateRef(roomId, room.hostUid), { role: 'host', view: hostView });
  for (const seat of seats) {
    const view = changed({ role: 'player', playerId: seat.playerId, input: inputs[seat.playerId] ?? null });
    if (view) tx.set(privateRef(roomId, seat.uid), { role: 'player', playerId: seat.playerId, view });
  }
  return { status, finished: result.finished };
}

/**
 * 요청 식별자 기반 멱등 처리. 같은 requestId 는 저장된 응답을 그대로 돌려준다.
 * handler 는 트랜잭션 안에서 읽기를 마친 뒤 쓰기만 하며, 재시도되어도 외부 부수효과가 없다.
 */
async function idempotent(roomId, requestId, uid, handler) {
  return withContentionRetry(() => db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef(roomId, requestId));
    if (reqSnap.exists) {
      const saved = reqSnap.data();
      if (saved.uid !== uid) throw new HttpsError('already-exists', '이미 사용된 요청 ID입니다.');
      return { ...saved.response, duplicate: true };
    }
    const response = await handler(tx);
    tx.set(requestRef(roomId, requestId), { uid, response, createdAt: FieldValue.serverTimestamp() });
    return response;
  }));
}

// ── 진행자: 방 생성 ───────────────────────────────────────
export const createRoom = onCall(async (request) => {
  const uid = await requireApprovedHost(request);
  const game = getGame(request.data?.gameId);
  if (!game) throw new HttpsError('invalid-argument', '등록되지 않은 게임입니다.');
  const normalized = game.rules.normalizeConfig(request.data?.config || {});
  if (!normalized.ok) throw new HttpsError('invalid-argument', normalized.error.message);

  const ref = db.collection('rooms').doc();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeCode();
    const created = await withContentionRetry(() => db.runTransaction(async (tx) => {
      const codeSnap = await tx.get(db.collection('codes').doc(code));
      if (codeSnap.exists) return false;
      tx.create(db.collection('codes').doc(code), { roomId: ref.id, createdAt: FieldValue.serverTimestamp() });
      tx.create(ref, {
        code,
        hostUid: uid,
        gameId: game.manifest.gameId,
        gameVersion: game.manifest.gameVersion,
        title: game.manifest.title,
        isDemo: game.manifest.isDemo === true,
        config: normalized.config,
        status: ROOM_STATUS.LOBBY,
        minPlayers: game.manifest.players.min,
        maxPlayers: game.manifest.players.max,
        playerCount: 0,
        publicView: null,
        result: null,
        revision: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(serverRef(ref.id), { hostUid: uid, gameState: null });
      tx.create(privateRef(ref.id, uid), { role: 'host', view: null });
      return true;
    }));
    if (created) return { roomId: ref.id, code };
  }
  throw new HttpsError('resource-exhausted', '입장 코드를 만들지 못했습니다. 다시 시도하세요.');
});

// ── 참가자: 입장·재접속 ───────────────────────────────────
// 입장이 몰려도 공유 문서를 쓰지 않는다: 참가자마다 자리 문서(server/state/seats/{n})·닉네임 문서·본인 참가 문서를
// "없을 때만 생성"으로 확보한다. 이미 있는 자리면 다음 번호로 넘어간다. 방 문서는 읽기만 하고(대기실 확인),
// 입장 인원 표시(playerCount)는 확보가 끝난 뒤 따로 더한다. 게임 시작 판정은 참가 문서 수로 한다.
const seatRef = (roomId, n) => serverRef(roomId).collection('seats').doc(String(n));
const nicknameRef = (roomId, nickname) => serverRef(roomId).collection('nicknames').doc(createHash('sha256').update(nickname).digest('hex').slice(0, 40));
const isAlreadyExists = (e) => e?.code === 6 || /ALREADY_EXISTS/.test(String(e?.message));

export const joinRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = normalizeCode(request.data?.code);
  if (!code) throw new HttpsError('invalid-argument', '입장 코드는 6자리 영문·숫자입니다.');
  const nickname = normalizeNickname(request.data?.nickname);

  const codeSnap = await db.collection('codes').doc(code).get();
  if (!codeSnap.exists) throw new HttpsError('not-found', '입장 코드에 해당하는 방이 없습니다.');
  const roomId = codeSnap.data().roomId;
  const [roomSnap, meSnap] = await Promise.all([roomRef(roomId).get(), playerRef(roomId, uid).get()]);
  if (!roomSnap.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
  const room0 = roomSnap.data();
  if (room0.hostUid === uid) throw new HttpsError('failed-precondition', '진행자 계정은 같은 방에 참가자로 입장할 수 없습니다.');
  const rejoin = async (me) => {
    // 재접속: 기존 자리를 그대로 돌려준다 (게임 시작 이후에도 허용). 본인 문서만 갱신
    await playerRef(roomId, uid).update({ lastJoinAt: FieldValue.serverTimestamp() });
    return { roomId, code, playerId: me.playerId, nickname: me.nickname, rejoined: true, status: room0.status };
  };
  if (meSnap.exists) return rejoin(meSnap.data());
  if (room0.status !== ROOM_STATUS.LOBBY) throw new HttpsError('failed-precondition', '이미 시작된 방에는 새로 입장할 수 없습니다.');
  if (!nickname) throw new HttpsError('invalid-argument', '닉네임은 1~12자로 입력하세요.');

  const max = room0.maxPlayers;
  let n = Math.min(max, (room0.playerCount || 0) + 1);
  for (let tries = 0; tries < max; tries += 1) {
    let claimed;
    try {
      claimed = await withContentionRetry(() => db.runTransaction(async (tx) => {
        const [r, me, nick] = await Promise.all([tx.get(roomRef(roomId)), tx.get(playerRef(roomId, uid)), tx.get(nicknameRef(roomId, nickname))]);
        if (me.exists) return { rejoin: me.data() };
        if (r.data().status !== ROOM_STATUS.LOBBY) throw new HttpsError('failed-precondition', '이미 시작된 방에는 새로 입장할 수 없습니다.');
        if (nick.exists) throw new HttpsError('already-exists', '같은 닉네임이 이미 있습니다.');
        const playerId = `p${n}`;
        tx.create(seatRef(roomId, n), { uid, playerId, createdAt: FieldValue.serverTimestamp() });
        tx.create(nicknameRef(roomId, nickname), { uid });
        tx.create(playerRef(roomId, uid), {
          playerId, nickname, joinedAt: FieldValue.serverTimestamp(), lastJoinAt: FieldValue.serverTimestamp(),
        });
        tx.set(privateRef(roomId, uid), { role: 'player', playerId, view: null });
        return { playerId };
      }));
    } catch (e) {
      if (isAlreadyExists(e)) { n = (n % max) + 1; continue; } // 그 자리는 이미 찼음 → 다음 자리
      throw e;
    }
    if (claimed.rejoin) return rejoin(claimed.rejoin);
    await roomRef(roomId).update({ playerCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return { roomId, code, playerId: claimed.playerId, nickname, rejoined: false, status: ROOM_STATUS.LOBBY };
  }
  throw new HttpsError('failed-precondition', '방 인원이 가득 찼습니다.');
});

/** 트랜잭션 안에서 참가자 목록 읽기 → [{ uid, playerId, nickname }] (자리 번호 순) */
async function readSeats(tx, roomId) {
  const snap = await tx.get(roomRef(roomId).collection('players'));
  return snap.docs.map((d) => ({ uid: d.id, playerId: d.data().playerId, nickname: d.data().nickname }))
    .sort((a, b) => a.playerId.localeCompare(b.playerId, 'en', { numeric: true }));
}

// ── 진행자: 게임 시작 (gameId·gameVersion·설정 고정) ─────────
export const startGame = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = requireRoomId(request.data);
  const requestId = requireRequestId(request.data);
  return idempotent(roomId, requestId, uid, async (tx) => {
    const roomSnap = await tx.get(roomRef(roomId));
    if (!roomSnap.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
    const room = roomSnap.data();
    if (room.hostUid !== uid) throw new HttpsError('permission-denied', '이 방의 진행자만 시작할 수 있습니다.');
    if (room.status !== ROOM_STATUS.LOBBY) return { ok: false, error: { code: 'already-started', message: '이미 시작된 방입니다.' } };
    const { rules } = lockedGame(room);
    const seats = await readSeats(tx, roomId);
    if (seats.length < room.minPlayers) {
      return { ok: false, error: { code: 'not-enough-players', message: `플레이어가 ${room.minPlayers}명 이상 필요합니다.` } };
    }
    // 서버 시각(ms)을 규칙에 입력으로 전달 (규칙은 시계를 직접 읽지 않음). 트랜잭션 재시도마다 다시 읽는다.
    const players = seats.map((s) => ({ id: s.playerId, name: s.nickname }));
    const created = rules.createGame({ players, config: room.config, now: Date.now() });
    if (!created.ok) return { ok: false, error: created.error };
    tx.update(serverRef(roomId), { gameState: created.state });
    writeViews(tx, roomId, room, seats, created.state, { startedAt: FieldValue.serverTimestamp(), playerCount: seats.length });
    return { ok: true };
  });
});

// ── 게임 행동 (참가자 제출·진행자 명령 공통) ───────────────────
// 두 경로:
//  1) 참가자 개인 입력 (rules.playerInput.actions): 공유 상태는 읽기만 하고 본인 입력 문서·본인 개인 문서만 쓴다.
//     → 참가자끼리 같은 문서를 쓰지 않으므로 여러 명이 동시에 제출해도 잠금 경합이 없다.
//  2) 그 밖의 행동(진행자 명령 등): 공유 상태 + 모든 참가자 입력을 읽고 규칙이 새 상태를 정한다.
export const gameAction = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = requireRoomId(request.data);
  const requestId = requireRequestId(request.data);
  const action = sanitizeAction(request.data?.action);
  if (!action) throw new HttpsError('invalid-argument', '행동 형식이 올바르지 않습니다.');

  // 방의 게임·진행자는 생성 후 바뀌지 않으므로 트랜잭션 밖에서 읽어 경로를 정한다 (진행 상태 검사는 트랜잭션 안에서)
  const pre = await roomRef(roomId).get();
  if (!pre.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
  const { rules } = lockedGame(pre.data());
  const isInput = pre.data().hostUid !== uid && rules.playerInput?.actions?.includes(action.type) === true;

  if (isInput) {
    const response = await idempotent(roomId, requestId, uid, async (tx) => {
      const [serverSnap, meSnap] = await Promise.all([tx.get(serverRef(roomId)), tx.get(playerRef(roomId, uid))]);
      const server = serverSnap.data();
      if (!meSnap.exists) throw new HttpsError('permission-denied', '이 방의 참가자가 아닙니다.');
      const seat = meSnap.data();
      if (!server?.gameState) return { ok: false, error: { code: 'not-playing', message: '아직 시작하지 않은 게임입니다.' } };
      const inSnap = await tx.get(inputRef(roomId, seat.playerId));
      const prevInput = inSnap.exists ? inSnap.data().input : null;
      const actor = { role: 'player', playerId: seat.playerId };
      const res = rules.playerInput.execute(server.gameState, prevInput, actor, action, { now: Date.now() });
      if (!res.ok) return { ok: false, error: res.error };
      if (JSON.stringify(res.input) !== JSON.stringify(prevInput)) {
        tx.set(inputRef(roomId, seat.playerId), { uid, input: res.input, updatedAt: FieldValue.serverTimestamp() });
        tx.set(privateRef(roomId, uid), {
          role: 'player', playerId: seat.playerId, view: rules.getView(server.gameState, { ...actor, input: res.input }),
        });
      }
      const key = res.newInWindow ? rules.playerInput.key(server.gameState) : null;
      return { ok: true, status: ROOM_STATUS.PLAYING, ...(key ? { countKey: key } : {}) };
    });
    // 화면 표시용 제출 인원 (판정과 무관). 입력 트랜잭션과 분리해 참가자 간 경합을 만들지 않는다. 재시도 응답에는 다시 더하지 않음
    if (response.ok && response.countKey && !response.duplicate && /^[A-Za-z0-9_-]{1,40}$/.test(response.countKey)) {
      await roomRef(roomId).update(new FieldPath('inputCounts', response.countKey), FieldValue.increment(1)).catch(() => {});
    }
    const { countKey, ...rest } = response;
    return rest;
  }

  return idempotent(roomId, requestId, uid, async (tx) => {
    const [roomSnap, serverSnap, seats] = await Promise.all([tx.get(roomRef(roomId)), tx.get(serverRef(roomId)), readSeats(tx, roomId)]);
    const room = roomSnap.data();
    const server = serverSnap.data();

    let actor;
    const mySeat = seats.find((x) => x.uid === uid);
    if (room.hostUid === uid) actor = { role: 'host' };
    else if (mySeat) actor = { role: 'player', playerId: mySeat.playerId };
    else throw new HttpsError('permission-denied', '이 방의 참가자가 아닙니다.');

    if (room.status !== ROOM_STATUS.PLAYING) {
      return { ok: false, error: { code: 'not-playing', message: room.status === ROOM_STATUS.FINISHED ? '이미 종료된 게임입니다.' : '아직 시작하지 않은 게임입니다.' } };
    }
    const inputs = rules.playerInput ? await readInputs(tx, roomId) : {};
    const res = rules.executeAction(server.gameState, actor, action, { now: Date.now(), inputs });
    if (!res.ok) return { ok: false, error: res.error };
    tx.update(serverRef(roomId), { gameState: res.state });
    const { status } = writeViews(tx, roomId, room, seats, res.state, {}, server.gameState, inputs);
    return { ok: true, status };
  });
});

// ── 서버 시각 (화면 타이머 보정용, 공통) ─────────────────────
// 마감 판정은 규칙이 서버 시각으로 한다. 이 값은 화면의 남은 시간 표시를 서버 시계에 맞추는 데만 쓴다.
export const serverTime = onCall((request) => {
  requireAuth(request);
  return { now: Date.now() };
});
