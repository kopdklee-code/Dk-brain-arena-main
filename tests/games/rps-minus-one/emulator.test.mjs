// 가위바위보 하나빼기 — 29명 통합 테스트 (Auth·Firestore·Functions 에뮬레이터, emulators:exec 안에서 실행).
// 참가자 29명은 각각 독립 익명 세션. 같은 PC 에뮬레이터 자원 한계로 서버 동시 처리는 10개로 제한하고 요청은 동시에 발생시킨다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { doc, getDoc, setDoc, onSnapshot, collection, getDocs } from 'firebase/firestore';
import { client, closeAll, rid, readAsOwner, listAsOwner, sleep, percentile, warmUpFunctions, limitCalls } from '../../helpers/emulator-clients.mjs';
import * as rules from '../../../src/games/rps-minus-one/rules.js';

const GAME = 'rps-minus-one';
const N = 29;
const EMULATOR_CONCURRENCY = Number(process.env.DKBA_EMULATOR_CONCURRENCY || 10);
const { ROCK: R, SCISSORS: S, PAPER: P } = rules;
const BEATEN_BY = { [R]: P, [S]: R, [P]: S }; // 진행자 손 → 그 손을 이기는 손
const metrics = {
  participants: 0, joinOk: 0, joinFail: 0, joinRejected30th: false, submitOk: 0, submitRejected: 0, serverErrors: 0,
  duplicateRequestsReplayed: 0, dataMismatches: 0, lateAccepted: 0, privacyLeaks: 0, permissionBypass: 0, doubleApplied: 0,
  rounds: 0, cancelledRounds: 0, completedGame: false, submitRttMs: [], phaseSyncMs: [],
};
let host; let players = []; let roomId; let code;

async function gameAction(c, rId, action, requestId = rid()) {
  try {
    return await c.call('gameAction', { roomId: rId, requestId, action });
  } catch (err) {
    if (!['functions/permission-denied', 'functions/invalid-argument'].includes(err.code)) metrics.serverErrors += 1;
    throw err;
  }
}
const roomData = async (rId = roomId) => (await getDoc(doc(host.db, 'rooms', rId))).data();
const pubView = async (rId = roomId) => (await roomData(rId)).publicView;
const serverState = async (rId = roomId) => (await readAsOwner(`rooms/${rId}/server/state`)).gameState;
async function currentInputs(rId = roomId) {
  const pv = await pubView(rId);
  const all = await listAsOwner(`rooms/${rId}/server/state/inputs`);
  return Object.fromEntries(Object.entries(all).map(([pid, d]) => [pid, d.input]).filter(([, i]) => i.round === pv.round && i.attempt === pv.attempt));
}
const liveCount = async (rId = roomId) => { const r = await roomData(rId); return r.inputCounts?.[r.publicView.inputKey] || 0; };
const hostDo = (type, extra = {}, rId = roomId) => pubView(rId).then((pv) => gameAction(host, rId, { type, round: pv.round, attempt: pv.attempt, ...extra }));
async function act(c, rId, type, value) {
  const pv = await pubView(rId);
  const t0 = Date.now();
  const res = await gameAction(c, rId, { type, round: pv.round, attempt: pv.attempt, value });
  metrics.submitRttMs.push(Date.now() - t0);
  if (res.ok) metrics.submitOk += 1; else metrics.submitRejected += 1;
  return res;
}
async function closeWhenDue(stage, rId = roomId) {
  const pv = await pubView(rId);
  await sleep(Math.max(0, pv.deadlineAt - Date.now() + 50));
  const res = await hostDo('close-round', { value: stage }, rId);
  assert.ok(res.ok, JSON.stringify(res));
}
function assertNoLeak(pv, label) {
  const text = JSON.stringify({ ...pv, results: [], standings: [] });
  const bad = /picks|"two"|"one"|hostOne/.test(text) || (pv.phase === 'PICK_TWO' && pv.hostTwo);
  if (bad) { metrics.privacyLeaks += 1; assert.fail(`${label}: 공개 문서에 비공개 손 노출 ${text}`); }
}
const pair = (a, b) => rules.encodePair([a, b]);
const alivePlayers = async (rId = roomId) => { const st = await serverState(rId); return players.filter((p) => st.alive.includes(p.pid[rId])); };

