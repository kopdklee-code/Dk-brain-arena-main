// DK BRAIN ARENA — Cloud Functions (서버 판정).
// 게임 규칙은 functions/generated/games.js 에서 가져온다. 이 파일은 src/games 원본을 빌드해 생성한 것으로
// Functions 디렉터리 안에 포함되므로 배포 묶음만으로 동작한다 (저장소의 다른 경로를 참조하지 않음).
import { randomInt } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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

/** 공개 문서·개인 문서에 사용자별로 허용된 정보만 기록 (트랜잭션 내부, 외부 부수효과 없음) */
function writeViews(tx, roomId, room, server, gameState, extra = {}) {
  const { rules } = lockedGame(room);
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
  tx.set(privateRef(roomId, room.hostUid), { role: 'host', view: rules.getView(gameState, { role: 'host' }) });
  for (const [uid, seat] of Object.entries(server.seats)) {
    tx.set(privateRef(roomId, uid), {
      role: 'player', playerId: seat.playerId, view: rules.getView(gameState, { role: 'player', playerId: seat.playerId }),
    });
  }
  return { status, finished: result.finished };
}

/**
 * 요청 식별자 기반 멱등 처리. 같은 requestId 는 저장된 응답을 그대로 돌려준다.
 * handler 는 트랜잭션 안에서 읽기를 마친 뒤 쓰기만 하며, 재시도되어도 외부 부수효과가 없다.
 */
async function idempotent(roomId, requestId, uid, handler) {
  return db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef(roomId, requestId));
    if (reqSnap.exists) {
      const saved = reqSnap.data();
      if (saved.uid !== uid) throw new HttpsError('already-exists', '이미 사용된 요청 ID입니다.');
      return { ...saved.response, duplicate: true };
    }
    const response = await handler(tx);
    tx.set(requestRef(roomId, requestId), { uid, response, createdAt: FieldValue.serverTimestamp() });
    return response;
  });
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
    const created = await db.runTransaction(async (tx) => {
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
      tx.create(serverRef(ref.id), { hostUid: uid, seats: {}, gameState: null });
      tx.create(privateRef(ref.id, uid), { role: 'host', view: null });
      return true;
    });
    if (created) return { roomId: ref.id, code };
  }
  throw new HttpsError('resource-exhausted', '입장 코드를 만들지 못했습니다. 다시 시도하세요.');
});

// ── 참가자: 입장·재접속 ───────────────────────────────────
export const joinRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = normalizeCode(request.data?.code);
  if (!code) throw new HttpsError('invalid-argument', '입장 코드는 6자리 영문·숫자입니다.');
  const nickname = normalizeNickname(request.data?.nickname);

  return db.runTransaction(async (tx) => {
    const codeSnap = await tx.get(db.collection('codes').doc(code));
    if (!codeSnap.exists) throw new HttpsError('not-found', '입장 코드에 해당하는 방이 없습니다.');
    const roomId = codeSnap.data().roomId;
    const [roomSnap, serverSnap, meSnap] = await Promise.all([
      tx.get(roomRef(roomId)), tx.get(serverRef(roomId)), tx.get(playerRef(roomId, uid)),
    ]);
    if (!roomSnap.exists || !serverSnap.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
    const room = roomSnap.data();
    const server = serverSnap.data();
    if (room.hostUid === uid) throw new HttpsError('failed-precondition', '진행자 계정은 같은 방에 참가자로 입장할 수 없습니다.');

    if (meSnap.exists) {
      // 재접속: 기존 자리를 그대로 돌려준다 (게임 시작 이후에도 허용)
      tx.update(playerRef(roomId, uid), { lastJoinAt: FieldValue.serverTimestamp() });
      const me = meSnap.data();
      return { roomId, code, playerId: me.playerId, nickname: me.nickname, rejoined: true, status: room.status };
    }
    if (room.status !== ROOM_STATUS.LOBBY) {
      throw new HttpsError('failed-precondition', '이미 시작된 방에는 새로 입장할 수 없습니다.');
    }
    if (!nickname) throw new HttpsError('invalid-argument', '닉네임은 1~12자로 입력하세요.');
    if (room.playerCount >= room.maxPlayers) throw new HttpsError('failed-precondition', '방 인원이 가득 찼습니다.');
    if (Object.values(server.seats).some((s) => s.nickname === nickname)) {
      throw new HttpsError('already-exists', '같은 닉네임이 이미 있습니다.');
    }
    const playerId = `p${room.playerCount + 1}`;
    tx.set(playerRef(roomId, uid), {
      playerId, nickname, joinedAt: FieldValue.serverTimestamp(), lastJoinAt: FieldValue.serverTimestamp(),
    });
    tx.update(serverRef(roomId), { [`seats.${uid}`]: { playerId, nickname } });
    tx.update(roomRef(roomId), { playerCount: room.playerCount + 1, updatedAt: FieldValue.serverTimestamp() });
    tx.set(privateRef(roomId, uid), { role: 'player', playerId, view: null });
    return { roomId, code, playerId, nickname, rejoined: false, status: room.status };
  });
});

