// 에뮬레이터 통합 테스트 (Auth·Firestore·Functions). firebase emulators:exec 안에서 실행한다.
// 서로 다른 인증 상태: 진행자(이메일 계정), 참가자 2명(각각 익명), 외부인(익명), 비로그인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously, createUserWithEmailAndPassword, signInWithCredential, GoogleAuthProvider } from 'firebase/auth';
import { approveHostInEmulator } from '../scripts/emulator-approve-host.mjs';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import * as rules from '../src/games/demo-number-choice/rules.js';
import { SEQUENCES, runLocal } from './fixtures/sequences.mjs';

const PROJECT = 'demo-dk-brain-arena';
const REGION = 'asia-northeast3';
const GAME = 'demo-number-choice';
const apps = [];

// kind: 'host'(승인된 이메일 테스트 계정) | 'unapproved-host' | 'google'(opts.email, opts.verified, opts.approve) | 'player' | 'signed-out'
async function client(kind, opts = {}) {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT, appId: '1:0:web:test' }, `${kind}-${randomUUID()}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  if (kind === 'host' || kind === 'unapproved-host') {
    // 에뮬레이터 전용 테스트 계정 (실행마다 새로 생성). 'host' 는 승인 목록에도 추가
    const email = `host-${randomUUID().slice(0, 8)}@example.test`;
    if (kind === 'host') await approveHostInEmulator(email);
    await createUserWithEmailAndPassword(auth, email, `test-${randomUUID()}`);
  } else if (kind === 'google') {
    // 에뮬레이터는 서명 없는 Google ID 토큰(JSON)을 받아 google.com 제공자로 로그인시킨다
    const email = opts.email || `g-${randomUUID().slice(0, 8)}@example.test`;
    if (opts.approve) await approveHostInEmulator(email, { enabled: opts.enabled ?? true });
    const idToken = JSON.stringify({ sub: `google-${randomUUID()}`, email, email_verified: opts.verified ?? true });
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  } else if (kind !== 'signed-out') {
    await signInAnonymously(auth);
  }
  const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;
  return { app, auth, db, uid: auth.currentUser?.uid, call };
}

const rid = () => randomUUID().replace(/-/g, '');
const choose = (c, roomId, round, value, requestId = rid()) => c.call('gameAction', { roomId, requestId, action: { type: 'choose', round, value } });
const closeRound = (c, roomId, round, requestId = rid()) => c.call('gameAction', { roomId, requestId, action: { type: 'closeRound', round } });

async function expectCallError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, `functions/${code}`, `기대 ${code}, 실제 ${err.code}: ${err.message}`);
    return true;
  });
}
async function expectDenied(promise) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'permission-denied', `기대 permission-denied, 실제 ${err.code}`);
    return true;
  });
}

async function setupRoom(names = ['가람', '나래']) {
  const host = await client('host');
  const p1 = await client('player');
  const p2 = await client('player');
  const { roomId, code } = await host.call('createRoom', { gameId: GAME, config: {} });
  const j1 = await p1.call('joinRoom', { code, nickname: names[0] });
  const j2 = await p2.call('joinRoom', { code, nickname: names[1] });
  return { host, p1, p2, roomId, code, j1, j2 };
}

async function roomDoc(c, roomId) {
  return (await getDoc(doc(c.db, 'rooms', roomId))).data();
}

test.after(async () => {
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

test('0) 진행자 승인: Google 로그인 + 승인 목록(hostAccounts)만 방 생성 가능', async () => {
  // 승인된 Google 계정 (이메일 대소문자 무관)
  const tag = randomUUID().slice(0, 8);
  const approved = await client('google', { email: `Admin-${tag}@Example.test`, approve: true });
  assert.equal(approved.auth.currentUser.providerData[0].providerId, 'google.com');
  const room = await approved.call('createRoom', { gameId: GAME });
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  // 승인되지 않은 Google 계정
  const stranger = await client('google', { approve: false });
  await expectCallError(stranger.call('createRoom', { gameId: GAME }), 'permission-denied');
  // 승인 해제(enabled:false)
  const disabled = await client('google', { approve: true, enabled: false });
  await expectCallError(disabled.call('createRoom', { gameId: GAME }), 'permission-denied');
  // 이메일 미인증 Google 계정
  const unverified = await client('google', { approve: true, verified: false });
  await expectCallError(unverified.call('createRoom', { gameId: GAME }), 'permission-denied');
  // 승인되지 않은 이메일 테스트 계정·익명 사용자
  const unapproved = await client('unapproved-host');
  await expectCallError(unapproved.call('createRoom', { gameId: GAME }), 'permission-denied');
  const anon = await client('player');
  await expectCallError(anon.call('createRoom', { gameId: GAME }), 'permission-denied');
  // 거부 메시지에 승인 요청 안내
  await assert.rejects(stranger.call('createRoom', { gameId: GAME }), /진행자 승인이 필요합니다/);
  // 승인 목록은 클라이언트가 읽거나 스스로 등록할 수 없음
  await expectDenied(getDoc(doc(stranger.db, 'hostAccounts', 'anyone@example.test')));
  await expectDenied(getDocs(collection(approved.db, 'hostAccounts')));
  await expectDenied(setDoc(doc(stranger.db, 'hostAccounts', stranger.auth.currentUser.email), { enabled: true }));
});

test('1) 진행자·참가자 2명: 방 생성 → 참가 → 3라운드 → 결과', async () => {
  const { host, p1, p2, roomId, code, j1, j2 } = await setupRoom();
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(j1.playerId, 'p1');
  assert.equal(j2.playerId, 'p2');
  assert.notEqual(p1.uid, p2.uid);

  let room = await roomDoc(p1, roomId);
  assert.equal(room.status, 'lobby');
  assert.equal(room.playerCount, 2);
  assert.equal(room.gameVersion, '0.1.0');

  assert.deepEqual(await host.call('startGame', { roomId, requestId: rid() }), { ok: true });
  room = await roomDoc(host, roomId);
  assert.equal(room.status, 'playing');
  assert.equal(room.publicView.round, 1);

  const seq = SEQUENCES[0];
  for (const [index, [a, b]] of seq.rounds.entries()) {
    const round = index + 1;
    if (a !== null) assert.equal((await choose(p1, roomId, round, a)).ok, true);
    if (b !== null) assert.equal((await choose(p2, roomId, round, b)).ok, true);
    // 제출된 선택은 공개 정보로 표시됨
    const pub = (await roomDoc(host, roomId)).publicView;
    assert.equal(pub.players.find((p) => p.id === 'p1').choice, a);
    assert.equal((await closeRound(host, roomId, round)).ok, true);
  }
  room = await roomDoc(p2, roomId);
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.result.ranking.map((r) => [r.name, r.score, r.rank]), [['가람', 6, 1], ['나래', 3, 2]]);

  const priv = (await getDoc(doc(p1.db, 'rooms', roomId, 'private', p1.uid))).data();
  assert.equal(priv.playerId, 'p1');
  assert.equal(priv.view.me, 'p1');
  assert.equal(priv.view.phase, 'finished');

  // 종료 후 행동 거부
  const after = await choose(p1, roomId, 3, 1);
  assert.equal(after.ok, false);
  assert.equal(after.error.code, 'not-playing');
});

test('2) 재접속: 같은 UID는 시작 이후에도 기존 자리 복구, 새 UID는 입장 거부', async () => {
  const { host, p1, roomId, code } = await setupRoom();
  await host.call('startGame', { roomId, requestId: rid() });
  await choose(p1, roomId, 1, 2);
  const again = await p1.call('joinRoom', { code, nickname: '다른이름' });
  assert.equal(again.rejoined, true);
  assert.equal(again.playerId, 'p1');
  assert.equal(again.nickname, '가람', '재접속 시 기존 닉네임 유지');
  const priv = (await getDoc(doc(p1.db, 'rooms', roomId, 'private', p1.uid))).data();
  assert.equal(priv.view.players.find((p) => p.id === 'p1').choice, 2, '재접속 후 현재 상태(제출 내역) 복구');
  const late = await client('player');
  await expectCallError(late.call('joinRoom', { code, nickname: '늦은이' }), 'failed-precondition');
});

test('2-1) 대기실: 정원 초과·진행자 본인 입장·닉네임 중복 거부', async () => {
  const host = await client('host');
  const a = await client('player');
  const b = await client('player');
  const c = await client('player');
  const { code } = await host.call('createRoom', { gameId: GAME });
  await a.call('joinRoom', { code, nickname: '하나' });
  await expectCallError(b.call('joinRoom', { code, nickname: '하나' }), 'already-exists');
  await b.call('joinRoom', { code, nickname: '두리' });
  await expectCallError(c.call('joinRoom', { code, nickname: '세찌' }), 'failed-precondition');
  await expectCallError(host.call('joinRoom', { code, nickname: '진행' }), 'failed-precondition');
  await expectCallError(a.call('joinRoom', { code: 'ZZZZZZ', nickname: '하나' }), 'not-found');
});

test('3) 중복 제출·반복 마감·지난 라운드 제출·동시 요청', async () => {
  const { host, p1, p2, roomId } = await setupRoom();
  await host.call('startGame', { roomId, requestId: rid() });

  // 같은 requestId 재전송 → 저장된 응답, 점수 1회 반영
  const reqId = rid();
  const first = await choose(p1, roomId, 1, 3, reqId);
  const dup = await choose(p1, roomId, 1, 3, reqId);
  assert.equal(first.ok, true);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  // 새 requestId 로 같은 라운드 재제출 → 거부
  const resubmit = await choose(p1, roomId, 1, 1);
  assert.equal(resubmit.error.code, 'already-submitted');

  // p2 가 같은 라운드에 서로 다른 requestId 로 동시에 3번 제출 → 1번만 성공
  const concurrent = await Promise.all([choose(p2, roomId, 1, 1), choose(p2, roomId, 1, 2), choose(p2, roomId, 1, 3)]);
  assert.equal(concurrent.filter((r) => r.ok).length, 1);
  assert.ok(concurrent.filter((r) => !r.ok).every((r) => r.error.code === 'already-submitted'));

  // 동시에 마감 2번 + 같은 requestId 마감 동시 재전송 → 점수 1회만 반영
  const closeId = rid();
  const closes = await Promise.all([closeRound(host, roomId, 1, closeId), closeRound(host, roomId, 1, closeId), closeRound(host, roomId, 1)]);
  const applied = closes.filter((r) => r.ok && !r.duplicate).length;
  assert.equal(applied, 1, JSON.stringify(closes));
  let room = await roomDoc(host, roomId);
  assert.equal(room.publicView.round, 2);
  const p2Choice = concurrent.findIndex((r) => r.ok) + 1;
  assert.deepEqual(room.publicView.players.map((p) => p.score), [3, p2Choice]);

  // 반복 마감 (이미 지난 라운드) → 거부
  assert.equal((await closeRound(host, roomId, 1)).error.code, 'stale-round');
  // 지난 라운드 제출 → 거부
  assert.equal((await choose(p2, roomId, 1, 3)).error.code, 'stale-round');
  room = await roomDoc(host, roomId);
  assert.deepEqual(room.publicView.players.map((p) => p.score), [3, p2Choice], '점수 변동 없음');
  // 잘못된 형식
  await expectCallError(p1.call('gameAction', { roomId, requestId: 'short', action: { type: 'choose', round: 2, value: 1 } }), 'invalid-argument');
  await expectCallError(p1.call('gameAction', { roomId, requestId: rid(), action: { type: 'choose', round: 2, value: '1' } }), 'invalid-argument');
  // 다른 사용자가 남의 requestId 재사용 → 거부
  await expectCallError(choose(p2, roomId, 2, 1, reqId), 'already-exists');
});

test('4) 진행자 전용 명령·다른 참가자 데이터 변경 거부', async () => {
  const { host, p1, p2, roomId, code } = await setupRoom();
  const outsider = await client('player');
  const anonHost = await client('player');
  // 익명 사용자는 방 생성 불가 (진행자 계정 필요)
  await expectCallError(anonHost.call('createRoom', { gameId: GAME }), 'permission-denied');
  // 참가자는 게임 시작 불가
  await expectCallError(p1.call('startGame', { roomId, requestId: rid() }), 'permission-denied');
  // 다른 진행자 계정도 남의 방 시작 불가
  const otherHost = await client('host');
  await expectCallError(otherHost.call('startGame', { roomId, requestId: rid() }), 'permission-denied');
  await host.call('startGame', { roomId, requestId: rid() });
  // 참가자는 라운드 마감 불가
  const res = await closeRound(p1, roomId, 1);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not-host');
  // 진행자는 대신 제출 불가
  assert.equal((await choose(host, roomId, 1, 3)).error.code, 'not-player');
  // 외부인·다른 진행자는 행동 불가
  await expectCallError(choose(outsider, roomId, 1, 3), 'permission-denied');
  await expectCallError(closeRound(otherHost, roomId, 1), 'permission-denied');

  // Firestore 직접 쓰기 거부 (방 상태·다른 사람 정보·점수)
  await expectDenied(updateDoc(doc(p1.db, 'rooms', roomId), { status: 'finished' }));
  await expectDenied(updateDoc(doc(p1.db, 'rooms', roomId), { 'publicView.players': [] }));
  await expectDenied(setDoc(doc(p1.db, 'rooms', roomId, 'players', p2.uid), { nickname: '바꿈', playerId: 'p2' }));
  await expectDenied(updateDoc(doc(p1.db, 'rooms', roomId, 'players', p1.uid), { playerId: 'p2' }));
  await expectDenied(setDoc(doc(p1.db, 'rooms', roomId, 'private', p1.uid), { view: {} }));
  await expectDenied(setDoc(doc(p1.db, 'rooms', roomId, 'server', 'state'), { gameState: null }));
  await expectDenied(deleteDoc(doc(p1.db, 'rooms', roomId)));
  await expectDenied(setDoc(doc(host.db, 'rooms', roomId), { status: 'lobby' }, { merge: true }));
  await expectDenied(setDoc(doc(outsider.db, 'codes', code), { roomId: 'x' }));
  await expectDenied(setDoc(doc(outsider.db, 'rooms', 'fakeRoom123456'), { hostUid: outsider.uid }));
  const room = await roomDoc(p2, roomId);
  assert.equal(room.status, 'playing');
});

test('5) 비공개·서버 전용 문서 읽기 거부', async () => {
  const { host, p1, p2, roomId, code } = await setupRoom();
  await host.call('startGame', { roomId, requestId: rid() });
  const signedOut = await client('signed-out');
  // 본인 개인 문서는 읽기 가능
  assert.equal((await getDoc(doc(p1.db, 'rooms', roomId, 'private', p1.uid))).exists(), true);
  // 다른 참가자·진행자 개인 문서 거부
  await expectDenied(getDoc(doc(p1.db, 'rooms', roomId, 'private', p2.uid)));
  await expectDenied(getDoc(doc(p1.db, 'rooms', roomId, 'private', host.uid)));
  await expectDenied(getDocs(collection(p1.db, 'rooms', roomId, 'private')));
  // 서버 전용 상태·요청 기록·코드 매핑 거부 (진행자 포함)
  await expectDenied(getDoc(doc(host.db, 'rooms', roomId, 'server', 'state')));
  await expectDenied(getDoc(doc(p1.db, 'rooms', roomId, 'server', 'state')));
  await expectDenied(getDocs(collection(p1.db, 'rooms', roomId, 'requests')));
  await expectDenied(getDoc(doc(p1.db, 'codes', code)));
  await expectDenied(getDocs(collection(p1.db, 'codes')));
  // 비로그인 사용자는 공개 문서도 거부
  await expectDenied(getDoc(doc(signedOut.db, 'rooms', roomId)));
  // 공개 문서에 서버 전체 상태(gameState·seats)가 없음
  const pub = await roomDoc(p1, roomId);
  assert.equal('gameState' in pub, false);
  assert.equal('seats' in pub, false);
});

test('6) 동일 초기 상태·행동 순서에서 온라인 판정 = 로컬 판정', async () => {
  for (const seq of SEQUENCES) {
    const { host, p1, p2, roomId } = await setupRoom(seq.names);
    await host.call('startGame', { roomId, requestId: rid() });
    for (const [index, [a, b]] of seq.rounds.entries()) {
      const round = index + 1;
      if (a !== null) assert.equal((await choose(p1, roomId, round, a)).ok, true);
      if (b !== null) assert.equal((await choose(p2, roomId, round, b)).ok, true);
      assert.equal((await closeRound(host, roomId, round)).ok, true);
    }
    const online = (await roomDoc(host, roomId)).result;
    const local = runLocal(rules, seq);
    assert.deepEqual(online, local, seq.name);
  }
});