/** 라운드 진행: hostTwo·hostOne, choose(p,i) → [a,b,keep] | [a,b] | null (살아 있는 참가자 각각) */
async function playRound(hostTwo, hostOne, choose, { reveal = true, rId = roomId } = {}) {
  const before = await alivePlayers(rId);
  const picks = before.map((p, i) => choose(p, i));
  assert.ok((await hostDo('host-two', { value: pair(...hostTwo) }, rId)).ok);
  const r1 = await Promise.all(before.map((p, i) => (picks[i] ? act(p, rId, 'pick-two', pair(picks[i][0], picks[i][1])) : null)));
  assert.ok(r1.filter(Boolean).every((r) => r.ok), JSON.stringify(r1.filter((r) => r && !r.ok)));
  await closeWhenDue(2, rId);
  assert.ok((await hostDo('host-one', { value: hostOne }, rId)).ok);
  const r2 = await Promise.all(before.map((p, i) => (picks[i]?.[2] ? act(p, rId, 'keep-one', picks[i][2]) : null)));
  assert.ok(r2.filter(Boolean).every((r) => r.ok), JSON.stringify(r2.filter((r) => r && !r.ok)));
  await closeWhenDue(1, rId);
  // 판정 = 서버 입력으로 한 로컬 판정
  const st = await serverState(rId);
  const inputs = await currentInputs(rId);
  const local = rules.judgeRound(st.alive, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { two: v.two, one: v.one }])), hostOne);
  if (JSON.stringify(local.survivors) !== JSON.stringify(st.pending.survivors)) metrics.dataMismatches += 1;
  assert.deepEqual(st.pending.survivors, local.survivors);
  if (reveal) {
    assert.ok((await hostDo('reveal', {}, rId)).ok);
    metrics.rounds += 1;
    if (st.pending.cancelled) metrics.cancelledRounds += 1;
  }
  return st.pending;
}

test.after(async () => {
  await closeAll();
  const s = (a) => ({ count: a.length, p50: percentile(a, 50), p95: percentile(a, 95), max: a.length ? Math.max(...a) : null });
  const out = { ...metrics, submitRttMs: undefined, phaseSyncMs: undefined, submitRtt: s(metrics.submitRttMs), phaseSync: s(metrics.phaseSyncMs), environment: 'Firebase 로컬 에뮬레이터 (같은 PC, 네트워크 지연 없음, 동시 처리 10) — 운영 환경 측정값 아님' };
  await mkdir(path.resolve('tests/.artifacts'), { recursive: true });
  await writeFile(path.resolve('tests/.artifacts/rps-metrics.json'), JSON.stringify(out, null, 2));
  console.log('[rps] 측정값', JSON.stringify(out));
});