// ── 진행자: 게임 시작 (gameId·gameVersion·설정 고정) ─────────
export const startGame = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = requireRoomId(request.data);
  const requestId = requireRequestId(request.data);
  return idempotent(roomId, requestId, uid, async (tx) => {
    const [roomSnap, serverSnap] = await Promise.all([tx.get(roomRef(roomId)), tx.get(serverRef(roomId))]);
    if (!roomSnap.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
    const room = roomSnap.data();
    const server = serverSnap.data();
    if (room.hostUid !== uid) throw new HttpsError('permission-denied', '이 방의 진행자만 시작할 수 있습니다.');
    if (room.status !== ROOM_STATUS.LOBBY) return { ok: false, error: { code: 'already-started', message: '이미 시작된 방입니다.' } };
    const { rules } = lockedGame(room);
    const players = Object.values(server.seats)
      .sort((a, b) => a.playerId.localeCompare(b.playerId, 'en', { numeric: true }))
      .map((s) => ({ id: s.playerId, name: s.nickname }));
    if (players.length < room.minPlayers) {
      return { ok: false, error: { code: 'not-enough-players', message: `플레이어가 ${room.minPlayers}명 이상 필요합니다.` } };
    }
    const created = rules.createGame({ players, config: room.config });
    if (!created.ok) return { ok: false, error: created.error };
    tx.update(serverRef(roomId), { gameState: created.state });
    writeViews(tx, roomId, room, server, created.state, { startedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  });
});

// ── 게임 행동 (참가자 제출·진행자 명령 공통) ───────────────────
export const gameAction = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = requireRoomId(request.data);
  const requestId = requireRequestId(request.data);
  const action = sanitizeAction(request.data?.action);
  if (!action) throw new HttpsError('invalid-argument', '행동 형식이 올바르지 않습니다.');

  return idempotent(roomId, requestId, uid, async (tx) => {
    const [roomSnap, serverSnap] = await Promise.all([tx.get(roomRef(roomId)), tx.get(serverRef(roomId))]);
    if (!roomSnap.exists) throw new HttpsError('not-found', '방을 찾을 수 없습니다.');
    const room = roomSnap.data();
    const server = serverSnap.data();

    let actor;
    if (room.hostUid === uid) actor = { role: 'host' };
    else if (server.seats[uid]) actor = { role: 'player', playerId: server.seats[uid].playerId };
    else throw new HttpsError('permission-denied', '이 방의 참가자가 아닙니다.');

    if (room.status !== ROOM_STATUS.PLAYING) {
      return { ok: false, error: { code: 'not-playing', message: room.status === ROOM_STATUS.FINISHED ? '이미 종료된 게임입니다.' : '아직 시작하지 않은 게임입니다.' } };
    }
    const { rules } = lockedGame(room);
    const res = rules.executeAction(server.gameState, actor, action);
    if (!res.ok) return { ok: false, error: res.error };
    tx.update(serverRef(roomId), { gameState: res.state });
    const { status } = writeViews(tx, roomId, room, server, res.state);
    return { ok: true, status };
  });
});
