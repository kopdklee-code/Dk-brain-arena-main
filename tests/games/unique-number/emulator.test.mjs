// 단 하나의 숫자 — 29명 동시 접속 통합 테스트 (Auth·Firestore·Functions 에뮬레이터, firebase emulators:exec 안에서 실행).
// 지시문 v1.1 §10.1 시나리오 A~I 와 보안 항목을 실제 서버 함수·보안 규칙으로 검증하고 측정값을 기록한다.
// 참가자 29명은 각각 독립 익명 인증 세션(별도 Firebase 앱 인스턴스)이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { doc, getDoc, setDoc, onSnapshot, collection, getDocs } from 'firebase/firestore';
import { client, closeAll, rid, readAsOwner, listAsOwner, sleep, percentile, warmUpFunctions, limitCalls } from '../../helpers/emulator-clients.mjs';
import * as rules from '../../../src/games/unique-number/rules.js';

const GAME = 'unique-number';
const N = 29;
// 같은 PC 에뮬레이터의 동시 처리 상한 (함수별 작업 프로세스 수). 29개 요청은 동시에 발생시키고 서버 쪽 동시 처리만 제한한다.
const EMULATOR_CONCURRENCY = Number(process.env.DKBA_EMULATOR_CONCURRENCY || 10);
const metrics = {
  participants: 0, joinOk: 0, joinFail: 0, joinRejected30th: false,
  submitOk: 0, submitRejected: 0, serverErrors: 0, duplicateRequestsReplayed: 0,
  dataMismatches: 0, lateAccepted: 0, privacyLeaks: 0, permissionBypass: 0, doubleScoring: 0,
  submitRttMs: [], startRoundSyncMs: [], submittedCountSyncMs: [], completedGame: false,
};

let host; let players = []; let roomId; let code;
let room2;

async function gameAction(c, rId, action, requestId = rid()) {
  try {
    return await c.call('gameAction', { roomId: rId, requestId, action });
  } catch (err) {
    if (!['functions/permission-denied', 'functions/invalid-argument'].includes(err.code)) metrics.serverErrors += 1;
    throw err;
  }
}
async function publicView(rId = roomId) { return (await getDoc(doc(host.db, 'rooms', rId))).data().publicView; }
async function serverState(rId = roomId) { return (await readAsOwner(`rooms/${rId}/server/state`)).gameState; }
/** 서버 전용 참가자 입력 (현재 시도 것만) → { playerId: input } */
async function currentInputs(rId = roomId) {
  const pv = await publicView(rId);
  const all = await listAsOwner(`rooms/${rId}/server/state/inputs`);
  return Object.fromEntries(Object.entries(all).map(([pid, d]) => [pid, d.input]).filter(([, i]) => i.round === pv.round && i.attempt === pv.attempt));
}
/** 화면 표시용 제출 인원 (진행 중) */
async function liveCount(rId = roomId) {
  const r = (await getDoc(doc(host.db, 'rooms', rId))).data();
  return r.inputCounts?.[r.publicView.inputKey] || 0;
}
const hostDo = (type, extra = {}, rId = roomId) => publicView(rId).then((pv) => gameAction(host, rId, { type, round: pv.round, attempt: pv.attempt, ...extra }));

async function submit(c, rId, pv, value, requestId) {
  const t0 = Date.now();
  const res = await gameAction(c, rId, { type: 'submit', round: pv.round, attempt: pv.attempt, value }, requestId);
  metrics.submitRttMs.push(Date.now() - t0);
  if (res.ok) metrics.submitOk += 1; else metrics.submitRejected += 1;
  return res;
}