test('A) 29명 입장 (QR 현장 속도·중첩), 30번째 신규 거부, 재입장은 인원 증가 없음', async () => {
  host = await client('host');
  ({ roomId, code } = await host.call('createRoom', { gameId: GAME, config: { twoSeconds: 20, oneSeconds: 15 } }));
  players = await Promise.all(Array.from({ length: N + 1 }, () => client('player')));
  const extra = players.pop();
  metrics.emulatorWarmUpMs = await warmUpFunctions(players, [['joinRoom', { code: '!', nickname: 'x' }], ['gameAction', { roomId: '!', requestId: 'x', action: { type: 'x' } }]], [3, 6, EMULATOR_CONCURRENCY]);
  limitCalls([host, ...players, extra], EMULATOR_CONCURRENCY);
  const joins = await Promise.allSettled(players.map(async (p, i) => { await sleep(i * 400); return p.call('joinRoom', { code, nickname: `참가자${String(i + 1).padStart(2, '0')}` }); }));
  metrics.joinOk = joins.filter((j) => j.status === 'fulfilled').length;
  metrics.joinFail = joins.length - metrics.joinOk;
  assert.equal(metrics.joinOk, N);
  players.forEach((p, i) => { p.pid = { [roomId]: joins[i].value.playerId }; });
  assert.equal(new Set(players.map((p) => p.pid[roomId])).size, N);
  await assert.rejects(extra.call('joinRoom', { code, nickname: '서른번째' }), (e) => e.code === 'functions/failed-precondition');
  metrics.joinRejected30th = true;
  assert.equal((await players[0].call('joinRoom', { code, nickname: '다른이름' })).rejoined, true);
  assert.equal((await getDocs(collection(host.db, 'rooms', roomId, 'players'))).size, N);
  metrics.participants = N;
});

