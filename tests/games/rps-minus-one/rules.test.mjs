// 가위바위보 하나빼기 — 규칙 단위 테스트 (순수 함수). 플랫폼과 같은 경로로 참가자 손은 playerInput.execute, 그 밖은 executeAction.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../../../src/games/rps-minus-one/rules.js';
import { GAMES } from '../../../src/games/registry.js';
import { createLocalSession } from '../../../src/adapters/local-session.js';

const { PHASE, ROCK: R, SCISSORS: S, PAPER: P, outcome, decodePair, judgeRound } = rules;
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `참가${i + 1}` }));
const host = { role: 'host' };
const PL = (id) => ({ role: 'player', playerId: id });
const pair = (a, b) => rules.encodePair([a, b]);

function game(n = 4, config = {}) {
  const created = rules.createGame({ players: players(n), config, now: 0 });
  assert.ok(created.ok);
  const h = { s: created.state, inputs: {}, t: 0 };
  h.run = (actor, action, now) => {
    if (actor.role === 'player' && rules.playerInput.actions.includes(action.type)) {
      const r = rules.playerInput.execute(h.s, h.inputs[actor.playerId] ?? null, actor, action, { now });
      if (r.ok) h.inputs = { ...h.inputs, [actor.playerId]: r.input };
      return r;
    }
    const r = rules.executeAction(h.s, actor, action, { now, inputs: h.inputs });
    if (r.ok) h.s = r.state;
    return r;
  };
  h.must = (actor, action, now) => {
    const r = h.run(actor, action, now);
    assert.ok(r.ok, `실패: ${JSON.stringify(action)} → ${JSON.stringify(r.error)}`);
    return r;
  };
  h.cur = () => ({ round: h.s.round, attempt: h.s.attempt });
  /** 한 라운드: hostTwo·hostOne, picks = { p1: [a,b,keep] | [a,b] | null } */
  h.round = (hostTwo, hostOne, picks, { reveal = true } = {}) => {
    h.t += 100000;
    if (h.s.phase === PHASE.RESULT) h.must(host, { type: 'start-round', round: h.s.round + 1 }, h.t);
    else h.must(host, { type: 'start-round', ...h.cur() }, h.t);
    h.must(host, { type: 'host-two', ...h.cur(), value: pair(...hostTwo) }, h.t + 1);
    for (const [pid, p] of Object.entries(picks)) if (p) h.must(PL(pid), { type: 'pick-two', ...h.cur(), value: pair(p[0], p[1]) }, h.t + 2);
    const t1 = h.s.deadlineAt; // ① 마감 시각 (마감 후 deadlineAt 은 ② 마감 시각으로 바뀜)
    h.must(host, { type: 'close-round', ...h.cur(), value: 2 }, t1);
    h.must(host, { type: 'host-one', ...h.cur(), value: hostOne }, t1 + 1);
    for (const [pid, p] of Object.entries(picks)) if (p && p[2]) h.must(PL(pid), { type: 'keep-one', ...h.cur(), value: p[2] }, t1 + 2);
    h.must(host, { type: 'close-round', ...h.cur(), value: 1 }, h.s.deadlineAt);
    if (reveal) h.must(host, { type: 'reveal', ...h.cur() }, h.s.pending.finalizedAt + 1);
  };
  return h;
}

test('가위바위보 판정: 바위>가위, 가위>보, 보>바위, 같은 손은 비김', () => {
  assert.equal(outcome(R, S), 'win'); assert.equal(outcome(S, P), 'win'); assert.equal(outcome(P, R), 'win');
  assert.equal(outcome(S, R), 'lose'); assert.equal(outcome(P, S), 'lose'); assert.equal(outcome(R, P), 'lose');
  for (const h of rules.HANDS) assert.equal(outcome(h, h), 'draw');
  assert.throws(() => outcome(4, R));
});
test('두 손 코드: 서로 다른 두 손만, 순서 무관', () => {
  assert.deepEqual(decodePair(12), [1, 2]); assert.deepEqual(decodePair(31), [1, 3]); assert.deepEqual(decodePair(23), [2, 3]);
  for (const bad of [11, 22, 33, 14, 40, 5, 123, 1.5, '12', null]) assert.equal(decodePair(bad), null, String(bad));
});
test('라운드 판정: 이긴 사람만 생존, 비김·짐·미제출 탈락, 전원 탈락이면 취소', () => {
  const alive = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const j = judgeRound(alive, { p1: { two: [1, 3], one: P }, p2: { two: [1, 2], one: R }, p3: { two: [2, 3], one: S }, p4: { two: [1, 2], one: null } }, R);
  assert.deepEqual(j.survivors, ['p1']);
  assert.deepEqual(j.eliminated.map((e) => [e.playerId, e.reason]), [['p2', 'draw'], ['p3', 'lose'], ['p4', 'no-one'], ['p5', 'no-two']]);
  assert.deepEqual(j.counts, { 1: 1, 2: 1, 3: 1 });
  const none = judgeRound(alive, { p1: { two: [1, 2], one: R } }, P);
  assert.equal(none.cancelled, true); assert.deepEqual(none.survivors, alive); assert.deepEqual(none.eliminated, []);
  assert.equal(none.wouldEliminate.length, 5);
});