async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`);
    await sleep(100);
  }
}

/** 마감 시각이 지날 때까지 기다린 뒤 진행자가 마감 확정 */
async function closeWhenDue(rId = roomId) {
  const pv = await publicView(rId);
  await sleep(Math.max(0, pv.deadlineAt - Date.now() + 50));
  const res = await hostDo('close-round', {}, rId);
  assert.ok(res.ok, JSON.stringify(res));
}

function assertNoLeak(pv, label) {
  if (pv.phase === 'ROUND_ACTIVE' || pv.phase === 'ROUND_CLOSED') {
    const current = JSON.stringify({ ...pv, results: [] });
    if (/distribution|picks|submissions|"number"/.test(current)) { metrics.privacyLeaks += 1; assert.fail(`${label}: 공개 문서에 진행 중 선택 정보 노출`); }
  }
}

test.after(async () => {
  await closeAll();
  const out = {
    ...metrics,
    submitRttMs: undefined, startRoundSyncMs: undefined, submittedCountSyncMs: undefined,
    submitRtt: { count: metrics.submitRttMs.length, p50: percentile(metrics.submitRttMs, 50), p95: percentile(metrics.submitRttMs, 95), max: Math.max(...metrics.submitRttMs) },
    startRoundSync: { count: metrics.startRoundSyncMs.length, p50: percentile(metrics.startRoundSyncMs, 50), p95: percentile(metrics.startRoundSyncMs, 95), max: Math.max(...metrics.startRoundSyncMs) },
    submittedCountSync: { count: metrics.submittedCountSyncMs.length, p95: percentile(metrics.submittedCountSyncMs, 95) },
    environment: 'Firebase 로컬 에뮬레이터 (같은 PC, 네트워크 지연 없음) — 운영 환경 측정값 아님',
  };
  await mkdir(path.resolve('tests/.artifacts'), { recursive: true });
  await writeFile(path.resolve('tests/.artifacts/unique-number-metrics.json'), JSON.stringify(out, null, 2));
  console.log('[unique-number] 측정값', JSON.stringify(out));
});

// 입장은 QR 현장 속도(약 12초에 29명, 요청 중첩)로, 숫자 제출은 29명이 같은 순간에 보낸다.
// (29명 동시 입장 폭주는 이 PC 에뮬레이터에서 트랜잭션 대기 때문에 측정하지 못함 — docs/VERIFICATION.md 기록)
test('A) 29명 입장: 독립 세션 29개 입장 성공(12초 분산·중첩), 30번째 신규 거부, 재입장은 인원 증가 없음', async () => {
  host = await client('host');
  ({ roomId, code } = await host.call('createRoom', { gameId: GAME, config: { roundSeconds: 25 } }));
  players = await Promise.all(Array.from({ length: N + 1 }, () => client('player')));
  const extra = players.pop();
  const waves = [3, 6, EMULATOR_CONCURRENCY];
  metrics.emulatorWarmUpMs = await warmUpFunctions(players, [
    ['joinRoom', { code: '!', nickname: 'x' }], ['gameAction', { roomId: '!', requestId: 'x', action: { type: 'x' } }],
  ], waves);
  limitCalls([host, ...players, extra], EMULATOR_CONCURRENCY);
  metrics.emulatorConcurrency = EMULATOR_CONCURRENCY;
  const tJoin = Date.now();
  const joinMs = [];
  const joins = await Promise.allSettled(players.map(async (p, i) => {
    await sleep(i * 400);
    const t0 = Date.now();
    const r = await p.call('joinRoom', { code, nickname: `참가자${String(i + 1).padStart(2, '0')}` });
    joinMs.push(Date.now() - t0);
    return r;
  }));
  metrics.joinAllMs = Date.now() - tJoin;
  metrics.joinRtt = { p50: percentile(joinMs, 50), p95: percentile(joinMs, 95), max: Math.max(...joinMs) };
  metrics.joinOk = joins.filter((j) => j.status === 'fulfilled').length;
  metrics.joinFail = joins.length - metrics.joinOk;
  assert.equal(metrics.joinOk, N, joins.filter((j) => j.status === 'rejected').map((j) => j.reason.message).join(' / '));
  players.forEach((p, i) => { p.playerId = joins[i].value.playerId; p.nickname = joins[i].value.nickname; });
  assert.equal(new Set(players.map((p) => p.playerId)).size, N, '자리 번호 중복 없음');
  assert.equal(new Set(players.map((p) => p.uid)).size, N, '서로 다른 인증 UID');
  await assert.rejects(extra.call('joinRoom', { code, nickname: '서른번째' }), (e) => e.code === 'functions/failed-precondition');
  metrics.joinRejected30th = true;
  const again = await players[0].call('joinRoom', { code, nickname: '다른이름' });
  assert.equal(again.rejoined, true); assert.equal(again.playerId, players[0].playerId);
  const r = (await getDoc(doc(host.db, 'rooms', roomId))).data();
  assert.equal(r.playerCount, N);
  assert.equal((await getDocs(collection(host.db, 'rooms', roomId, 'players'))).size, N, '진행자 목록 인원 29');
  metrics.participants = N;
});

test('B·C·D·E) 1라운드: 29명 동시 제출 → 동시 수정 → 마감 경계 → 재접속, 최종값만 집계', async () => {
  const start = await host.call('startGame', { roomId, requestId: rid() });
  assert.ok(start.ok, JSON.stringify(start));
  // 참가자 화면 동기화 지연 측정: 각 참가자가 구독 중인 방 문서에서 라운드 시작(ROUND_ACTIVE)을 받기까지
  const seen = new Map();
  const unsubs = players.map((p) => onSnapshot(doc(p.db, 'rooms', roomId), (s) => {
    if (s.data()?.publicView?.phase === 'ROUND_ACTIVE' && !seen.has(p.uid)) seen.set(p.uid, Date.now());
  }));
  await sleep(1000);
  const tStart = Date.now();
  const sr = await hostDo('start-round');
  assert.ok(sr.ok, JSON.stringify(sr));
  const tAck = Date.now();
  metrics.startRoundCallMs = tAck - tStart;
  let pv = await publicView();
  assert.equal(pv.phase, 'ROUND_ACTIVE'); assertNoLeak(pv, '시작 직후');
  // 진행자 화면 제출 인원 동기화 측정
  let hostSawAllAt = null;
  const hostUnsub = onSnapshot(doc(host.db, 'rooms', roomId), (s) => { const d = s.data(); if (d?.inputCounts?.[d.publicView?.inputKey] === N && !hostSawAllAt) hostSawAllAt = Date.now(); });

  // B: 29명 동시 제출
  const plan1 = players.map((_, i) => (i % 10) + 1); // 1~10 각각 2~3명 → 첫 제출 시점에는 모두 중복
  const tSubmit = Date.now();
  const first = await Promise.all(players.map((p, i) => submit(p, roomId, pv, plan1[i])));
  const tLastSubmit = Date.now();
  assert.ok(first.every((r) => r.ok), JSON.stringify(first.filter((r) => !r.ok)));
  await waitFor(async () => (await liveCount()) === N, '제출 인원 29');
  await waitFor(() => hostSawAllAt, '진행자 화면 29명 표시');
  metrics.submittedCountSyncMs.push(hostSawAllAt - tSubmit); // 29명 동시 제출 시작 → 진행자 화면 29명 표시
  metrics.submitBurstAllAckMs = tLastSubmit - tSubmit; // 29명 동시 제출 → 모든 성공 응답
  // 시작 동기화: 모든 참가자 개인 문서가 1라운드로 갱신
  await waitFor(() => seen.size === N, '29명 개인 화면 갱신');
  for (const t of seen.values()) metrics.startRoundSyncMs.push(t - tStart); // 진행자 시작 요청 → 참가자 화면 반영

  // C: 15명이 동시에 숫자 변경, 3명은 같은 숫자 재제출
  const expected = new Map(players.map((p, i) => [p.playerId, plan1[i]]));
  const changers = players.slice(0, 15);
  const changed = await Promise.all(changers.map((p, i) => { const v = 11 + (i % 10); /* 11~20 */ expected.set(p.playerId, v); return submit(p, roomId, pv, v); }));
  assert.ok(changed.every((r) => r.ok), JSON.stringify(changed.filter((r) => !r.ok)));
  const same = await Promise.all(players.slice(20, 23).map((p) => submit(p, roomId, pv, expected.get(p.playerId))));
  assert.ok(same.every((r) => r.ok), '같은 숫자 재제출은 성공(변화 없음)');
  let inputs = await currentInputs();
  for (const p of players) {
    if (inputs[p.playerId]?.number !== expected.get(p.playerId)) metrics.dataMismatches += 1;
  }
  assert.equal(metrics.dataMismatches, 0, '서버 제출값 = 참가자별 마지막 제출값');
  assert.equal(inputs[players[0].playerId].revision, 2); assert.equal(inputs[players[20].playerId].revision, 1);
  assert.equal(await liveCount(), N, '수정·재제출은 인원을 늘리지 않음');

  // 보안: 진행 중 다른 참가자 개인 문서·서버 문서 읽기 거부, 진행자 개인 문서에 숫자 없음
  await assert.rejects(getDoc(doc(players[0].db, 'rooms', roomId, 'private', players[1].uid)), (e) => e.code === 'permission-denied');
  await assert.rejects(getDoc(doc(players[0].db, 'rooms', roomId, 'server', 'state')), (e) => e.code === 'permission-denied');
  await assert.rejects(getDoc(doc(host.db, 'rooms', roomId, 'private', players[1].uid)), (e) => e.code === 'permission-denied', '진행자도 참가자 개인 문서 읽기 불가');
  const hostPriv = JSON.stringify((await getDoc(doc(host.db, 'rooms', roomId, 'private', host.uid))).data());
  assert.ok(!/"number"|submissions|distribution/.test(hostPriv), `진행자 문서에 숫자 노출: ${hostPriv}`);
  const myPriv = (await getDoc(doc(players[1].db, 'rooms', roomId, 'private', players[1].uid))).data().view;
  assert.equal(myPriv.current.number, expected.get(players[1].playerId), '본인 숫자는 본인 문서에');
  assertNoLeak(await publicView(), '진행 중');

  // E: 재접속 — 같은 세션으로 다시 입장 → 같은 자리, 기존 제출값 복구, 인원 증가 없음
  const re = await players[5].call('joinRoom', { code, nickname: players[5].nickname });
  assert.equal(re.rejoined, true); assert.equal(re.playerId, players[5].playerId);
  const restored = (await getDoc(doc(players[5].db, 'rooms', roomId, 'private', players[5].uid))).data().view;
  assert.equal(restored.current.number, expected.get(players[5].playerId));
  assert.equal((await getDoc(doc(host.db, 'rooms', roomId))).data().playerCount, N);

  // D: 마감 경계 — 마감 전 close 거부, 마감 직전·직후 제출 버스트, 마감 후 수정 거부
  pv = await publicView();
  const tooEarly = await gameAction(host, roomId, { type: 'close-round', round: 1, attempt: 1 });
  assert.equal(tooEarly.error?.code, 'too-early');
  await sleep(Math.max(0, pv.deadlineAt - Date.now() - 400));
  const burst = players.slice(23, 29);
  const offsets = [-250, -120, -40, 0, 40, 150]; // 마감 시각 기준 요청 시점(ms)
  const burstRes = await Promise.all(burst.map(async (p, i) => {
    await sleep(Math.max(0, pv.deadlineAt + offsets[i] - Date.now()));
    const value = 20 - i;
    const res = await submit(p, roomId, pv, value);
    if (res.ok) expected.set(p.playerId, value);
    else assert.equal(res.error.code, 'deadline-passed', JSON.stringify(res));
    return res;
  }));
  const after = await submit(players[0], roomId, pv, 19);
  assert.equal(after.ok, false); assert.equal(after.error.code, 'deadline-passed', '마감 이후 수정 거부');
  inputs = await currentInputs();
  const deadlineAt = (await serverState()).deadlineAt;
  for (const p of burst) {
    const sub = inputs[p.playerId];
    if (sub.number !== expected.get(p.playerId)) metrics.dataMismatches += 1;
    if (sub.at >= deadlineAt) metrics.lateAccepted += 1; // 서버 시각 기준 마감 이후 수락된 제출
  }
  assert.equal(metrics.lateAccepted, 0, '마감 시각 이후 수락된 제출 없음');
  assert.equal(metrics.dataMismatches, 0);
  console.log('[unique-number] 마감 경계 결과', burstRes.map((r, i) => `${offsets[i]}ms:${r.ok ? '수락' : r.error.code}`).join(', '));

  // 마감 확정 (진행자 + 참가자 5명 동시 요청 → 한 번만 반영)
  const closes = await Promise.all([host, ...players.slice(0, 5)].map((c) => gameAction(c, roomId, { type: 'close-round', round: 1, attempt: 1 })));
  assert.equal(closes.filter((r) => r.ok).length, 1, `마감은 한 번만 반영: ${JSON.stringify(closes)}`);
  const late = await submit(players[1], roomId, pv, 3);
  assert.equal(late.error.code, 'round-closed');
  pv = await publicView();
  assert.equal(pv.phase, 'ROUND_CLOSED'); assertNoLeak(pv, '마감 후 공개 전');
  // 판정 = 서버가 마감 시점에 가진 참가자별 최종값으로 로컬 판정한 결과
  const st = await serverState();
  const local = rules.judge([...expected.values()]);
  assert.deepEqual(st.pending.distribution, local.distribution);
  assert.equal(st.pending.winningNumber, local.winningNumber);
  hostUnsub(); unsubs.forEach((u) => u());
});

test('F) 중복 처리: 공개 중복 요청·같은 요청 ID 재전송·마감 반복 → 한 번만 반영', async () => {
  const reqId = rid();
  const pv = await publicView();
  const r1 = await gameAction(host, roomId, { type: 'reveal', round: pv.round, attempt: pv.attempt }, reqId);
  const r2 = await gameAction(host, roomId, { type: 'reveal', round: pv.round, attempt: pv.attempt }, reqId); // 같은 요청 ID 재시도
  assert.ok(r1.ok); assert.equal(r2.duplicate, true); metrics.duplicateRequestsReplayed += 1;
  const r3 = await gameAction(host, roomId, { type: 'reveal', round: pv.round, attempt: pv.attempt }); // 버튼 두 번
  assert.equal(r3.ok, false);
  const again = await gameAction(host, roomId, { type: 'close-round', round: 1, attempt: 1 });
  assert.equal(again.ok, false);
  const st = await serverState();
  if (st.results.length !== 1) metrics.doubleScoring += 1;
  assert.equal(st.results.length, 1);
  const view = await publicView();
  const wins = view.standings.reduce((a, s) => a + s.wins, 0);
  assert.equal(wins, view.results[0].winnerId ? 1 : 0, '승리 합계 = 승자 수');
  assert.equal(view.results[0].distribution.reduce((a, b) => a + b, 0), N, '분포 합계 = 제출 29');
  // 참가자 본인 결과 기록 = 서버 최종값
  for (const p of players.slice(0, 3)) {
    const v = (await getDoc(doc(p.db, 'rooms', roomId, 'private', p.uid))).data().view;
    assert.equal(v.history[0].number, st.results[0].picks[p.playerId]);
  }
});

test('보안: 권한 우회·잘못된 입력·클라이언트 직접 쓰기 거부', async () => {
  const outsider = await client('player');
  await assert.rejects(outsider.call('gameAction', { roomId, requestId: rid(), action: { type: 'submit', round: 2, attempt: 1, value: 1 } }), (e) => e.code === 'functions/permission-denied');
  for (const type of ['start-round', 'pause', 'reveal', 'void-round', 'end-game', 'finish-game']) {
    const r = await gameAction(players[2], roomId, { type, round: 2, attempt: 1 });
    if (r.ok) metrics.permissionBypass += 1;
    assert.equal(r.error.code, 'not-host', type);
  }
  await assert.rejects(players[2].call('gameAction', { roomId, requestId: rid(), action: { type: 'submit', round: 2, attempt: 1, value: '5' } }), (e) => e.code === 'functions/invalid-argument', '문자열 숫자 거부');
  await assert.rejects(setDoc(doc(players[2].db, 'rooms', roomId), { status: 'finished' }), (e) => e.code === 'permission-denied');
  await assert.rejects(setDoc(doc(players[2].db, 'rooms', roomId, 'server', 'state'), { gameState: {} }), (e) => e.code === 'permission-denied');
  await assert.rejects(setDoc(doc(players[2].db, 'rooms', roomId, 'private', players[2].uid), { view: { current: { number: 1 } } }), (e) => e.code === 'permission-denied', '본인 문서도 직접 쓰기 불가');
  const signedOut = await client('signed-out');
  await assert.rejects(signedOut.call('gameAction', { roomId, requestId: rid(), action: { type: 'submit', round: 2, attempt: 1, value: 1 } }), (e) => e.code === 'functions/unauthenticated');
  // 잘못된 숫자 (진행 중 라운드에서)
  const s = await gameAction(host, roomId, { type: 'start-round', round: 2 });
  assert.ok(s.ok);
  const pv = await publicView();
  for (const value of [0, 21, 3.5, -1]) {
    const r = await submit(players[3], roomId, pv, value);
    assert.equal(r.error.code, 'invalid-number', String(value));
  }
});

test('G) 3라운드 전체: 2라운드 승자 없음, 3라운드 진행, 최종 순위 = 로컬 판정', async () => {
  // 2라운드 (이미 시작됨): 모두 1~14 를 2명 이상씩 → 승자 없음
  let pv = await publicView();
  const plan2 = players.map((_, i) => Math.floor(i / 2) + 1); // 1,1,2,2,…,14,14,15 → 15 만 1명 → 승리 15
  plan2[N - 1] = 14; // 마지막 1명도 14 → 14 가 3명, 모두 중복 → 승자 없음
  assert.ok((await Promise.all(players.map((p, i) => submit(p, roomId, pv, plan2[i])))).every((r) => r.ok));
  await closeWhenDue();
  assert.ok((await hostDo('reveal')).ok);
  pv = await publicView();
  assert.equal(pv.results[1].winningNumber, null, '2라운드 승자 없음');
  // 3라운드: 일부 미참여, 지시문 §5.1 분포
  assert.ok((await hostDo('start-round', { round: 3 })).ok);
  pv = await publicView();
  const plan3 = [...Array(8).fill(1), ...Array(5).fill(2), ...Array(4).fill(3), ...Array(3).fill(4), 5, 5, 6, 9, 9, 12];
  const submitters = players.slice(0, plan3.length); // 26명 제출, 3명 미참여
  assert.ok((await Promise.all(submitters.map((p, i) => submit(p, roomId, pv, plan3[i])))).every((r) => r.ok));
  await closeWhenDue();
  assert.ok((await hostDo('reveal')).ok);
  assert.ok((await hostDo('skip-reveal')).ok);
  assert.ok((await hostDo('finish-game')).ok);
  const finalRoom = (await getDoc(doc(host.db, 'rooms', roomId))).data();
  assert.equal(finalRoom.status, 'finished');
  const st = await serverState();
  assert.equal(st.results[2].winningNumber, 6);
  assert.equal(st.results[2].submittedCount, plan3.length);
  // 로컬 재계산과 비교
  const expectedRanking = rules.standings(st.players, st.results).map((r) => [r.playerId, r.rank, r.wins]);
  assert.deepEqual(finalRoom.result.ranking.map((r) => [r.playerId, r.rank, r.wins]), expectedRanking);
  for (const r of st.results) {
    const local = rules.judge(Object.values(r.picks));
    assert.deepEqual(r.distribution, local.distribution); assert.equal(r.winningNumber, local.winningNumber);
  }
  const winsTotal = finalRoom.result.ranking.reduce((a, r) => a + r.wins, 0);
  const winnersCount = st.results.filter((r) => r.winnerId).length;
  if (winsTotal !== winnersCount) metrics.doubleScoring += 1;
  assert.equal(winsTotal, winnersCount, '총 승리 수 = 승자가 있는 라운드 수');
  const after = await gameAction(host, roomId, { type: 'start-round', round: 4 });
  assert.equal(after.ok, false);
  metrics.completedGame = true;
});

test('H·I) 일시정지·재개 (남은 시간 보존, 제출 차단) + 라운드 무효화·재진행 (이전 선택·승리 미반영)', async () => {
  const { roomId: id, code: c2 } = await host.call('createRoom', { gameId: GAME, config: { roundSeconds: 8 } });
  room2 = id;
  const joins = await Promise.all(players.map((p, i) => p.call('joinRoom', { code: c2, nickname: `두번째${i + 1}` })));
  players.forEach((p, i) => { p.pid2 = joins[i].playerId; });
  assert.ok((await host.call('startGame', { roomId: room2, requestId: rid() })).ok);
  assert.ok((await hostDo('start-round', {}, room2)).ok);
  let pv = await publicView(room2);
  assert.ok((await submit(players[0], room2, pv, 1)).ok);
  await sleep(1500);
  assert.ok((await hostDo('pause', {}, room2)).ok);
  pv = await publicView(room2);
  assert.equal(pv.paused, true); assert.equal(pv.deadlineAt, null);
  const kept = pv.pausedRemainingMs;
  assert.ok(kept > 5000 && kept < 7000, `남은 시간 보존: ${kept}`);
  const blocked = await submit(players[1], room2, pv, 2);
  assert.equal(blocked.error.code, 'paused', '일시정지 중 제출 차단');
  assert.equal((await gameAction(host, room2, { type: 'close-round', round: 1, attempt: 1 })).error.code, 'paused');
  await sleep(2500); // 일시정지 중 시간이 흘러도 남은 시간은 그대로
  const tResume = Date.now();
  assert.ok((await hostDo('resume', {}, room2)).ok);
  pv = await publicView(room2);
  assert.ok(Math.abs(pv.deadlineAt - (tResume + kept)) < 1000, `재개 후 보존 시간부터: ${pv.deadlineAt - tResume} vs ${kept}`);
  assert.ok((await submit(players[1], room2, pv, 2)).ok, '재개 후 제출 가능');
  assert.ok((await submit(players[2], room2, pv, 3)).ok);
  await closeWhenDue(room2);
  // I: 무효화 → 같은 라운드 새 시도
  assert.ok((await hostDo('void-round', {}, room2)).ok);
  pv = await publicView(room2);
  assert.equal(pv.phase, 'LOBBY'); assert.equal(pv.round, 1); assert.equal(pv.attempt, 2);
  assert.deepEqual(pv.restart, { round: 1, attempt: 2 });
  const oldTry = await gameAction(players[0], room2, { type: 'submit', round: 1, attempt: 1, value: 1 });
  assert.equal(oldTry.ok, false, '이전 시도로 제출 불가');
  assert.ok((await hostDo('start-round', {}, room2)).ok);
  pv = await publicView(room2);
  assert.equal(await liveCount(room2), 0, '새 시도는 제출 0에서 시작');
  const mine = (await getDoc(doc(players[0].db, 'rooms', room2, 'private', players[0].uid))).data().view;
  assert.equal(mine.current, null, '이전 선택 재사용 안 함');
  assert.ok((await submit(players[3], room2, pv, 7)).ok);
  await closeWhenDue(room2);
  assert.ok((await hostDo('reveal', {}, room2)).ok);
  const st = await serverState(room2);
  assert.equal(st.results.length, 1); assert.equal(st.results[0].attempt, 2);
  assert.equal(st.results[0].winnerId, players[3].pid2, '재진행 결과만 반영');
  const standings = (await publicView(room2)).standings;
  assert.equal(standings.find((s) => s.playerId === players[0].pid2).wins, 0, '무효화된 시도의 1(유일)은 승리 아님');
  const hostPriv = (await getDoc(doc(host.db, 'rooms', room2, 'private', host.uid))).data().view;
  assert.deepEqual(hostPriv.audit.map((a) => a.type), ['pause', 'resume', 'void'], '감사 기록');
  // 공개 이후 무효화 불가
  assert.equal((await hostDo('void-round', {}, room2)).ok, false);
  // 비상 중단: 공개 결과 보존
  assert.ok((await hostDo('end-game', {}, room2)).ok);
  const fin = (await getDoc(doc(host.db, 'rooms', room2))).data();
  assert.equal(fin.status, 'finished'); assert.equal(fin.result.aborted, true); assert.equal(fin.result.completedRounds, 1);
});

test('측정값 요약: 판정 오류·불일치·유출·우회·중복 채점 0건', () => {
  assert.equal(metrics.dataMismatches, 0);
  assert.equal(metrics.lateAccepted, 0);
  assert.equal(metrics.privacyLeaks, 0);
  assert.equal(metrics.permissionBypass, 0);
  assert.equal(metrics.doubleScoring, 0);
  assert.equal(metrics.serverErrors, 0, '예상하지 못한 서버 오류 0');
});