test('B·C) 1라운드: 29명 동시 두 손 → 변경 → 마감 경계 → 진행자 두 손 공개 → 29명 동시 하나 빼기 → 판정 일치', async () => {
  assert.ok((await host.call('startGame', { roomId, requestId: rid() })).ok);
  const seen = new Map();
  const unsubs = players.map((p) => onSnapshot(doc(p.db, 'rooms', roomId), (s) => { if (s.data()?.publicView?.phase === 'PICK_TWO' && !seen.has(p.uid)) seen.set(p.uid, Date.now()); }));
  await sleep(1000);
  const t0 = Date.now();
  assert.ok((await hostDo('start-round')).ok);
  assert.ok((await hostDo('host-two', { value: pair(R, P) })).ok);
  let pv = await pubView();
  assertNoLeak(pv, '① 시작');
  assert.equal(pv.hostTwo, null, '① 동안 진행자 두 손 비공개');
  // 29명 동시 두 손
  const twos = players.map((_, i) => [[R, S], [R, P], [S, P]][i % 3]);
  const first = await Promise.all(players.map((p, i) => act(p, roomId, 'pick-two', pair(...twos[i]))));
  assert.ok(first.every((r) => r.ok), JSON.stringify(first.filter((r) => !r.ok)));
  await sleep(300);
  assert.equal(await liveCount(), N, '제출 인원 29');
  // 10명 동시 변경, 3명 같은 두 손 재제출
  const changed = await Promise.all(players.slice(0, 10).map((p, i) => { twos[i] = [R, P]; return act(p, roomId, 'pick-two', pair(R, P)); }));
  assert.ok(changed.every((r) => r.ok));
  assert.ok((await Promise.all(players.slice(20, 23).map((p, i) => act(p, roomId, 'pick-two', pair(...twos[20 + i]))))).every((r) => r.ok));
  let inputs = await currentInputs();
  players.forEach((p, i) => { if (JSON.stringify(inputs[p.pid[roomId]]?.two) !== JSON.stringify([...twos[i]].sort())) metrics.dataMismatches += 1; });
  assert.equal(metrics.dataMismatches, 0, '서버 두 손 = 참가자별 마지막 값');
  assert.equal(await liveCount(), N, '변경은 인원을 늘리지 않음');
  for (const t of seen.values()) metrics.phaseSyncMs.push(t - t0);
  // 보안: 다른 참가자 개인 문서·서버 문서 읽기 거부, 진행자 문서에 참가자 손 없음
  await assert.rejects(getDoc(doc(players[0].db, 'rooms', roomId, 'private', players[1].uid)), (e) => e.code === 'permission-denied');
  await assert.rejects(getDoc(doc(players[0].db, 'rooms', roomId, 'server', 'state')), (e) => e.code === 'permission-denied');
  await assert.rejects(getDocs(collection(players[0].db, 'rooms', roomId, 'server', 'state', 'inputs')), (e) => e.code === 'permission-denied');
  const hostPriv = JSON.stringify((await getDoc(doc(host.db, 'rooms', roomId, 'private', host.uid))).data());
  assert.ok(!/"two"|"one"|picks/.test(hostPriv), `진행자 문서에 참가자 손 노출: ${hostPriv}`);
  // 마감 경계 (①): 마감 전후 버스트
  pv = await pubView();
  assert.equal((await gameAction(host, roomId, { type: 'close-round', round: 1, attempt: 1, value: 2 })).error.code, 'too-early');
  await sleep(Math.max(0, pv.deadlineAt - Date.now() - 400));
  const burst = players.slice(23, 29);
  const offsets = [-250, -120, -40, 0, 40, 150];
  const res = await Promise.all(burst.map(async (p, i) => {
    await sleep(Math.max(0, pv.deadlineAt + offsets[i] - Date.now()));
    const r = await act(p, roomId, 'pick-two', pair(R, S));
    if (r.ok) twos[23 + i] = [R, S]; else assert.equal(r.error.code, 'deadline-passed', JSON.stringify(r));
    return r;
  }));
  console.log('[rps] 마감 경계', res.map((r, i) => `${offsets[i]}ms:${r.ok ? '수락' : r.error.code}`).join(', '));
  inputs = await currentInputs();
  const st0 = await serverState();
  for (const p of burst) if (inputs[p.pid[roomId]].at >= st0.deadlineAt) metrics.lateAccepted += 1;
  assert.equal(metrics.lateAccepted, 0);
  // ① 마감 (진행자 + 참가자 5명 동시 → 한 번만)
  const closes = await Promise.all([host, ...players.slice(0, 5)].map((c) => gameAction(c, roomId, { type: 'close-round', round: 1, attempt: 1, value: 2 })));
  assert.equal(closes.filter((r) => r.ok).length, 1, JSON.stringify(closes));
  pv = await pubView();
  assert.equal(pv.phase, 'PICK_ONE'); assert.deepEqual(pv.hostTwo, [R, P], '② 진행자 두 손 공개');
  assertNoLeak(pv, '②');
  assert.equal((await act(players[0], roomId, 'pick-two', pair(S, P))).error.code, 'step-closed', '② 에서 두 손 변경 불가');
  // ② 진행자는 바위(R)를 남김 → 보(P)를 남긴 사람만 생존. 29명 동시 하나 빼기
  assert.ok((await hostDo('host-one', { value: R })).ok);
  const keeps = players.map((_, i) => (twos[i].includes(P) && i % 2 === 0 ? P : twos[i][0]));
  const r2 = await Promise.all(players.map((p, i) => act(p, roomId, 'keep-one', keeps[i])));
  assert.ok(r2.every((r) => r.ok), JSON.stringify(r2.filter((r) => !r.ok)));
  assert.equal((await act(players[0], roomId, 'keep-one', S)).error.code, keeps[0] === S ? undefined : 'invalid-keep');
  await closeWhenDue(1);
  const st = await serverState();
  const local = rules.judgeRound(st.alive, Object.fromEntries(Object.entries(await currentInputs()).map(([k, v]) => [k, { two: v.two, one: v.one }])), R);
  assert.deepEqual(st.pending.survivors, local.survivors, '판정 = 서버 입력 기준 로컬 판정');
  const expectSurvivors = players.filter((p, i) => keeps[i] === P).map((p) => p.pid[roomId]);
  assert.deepEqual([...st.pending.survivors].sort(), [...expectSurvivors].sort());
  assertNoLeak(await pubView(), '마감 후 공개 전');
  // 결과 공개: 같은 요청 ID 재전송·두 번 클릭
  const reqId = rid();
  const a = await gameAction(host, roomId, { type: 'reveal', round: 1, attempt: 1 }, reqId);
  const b = await gameAction(host, roomId, { type: 'reveal', round: 1, attempt: 1 }, reqId);
  assert.ok(a.ok); assert.equal(b.duplicate, true); metrics.duplicateRequestsReplayed += 1;
  assert.equal((await gameAction(host, roomId, { type: 'reveal', round: 1, attempt: 1 })).ok, false);
  const after = await serverState();
  if (after.results.length !== 1) metrics.doubleApplied += 1;
  assert.deepEqual([...after.alive].sort(), [...expectSurvivors].sort());
  metrics.rounds += 1;
  unsubs.forEach((u) => u());
});