test('설정·등록: 기본 20초·15초, 범위 밖 거부, 30명 platform 전용, 단 하나의 숫자는 등록 해제', () => {
  assert.deepEqual(rules.normalizeConfig({}).config, { twoSeconds: 20, oneSeconds: 15 });
  for (const bad of [{ twoSeconds: 4 }, { oneSeconds: 121 }, { twoSeconds: 10.5 }, []]) assert.equal(rules.normalizeConfig(bad).ok, false);
  const g = GAMES['rps-minus-one'];
  assert.ok(g); assert.equal(g.manifest.players.max, 30); assert.deepEqual(g.manifest.distributions, ['platform']);
  assert.deepEqual(g.rules.playerInput.actions, ['pick-two', 'keep-one']);
  assert.equal(GAMES['unique-number'], undefined);
  assert.ok(GAMES['demo-number-choice']);
});

test('두 손 → 진행자 두 손 공개 → 하나 남기기 → 판정, 진행자 손은 단계별로만 공개', () => {
  const h = game(3);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 1000);
  assert.equal(h.s.phase, PHASE.PICK_TWO); assert.equal(h.s.deadlineAt, 21000);
  assert.equal(rules.playerInput.key(h.s), 'r1a1t');
  h.must(host, { type: 'host-two', round: 1, attempt: 1, value: 13 }, 1001);
  assert.equal(rules.getView(h.s, { role: 'public' }).hostTwo, null, '① 동안 진행자 두 손 비공개');
  assert.equal(h.must(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value: 12 }, 2000).newInWindow, true);
  assert.equal(h.must(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value: 23 }, 3000).newInWindow, false, '변경은 인원 증가 없음');
  h.must(PL('p2'), { type: 'pick-two', round: 1, attempt: 1, value: 13 }, 3000);
  assert.equal(h.run(PL('p3'), { type: 'keep-one', round: 1, attempt: 1, value: 1 }, 3000).error.code, 'step-closed', '① 단계에 하나 빼기 불가');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1, value: 2 }, 20999).error.code, 'too-early');
  h.must(host, { type: 'close-round', round: 1, attempt: 1, value: 2 }, 21000);
  assert.equal(h.s.phase, PHASE.PICK_ONE); assert.equal(h.s.deadlineAt, 36000);
  assert.deepEqual(rules.getView(h.s, { role: 'public' }).hostTwo, [1, 3], '② 진행자 두 손 공개');
  assert.equal(rules.playerInput.key(h.s), 'r1a1o');
  assert.equal(h.run(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value: 12 }, 21500).error.code, 'step-closed', '② 단계에 두 손 변경 불가');
  assert.equal(h.run(PL('p3'), { type: 'keep-one', round: 1, attempt: 1, value: 1 }, 22000).error.code, 'no-two', '① 미제출자는 남길 손 없음');
  assert.equal(h.run(PL('p1'), { type: 'keep-one', round: 1, attempt: 1, value: 1 }, 22000).error.code, 'invalid-keep', '내 두 손 밖 거부');
  h.must(PL('p1'), { type: 'keep-one', round: 1, attempt: 1, value: 2 }, 22000);
  h.must(PL('p1'), { type: 'keep-one', round: 1, attempt: 1, value: 3 }, 23000); // 마감 전 변경
  h.must(PL('p2'), { type: 'keep-one', round: 1, attempt: 1, value: 1 }, 23000);
  assert.equal(h.run(host, { type: 'host-one', round: 1, attempt: 1, value: 2 }, 23000).error.code, 'invalid-keep');
  h.must(host, { type: 'host-one', round: 1, attempt: 1, value: 1 }, 23000); // 진행자: 바위
  assert.equal(rules.getView(h.s, { role: 'public' }).results.length, 0);
  assert.ok(!JSON.stringify(rules.getView(h.s, { role: 'public' })).includes('hostOne":1'), '진행자 남긴 손 비공개');
  assert.equal(h.run(PL('p1'), { type: 'keep-one', round: 1, attempt: 1, value: 2 }, 36000).error.code, 'deadline-passed', '정확히 마감 시각 거부');
  h.must(PL('p2'), { type: 'close-round', round: 1, attempt: 1, value: 1 }, 36000);
  assert.equal(h.s.phase, PHASE.CLOSED);
  assert.deepEqual(h.s.pending.survivors, ['p1'], '보(3)가 바위(1)를 이김');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1, value: 1 }, 36001).error.code, 'already-closed');
  h.must(host, { type: 'reveal', round: 1, attempt: 1 }, 37000);
  assert.deepEqual(h.s.alive, ['p1']);
  assert.deepEqual(h.s.eliminated, { p2: { round: 1, reason: 'draw' }, p3: { round: 1, reason: 'no-two' } });
  assert.equal(rules.getView(h.s, { role: 'public' }).winnerName, '참가1');
  assert.equal(h.run(host, { type: 'start-round', round: 2 }, 38000).ok, false, '1명 남으면 다음 라운드 없음');
  h.must(host, { type: 'finish-game' }, 38000);
  const res = rules.getResult(h.s);
  assert.equal(res.finished, true); assert.deepEqual(res.winner, { playerId: 'p1', name: '참가1' });
  assert.deepEqual(res.ranking.map((r) => [r.playerId, r.rank]), [['p1', 1], ['p2', 2], ['p3', 2]]);
});
test('진행자 손이 정해지지 않으면 마감 불가 (자동 마감은 진행자 선택 후)', () => {
  const h = game(2, { twoSeconds: 5, oneSeconds: 5 });
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1, value: 2 }, 5000).error.code, 'host-not-ready');
  h.must(host, { type: 'host-two', round: 1, attempt: 1, value: 12 }, 5001);
  h.must(host, { type: 'close-round', round: 1, attempt: 1, value: 2 }, 5002);
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1, value: 2 }, 99999).error.code, 'already-closed', '지난 단계 마감 요청은 다음 단계를 마감하지 않음');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1, value: 1 }, 10002).error.code, 'host-not-ready');
});
test('전원 탈락이면 그 라운드 탈락 취소 (모두 생존, 다음 라운드)', () => {
  const h = game(3);
  h.round([1, 2], R, { p1: [1, 2, R], p2: [1, 2, S], p3: [2, 3, S] }); // 바위: p1 비김, p2·p3 짐
  assert.equal(h.s.results[0].cancelled, true);
  assert.deepEqual(h.s.alive, ['p1', 'p2', 'p3']);
  assert.deepEqual(h.s.eliminated, {});
  h.round([2, 3], S, { p1: [1, 2, R], p2: [2, 3, P], p3: null }); // 가위: p1 이김
  assert.deepEqual(h.s.alive, ['p1']);
  assert.deepEqual(h.s.eliminated.p3, { round: 2, reason: 'no-two' });
});
test('최후의 1인까지 여러 라운드, 순위는 늦게 탈락할수록 높음(같은 라운드 공동)', () => {
  const h = game(5);
  h.round([1, 3], P, { p1: [1, 2, S], p2: [1, 2, S], p3: [2, 3, S], p4: [1, 3, R], p5: [1, 2] }); // 보: 가위 이김 → p1 p2 p3 생존
  assert.deepEqual(h.s.alive, ['p1', 'p2', 'p3']);
  assert.equal(h.s.eliminated.p5.reason, 'no-one');
  h.round([1, 2], R, { p1: [1, 3, P], p2: [1, 3, P], p3: [2, 3, S] }); // 바위: 보 이김 → p1 p2
  h.round([2, 3], S, { p1: [1, 2, R], p2: [2, 3, P] }); // 가위: p1 이김
  assert.deepEqual(h.s.alive, ['p1']);
  h.must(host, { type: 'finish-game' }, h.t + 99999);
  const r = rules.getResult(h.s).ranking.map((x) => [x.playerId, x.rank, x.eliminatedRound]);
  assert.deepEqual(r, [['p1', 1, null], ['p2', 2, 3], ['p3', 3, 2], ['p4', 4, 1], ['p5', 4, 1]]);
  assert.equal(rules.getResult(h.s).roundsPlayed, 3);
});
test('탈락자는 더 이상 낼 수 없음, 일시정지 중 제출·마감 불가, 재개 시 남은 시간 보존', () => {
  const h = game(3, { twoSeconds: 20, oneSeconds: 15 });
  h.round([1, 2], R, { p1: [1, 3, P], p2: [1, 2, S], p3: [1, 3, P] });
  assert.deepEqual(h.s.alive, ['p1', 'p3']);
  h.must(host, { type: 'start-round', round: 2 }, 500000);
  assert.equal(h.run(PL('p2'), { type: 'pick-two', round: 2, attempt: 1, value: 12 }, 500001).error.code, 'eliminated');
  h.must(host, { type: 'pause', round: 2, attempt: 1 }, 505000);
  assert.equal(h.s.pausedRemainingMs, 15000);
  assert.equal(h.run(PL('p1'), { type: 'pick-two', round: 2, attempt: 1, value: 12 }, 505001).error.code, 'paused');
  assert.equal(h.run(host, { type: 'close-round', round: 2, attempt: 1, value: 2 }, 999999).error.code, 'paused');
  h.must(host, { type: 'resume', round: 2, attempt: 1 }, 600000);
  assert.equal(h.s.deadlineAt, 615000);
  assert.deepEqual(h.s.audit.map((a) => a.type), ['pause', 'resume']);
});
test('입력 검증·진행자 전용·반복 변경 제한·시각 없음', () => {
  const h = game(2);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  for (const value of [11, 0, 4, 12.5, undefined]) assert.equal(h.run(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value }, 1).error.code, 'invalid-hands', String(value));
  assert.equal(h.run(PL('p9'), { type: 'pick-two', round: 1, attempt: 1, value: 12 }, 1).error.code, 'not-player');
  assert.equal(h.run(PL('p1'), { type: 'pick-two', round: 2, attempt: 1, value: 12 }, 1).error.code, 'step-closed');
  for (const type of ['host-two', 'pause', 'void-round', 'reveal', 'end-game', 'finish-game', 'skip-reveal']) {
    assert.equal(h.run(PL('p1'), { type, round: 1, attempt: 1, value: 12 }, 1).error.code, 'not-host', type);
  }
  assert.equal(h.run(host, { type: 'pick-two', round: 1, attempt: 1, value: 12 }, 1).error.code, 'not-player', '진행자는 참가자 경로로 못 냄');
  for (let i = 0; i < rules.MAX_REVISIONS; i += 1) h.must(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value: i % 2 ? 12 : 13 }, i + 2);
  assert.equal(h.run(PL('p1'), { type: 'pick-two', round: 1, attempt: 1, value: 23 }, 100).error.code, 'too-many-changes');
  assert.equal(rules.playerInput.execute(h.s, null, PL('p2'), { type: 'pick-two', round: 1, attempt: 1, value: 12 }, {}).error.code, 'no-clock');
});
test('라운드 무효화: 마감 후 공개 전만, 같은 라운드 새 시도, 이전 입력·탈락 미반영, 감사 기록', () => {
  const h = game(3);
  h.round([1, 2], R, { p1: [1, 3, P], p2: [1, 2, S], p3: [1, 2, R] }, { reveal: false });
  assert.equal(h.s.phase, PHASE.CLOSED);
  h.must(host, { type: 'void-round', round: 1, attempt: 1 }, h.t + 50000);
  assert.equal(h.s.phase, PHASE.LOBBY); assert.equal(h.s.attempt, 2); assert.deepEqual(h.s.restart, { round: 1, attempt: 2 });
  assert.deepEqual(h.s.alive, ['p1', 'p2', 'p3'], '무효화된 시도의 탈락 없음');
  assert.equal(h.s.audit.at(-1).type, 'void');
  h.must(host, { type: 'start-round', round: 1, attempt: 2 }, h.t + 60000);
  assert.equal(rules.getView(h.s, { role: 'player', playerId: 'p1', input: h.inputs.p1 }).current, null, '이전 시도 손은 새 시도에 안 보임');
  assert.equal(h.run(PL('p1'), { type: 'keep-one', round: 1, attempt: 1, value: 3 }, h.t + 60001).error.code, 'step-closed');
  h.must(host, { type: 'host-two', round: 1, attempt: 2, value: 23 }, h.t + 60002);
  h.must(PL('p2'), { type: 'pick-two', round: 1, attempt: 2, value: 12 }, h.t + 60003);
  h.must(host, { type: 'close-round', round: 1, attempt: 2, value: 2 }, h.s.deadlineAt);
  h.must(host, { type: 'host-one', round: 1, attempt: 2, value: P }, h.s.deadlineAt - 1);
  h.must(PL('p2'), { type: 'keep-one', round: 1, attempt: 2, value: S }, h.s.deadlineAt - 1);
  h.must(host, { type: 'close-round', round: 1, attempt: 2, value: 1 }, h.s.deadlineAt);
  assert.deepEqual(h.s.pending.survivors, ['p2'], '새 시도 입력만 반영 (p1·p3 의 이전 손 무시 → 미제출)');
  h.must(host, { type: 'reveal', round: 1, attempt: 2 }, h.s.pending.finalizedAt + 1);
  assert.equal(h.run(host, { type: 'void-round', round: 1, attempt: 2 }, h.t + 999999).ok, false, '공개 후 무효화 불가');
});
test('공개 중복·건너뛰기 반복은 한 번만, 비상 중단은 공개 결과 보존', () => {
  const h = game(3);
  h.round([1, 2], R, { p1: [1, 3, P], p2: [1, 2, S], p3: [1, 3, P] });
  assert.equal(h.run(host, { type: 'reveal', round: 1, attempt: 1 }, h.t + 99999).ok, false);
  assert.equal(h.s.results.length, 1);
  h.must(host, { type: 'skip-reveal', round: 1 }, h.t + 99999);
  const before = h.s; h.must(host, { type: 'skip-reveal', round: 1 }, h.t + 99999); assert.equal(h.s, before);
  h.must(host, { type: 'start-round', round: 2 }, h.t + 200000);
  h.must(host, { type: 'end-game' }, h.t + 200001);
  const res = rules.getResult(h.s);
  assert.equal(res.aborted, true); assert.equal(res.roundsPlayed, 1); assert.equal(res.winner, null);
  assert.deepEqual(res.ranking.filter((r) => r.rank === 1).map((r) => r.playerId), ['p1', 'p3'], '중단 시 생존자 공동 1위');
});
test('비공개: 진행 중·공개 전 공개·진행자 화면에 참가자 손 없음, 진행자 남긴 손은 공개 전 비공개', () => {
  const h = game(3);
  h.round([1, 2], R, { p1: [1, 3, P], p2: [2, 3, S] }, { reveal: false });
  const pub = JSON.stringify(rules.getView(h.s, { role: 'public' }));
  const hostView = JSON.stringify(rules.getView(h.s, { role: 'host' }));
  for (const [name, text] of [['public', pub], ['host', hostView]]) assert.ok(!text.includes('picks') && !text.includes('"two"') && !text.includes('"one"'), `${name}: ${text}`);
  assert.ok(!pub.includes('hostOne'), '공개 전 진행자 남긴 손 비공개');
  const p3 = rules.getView(h.s, { role: 'player', playerId: 'p3', input: null });
  assert.equal(p3.current, null);
  const p1 = rules.getView(h.s, { role: 'player', playerId: 'p1', input: h.inputs.p1 });
  assert.deepEqual(p1.current, { two: [1, 3], one: 3 });
  h.must(host, { type: 'reveal', round: 1, attempt: 1 }, h.s.pending.finalizedAt + 1);
  const r = rules.getView(h.s, { role: 'public' }).results[0];
  assert.equal(r.hostOne, R); assert.deepEqual(r.counts, { 1: 0, 2: 1, 3: 1 }); assert.deepEqual(r.survivorNames, ['참가1']);
  assert.ok(!('picks' in r));
  assert.deepEqual(rules.getView(h.s, { role: 'player', playerId: 'p2', input: h.inputs.p2 }).history[0], { round: 1, two: [2, 3], one: 2, played: true, survived: false, reason: 'lose' });
});
test('로컬 연결부도 같은 개인 입력 경로', async () => {
  const session = createLocalSession({ rules, players: players(2), config: {}, hostActions: ['start-round', 'host-two'] });
  await session.send({ type: 'start-round', round: 1, attempt: 1 });
  assert.ok((await session.send({ type: 'pick-two', round: 1, attempt: 1, value: 12 }, { playerId: 'p1' })).ok);
  let snap; session.subscribe((s) => { snap = s; })();
  assert.equal(snap.inputCounts.r1a1t, 1);
});