test('보안: 탈락자·비참가자·비로그인 거부, 참가자의 진행자 명령 거부, 잘못된 값, 직접 쓰기 거부', async () => {
  const st = await serverState();
  const out = players.find((p) => !st.alive.includes(p.pid[roomId]));
  const alive = players.find((p) => st.alive.includes(p.pid[roomId]));
  assert.ok((await hostDo('start-round', { round: 2 })).ok);
  assert.equal((await act(out, roomId, 'pick-two', pair(R, S))).error.code, 'eliminated', '탈락자 제출 불가');
  const outsider = await client('player');
  await assert.rejects(outsider.call('gameAction', { roomId, requestId: rid(), action: { type: 'pick-two', round: 2, attempt: 1, value: 12 } }), (e) => e.code === 'functions/permission-denied');
  for (const type of ['host-two', 'host-one', 'pause', 'reveal', 'void-round', 'end-game', 'finish-game', 'start-round']) {
    const r = await gameAction(alive, roomId, { type, round: 2, attempt: 1, value: 12 });
    if (r.ok) metrics.permissionBypass += 1;
    assert.equal(r.error.code, 'not-host', type);
  }
  for (const value of [11, 0, 44, 1.5]) assert.equal((await act(alive, roomId, 'pick-two', value)).error.code, 'invalid-hands', String(value));
  await assert.rejects(alive.call('gameAction', { roomId, requestId: rid(), action: { type: 'pick-two', round: 2, attempt: 1, value: '12' } }), (e) => e.code === 'functions/invalid-argument');
  await assert.rejects(setDoc(doc(alive.db, 'rooms', roomId), { status: 'finished' }), (e) => e.code === 'permission-denied');
  await assert.rejects(setDoc(doc(alive.db, 'rooms', roomId, 'server', 'state', 'inputs', alive.pid[roomId]), { input: {} }), (e) => e.code === 'permission-denied');
  const signedOut = await client('signed-out');
  await assert.rejects(signedOut.call('gameAction', { roomId, requestId: rid(), action: { type: 'pick-two', round: 2, attempt: 1, value: 12 } }), (e) => e.code === 'functions/unauthenticated');
});

test('최후의 1인까지: 전원 탈락 라운드 취소 포함, 순위 = 로컬 재집계', async () => {
  // 2라운드(시작됨): 진행자 [가위,보] → 가위. 모두 보를 남김 → 전원 짐 → 무효(전원 생존)
  let pend = await playRound([S, P], S, () => [R, P, P]);
  assert.equal(pend.cancelled, true);
  // 이후 라운드: 진행자 바위를 남기고, 살아 있는 사람의 약 절반만 보를 남겨 생존
  let guard = 0;
  for (;;) {
    const alive = await alivePlayers();
    if (alive.length <= 1) break;
    assert.ok((await hostDo('start-round', { round: (await pubView()).round + 1 })).ok);
    const keepCount = Math.max(1, Math.floor(alive.length / 2));
    pend = await playRound([R, P], R, (p, i) => (i < keepCount ? [R, P, P] : i === keepCount ? [R, S] : [S, P, S])); // 한 명은 하나를 안 남김(미제출 탈락)
    assert.equal(pend.survivors.length, keepCount);
    if (++guard > 10) assert.fail('라운드가 끝나지 않음');
  }
  assert.ok((await hostDo('finish-game')).ok);
  const room = await roomData();
  assert.equal(room.status, 'finished');
  const st = await serverState();
  assert.equal(st.alive.length, 1);
  assert.equal(room.result.winner.playerId, st.alive[0]);
  assert.deepEqual(room.result.ranking.map((r) => [r.playerId, r.rank]), rules.standings(st).map((r) => [r.playerId, r.rank]));
  assert.equal((await hostDo('start-round', { round: 99 })).ok, false);
  metrics.completedGame = true;
});

test('일시정지·재개 (남은 시간 보존, 제출 차단) + 마감 후 무효화·재진행 (이전 손·탈락 미반영) + 비상 중단', async () => {
  const { roomId: id, code: c2 } = await host.call('createRoom', { gameId: GAME, config: { twoSeconds: 8, oneSeconds: 6 } });
  const joins = await Promise.all(players.slice(0, 10).map((p, i) => p.call('joinRoom', { code: c2, nickname: `두번째${i + 1}` })));
  players.slice(0, 10).forEach((p, i) => { p.pid[id] = joins[i].playerId; });
  assert.ok((await host.call('startGame', { roomId: id, requestId: rid() })).ok);
  assert.ok((await hostDo('start-round', {}, id)).ok);
  assert.ok((await act(players[0], id, 'pick-two', pair(R, S))).ok);
  await sleep(1500);
  assert.ok((await hostDo('pause', {}, id)).ok);
  let pv = await pubView(id);
  const kept = pv.pausedRemainingMs;
  assert.ok(pv.paused && kept > 5000 && kept < 7000, `남은 시간 ${kept}`);
  assert.equal((await act(players[1], id, 'pick-two', pair(R, S))).error.code, 'paused');
  assert.equal((await gameAction(host, id, { type: 'close-round', round: 1, attempt: 1, value: 2 })).error.code, 'paused');
  await sleep(2000);
  const tr = Date.now();
  assert.ok((await hostDo('resume', {}, id)).ok);
  pv = await pubView(id);
  assert.ok(Math.abs(pv.deadlineAt - (tr + kept)) < 1000);
  // 1차 시도: 모두 짐이 되도록 → 공개 전 무효화
  await playRound([R, S], R, (p) => [R, S, S], { reveal: false, rId: id });
  assert.ok((await hostDo('void-round', {}, id)).ok);
  pv = await pubView(id);
  assert.equal(pv.phase, 'LOBBY'); assert.equal(pv.attempt, 2); assert.equal(pv.aliveCount, 10);
  assert.equal((await gameAction(players[0], id, { type: 'keep-one', round: 1, attempt: 1, value: R })).ok, false);
  assert.ok((await hostDo('start-round', {}, id)).ok);
  const mine = (await getDoc(doc(players[0].db, 'rooms', id, 'private', players[0].uid))).data().view;
  assert.equal(mine.current, null, '이전 시도 손 재사용 안 함');
  const pend = await playRound([R, P], P, (p, i) => (i < 3 ? [S, P, S] : [R, P, R]), { rId: id });
  assert.equal(pend.survivors.length, 3);
  const hostPriv = (await getDoc(doc(host.db, 'rooms', id, 'private', host.uid))).data().view;
  assert.deepEqual(hostPriv.audit.map((a) => a.type), ['pause', 'resume', 'void']);
  assert.equal((await hostDo('void-round', {}, id)).ok, false, '공개 후 무효화 불가');
  assert.ok((await hostDo('end-game', {}, id)).ok);
  const fin = await roomData(id);
  assert.equal(fin.result.aborted, true); assert.equal(fin.result.roundsPlayed, 1);
});

test('측정값 요약: 판정 불일치·마감 후 수락·유출·우회·중복 반영 0건', () => {
  for (const k of ['dataMismatches', 'lateAccepted', 'privacyLeaks', 'permissionBypass', 'doubleApplied', 'serverErrors']) assert.equal(metrics[k], 0, k);
});
