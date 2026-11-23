// 단 하나의 숫자 — 규칙(판정 엔진·진행 상태) 단위 테스트. 서버 없이 순수 함수만 검증한다.
// 플랫폼과 같은 방식으로 숫자 제출은 playerInput.execute(참가자별 입력), 그 밖의 행동은 executeAction(ctx.inputs)로 처리한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../../../src/games/unique-number/rules.js';
import { GAMES } from '../../../src/games/registry.js';
import { createLocalSession } from '../../../src/adapters/local-session.js';

const { judge, PHASE } = rules;
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `참가${i + 1}` }));
const host = { role: 'host' };
const P = (id) => ({ role: 'player', playerId: id });

/** 플랫폼(서버)과 같은 처리 경로를 흉내 내는 최소 실행기 */
function game(n = 6, config = {}) {
  const created = rules.createGame({ players: players(n), config, now: 0 });
  assert.ok(created.ok);
  const h = { s: created.state, inputs: {} };
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
  h.submit = (pid, value, now) => h.must(P(pid), { type: 'submit', ...h.cur(), value }, now);
  h.close = (now = h.s.deadlineAt) => h.must(host, { type: 'close-round', ...h.cur() }, now);
  h.reveal = (now) => h.must(host, { type: 'reveal', ...h.cur() }, now);
  /** 라운드 하나: picks = { p1: 3, ... } */
  h.playRound = (picks, t0) => {
    if (h.s.phase === PHASE.RESULT) h.must(host, { type: 'start-round', round: h.s.round + 1 }, t0);
    else h.must(host, { type: 'start-round', ...h.cur() }, t0);
    for (const [pid, v] of Object.entries(picks)) h.submit(pid, v, t0 + 1000);
    const dl = h.s.deadlineAt;
    h.close(dl);
    h.reveal(dl + 1000);
  };
  return h;
}

// ── 판정 예시 (지시문 §1.4 A~F) ─────────────────────────
test('판정 예시 A: [1,1,2,3,3,4] → 2', () => {
  const r = judge([1, 1, 2, 3, 3, 4]);
  assert.equal(r.winningNumber, 2);
  assert.deepEqual(r.validNumbers, [2, 4]);
  assert.equal(r.distribution[0], 2); assert.equal(r.distribution[2], 2);
});
test('판정 예시 B: [1,1,2,2,3,3] → 승자 없음', () => assert.equal(judge([1, 1, 2, 2, 3, 3]).winningNumber, null));
test('판정 예시 C: [5,7,9,11] → 5', () => assert.equal(judge([5, 7, 9, 11]).winningNumber, 5));
test('판정 예시 D: [] → 승자 없음', () => {
  const r = judge([]);
  assert.equal(r.winningNumber, null);
  assert.equal(r.distribution.length, 20);
  assert.ok(r.distribution.every((c) => c === 0));
});
test('판정 예시 E: 29명 모두 1 → 승자 없음', () => assert.equal(judge(Array(29).fill(1)).winningNumber, null));
test('판정 예시 F: 28명 1 + 1명 20 → 20', () => assert.equal(judge([...Array(28).fill(1), 20]).winningNumber, 20));
test('판정: 지시문 §5.1 분포 예시 (1:8,2:5,3:4,4:3,5:2,6:1) → 6', () => {
  const nums = [...Array(8).fill(1), ...Array(5).fill(2), ...Array(4).fill(3), ...Array(3).fill(4), 5, 5, 6, 9, 9];
  const r = judge(nums);
  assert.equal(r.winningNumber, 6);
  assert.deepEqual(r.distribution.slice(0, 6), [8, 5, 4, 3, 2, 1]);
});
test('판정 입력: 범위 밖·정수 아님은 판정 엔진이 거부', () => {
  for (const bad of [0, 21, 1.5, -1, NaN, '3']) assert.throws(() => judge([bad]));
});

// ── 설정·등록 ───────────────────────────────────────────
test('설정: 기본 40초·3라운드·1~20, 범위 밖 거부', () => {
  const c = rules.normalizeConfig({});
  assert.deepEqual(c.config, { totalRounds: 3, minNumber: 1, maxNumber: 20, roundSeconds: 40 });
  for (const bad of [{ roundSeconds: 4 }, { roundSeconds: 121 }, { roundSeconds: 10.5 }, { totalRounds: 5 }, { maxNumber: 30 }, []]) {
    assert.equal(rules.normalizeConfig(bad).ok, false, JSON.stringify(bad));
  }
});
test('등록: 플랫폼 등록 목록에 포함, 29명·platform 전용·공개·개인 입력 계약', () => {
  const g = GAMES['unique-number'];
  assert.ok(g);
  assert.equal(g.manifest.players.max, 29);
  assert.deepEqual(g.manifest.distributions, ['platform']);
  assert.equal(g.manifest.isDemo, false);
  assert.deepEqual(g.rules.playerInput.actions, ['submit']);
  assert.ok(GAMES['demo-number-choice'], '기존 샘플 등록 유지');
});

// ── 제출·수정·마감 ──────────────────────────────────────
test('제출: 변경 가능, 마지막 확정값만 집계, 같은 숫자 재제출은 변화 없음, 첫 제출만 인원 집계', () => {
  const h = game(3);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 1000);
  assert.equal(h.s.deadlineAt, 41000);
  assert.equal(rules.playerInput.key(h.s), 'r1a1');
  assert.equal(h.submit('p1', 5, 2000).newInWindow, true);
  assert.equal(h.submit('p1', 3, 3000).newInWindow, false, '수정은 인원을 늘리지 않음');
  const same = h.submit('p1', 3, 4000);
  assert.equal(same.newInWindow, false); assert.equal(same.input.revision, 2, '같은 숫자는 수정 횟수 증가 없음');
  assert.deepEqual(h.inputs.p1, { round: 1, attempt: 1, number: 3, revision: 2, at: 3000 });
  h.submit('p2', 3, 5000);
  h.close(41000);
  assert.equal(h.s.pending.distribution[2], 2, 'p1 의 이전 값 5 는 집계되지 않음');
  assert.equal(h.s.pending.distribution[4], 0);
  assert.equal(h.s.pending.submittedCount, 2);
  assert.equal(h.s.pending.winningNumber, null);
});
test('마감 경계: 직전 수락, 정확히 마감 시각·이후 거부, 마감 전 close 거부, 마감 후 수정 거부', () => {
  const h = game(2, { roundSeconds: 10 });
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  assert.ok(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 1 }, 9999).ok, '마감 1ms 전 수락');
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 2 }, 10000).error.code, 'deadline-passed', '정확히 마감 시각 거부');
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 2 }, 10001).error.code, 'deadline-passed');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1 }, 9999).error.code, 'too-early');
  h.must(P('p2'), { type: 'close-round', round: 1, attempt: 1 }, 10000); // 참가자 화면도 마감 요청 가능 (시각 조건 동일)
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 2 }, 10500).error.code, 'round-closed');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1 }, 11000).error.code, 'already-closed', '두 번째 마감은 반영 안 됨');
  assert.equal(h.s.pending.picks.p1, 1, '마감 전 확정값만');
});
test('입력 검증: 범위 밖·정수 아님·지난 라운드·지난 시도·비참가자·진행자·시각 없음', () => {
  const h = game(2);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  for (const value of [0, 21, 2.5, -3, Number.NaN, undefined]) {
    assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value }, 1).error.code, 'invalid-number', String(value));
  }
  assert.equal(h.run(P('p1'), { type: 'submit', round: 2, attempt: 1, value: 3 }, 1).error.code, 'stale-round');
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 2, value: 3 }, 1).error.code, 'stale-round');
  assert.equal(h.run(P('p9'), { type: 'submit', round: 1, attempt: 1, value: 3 }, 1).error.code, 'not-player');
  assert.equal(h.run(host, { type: 'submit', round: 1, attempt: 1, value: 3 }, 1).error.code, 'not-player', '진행자는 숫자를 낼 수 없음');
  assert.equal(rules.playerInput.execute(h.s, null, host, { type: 'submit', round: 1, attempt: 1, value: 3 }, { now: 1 }).error.code, 'not-player');
  assert.equal(h.run({ role: 'stranger' }, { type: 'close-round', round: 1, attempt: 1 }, 99999).error.code, 'not-player');
  assert.equal(rules.playerInput.execute(h.s, null, P('p1'), { type: 'submit', round: 1, attempt: 1, value: 3 }, {}).error.code, 'no-clock', '서버 시각 없으면 거부');
  assert.equal(rules.executeAction(h.s, host, { type: 'pause', round: 1, attempt: 1 }).error.code, 'no-clock');
});
test('진행자 전용 행동: 참가자가 시작·일시정지·공개·무효화·종료 불가', () => {
  const h = game(2);
  for (const type of ['start-round', 'end-game']) assert.equal(h.run(P('p1'), { type, round: 1, attempt: 1 }, 0).error.code, 'not-host');
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  for (const type of ['pause', 'resume', 'reveal', 'void-round', 'skip-reveal', 'finish-game']) {
    assert.equal(h.run(P('p1'), { type, round: 1, attempt: 1 }, 1).error.code, 'not-host', type);
  }
});
test('반복 변경 제한: 한 시도에서 30번까지', () => {
  const h = game(2);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  for (let i = 0; i < rules.MAX_REVISIONS; i += 1) h.submit('p1', (i % 2) + 1, i + 1);
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 7 }, 100).error.code, 'too-many-changes');
});

// ── 일시정지 ────────────────────────────────────────────
test('일시정지: 남은 시간 보존, 제출·마감 차단, 재개 후 보존 시간부터', () => {
  const h = game(2, { roundSeconds: 40 });
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  h.must(host, { type: 'pause', round: 1, attempt: 1 }, 15000);
  assert.equal(h.s.pausedRemainingMs, 25000); assert.equal(h.s.deadlineAt, null);
  assert.equal(rules.playerInput.key(h.s), 'r1a1');
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 4 }, 16000).error.code, 'paused');
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1 }, 999999).error.code, 'paused', '일시정지 중 마감 불가');
  assert.equal(h.run(host, { type: 'pause', round: 1, attempt: 1 }, 16000).error.code, 'already-paused');
  h.must(host, { type: 'resume', round: 1, attempt: 1 }, 100000);
  assert.equal(h.s.deadlineAt, 125000);
  assert.ok(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 4 }, 124999).ok);
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 5 }, 125000).error.code, 'deadline-passed');
  assert.equal(h.run(host, { type: 'pause', round: 1, attempt: 1 }, 125000).error.code, 'deadline-passed', '마감 시각 이후 일시정지 불가');
  assert.deepEqual(h.s.audit.map((a) => a.type), ['pause', 'resume']);
});

// ── 결과 공개·중복 채점 방지 ─────────────────────────────
test('결과 공개는 한 번만: 공개 두 번·마감 두 번이 승리를 두 번 더하지 않음', () => {
  const h = game(3);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  h.submit('p1', 2, 1); h.submit('p2', 3, 2);
  h.close(40000);
  assert.equal(h.run(host, { type: 'close-round', round: 1, attempt: 1 }, 40001).ok, false);
  h.reveal(41000);
  assert.equal(h.run(host, { type: 'reveal', round: 1, attempt: 1 }, 41001).ok, false);
  assert.equal(h.s.results.length, 1);
  assert.equal(rules.getResult(h.s).ranking.find((r) => r.playerId === 'p1').wins, 1);
  h.must(host, { type: 'skip-reveal', round: 1 }, 41500);
  const before = h.s;
  h.must(host, { type: 'skip-reveal', round: 1 }, 41600);
  assert.equal(h.s, before, '건너뛰기 반복은 변화 없음');
});
test('라운드 무효화: 마감 후 공개 전만, 새 시도는 이전 입력 미반영, 승리 미반영, 감사 기록', () => {
  const h = game(3);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  h.submit('p1', 1, 1);
  assert.equal(h.run(host, { type: 'void-round', round: 1, attempt: 1 }, 2).error.code, 'stale-round', '진행 중에는 무효화 불가');
  h.close(40000);
  h.must(host, { type: 'void-round', round: 1, attempt: 1 }, 41000);
  assert.equal(h.s.phase, PHASE.LOBBY); assert.equal(h.s.round, 1); assert.equal(h.s.attempt, 2);
  assert.equal(h.s.pending, null);
  assert.deepEqual(h.s.restart, { round: 1, attempt: 2 });
  assert.equal(h.s.audit.at(-1).type, 'void'); assert.equal(h.s.audit.at(-1).submittedCount, 1);
  assert.equal(h.run(P('p1'), { type: 'submit', round: 1, attempt: 1, value: 1 }, 41001).ok, false, '이전 시도 번호로 제출 불가');
  assert.equal(h.run(host, { type: 'start-round', round: 1, attempt: 1 }, 42000).error.code, 'stale-round', '이전 시도 다시 시작 불가');
  h.must(host, { type: 'start-round', round: 1, attempt: 2 }, 42000);
  assert.deepEqual(h.s.restart, { round: 1, attempt: 2 }, '재진행 안내 유지');
  assert.equal(rules.getView(h.s, { role: 'player', playerId: 'p1', input: h.inputs.p1 }).current, null, '이전 시도 입력은 새 시도 화면에 안 보임');
  h.submit('p2', 5, 43000);
  h.close();
  assert.equal(h.s.pending.submittedCount, 1, '무효화된 시도의 p1 입력(1)은 집계 안 됨');
  h.reveal(h.s.closedAt + 1);
  const ranking = rules.getResult(h.s).ranking;
  assert.equal(ranking.find((r) => r.playerId === 'p1').wins, 0);
  assert.equal(ranking.find((r) => r.playerId === 'p2').wins, 1);
  assert.equal(h.s.results.length, 1); assert.equal(h.s.results[0].attempt, 2);
  assert.equal(h.run(host, { type: 'void-round', round: 1, attempt: 2 }, h.s.results[0].revealedAt + 1).ok, false, '공개된 결과는 무효화 불가');
});

// ── 3라운드 전체·순위 ───────────────────────────────────
test('3라운드 전체: 누적 승리·공동 순위·승자 없는 라운드·미참여, 종료 후 행동 거부', () => {
  const h = game(4);
  h.playRound({ p1: 1, p2: 2, p3: 2, p4: 9 }, 0); // 1 → p1
  h.playRound({ p1: 3, p2: 3, p3: 4, p4: 4 }, 100000); // 승자 없음
  assert.equal(h.s.results[1].winningNumber, null); assert.equal(h.s.results[1].winnerId, null);
  h.playRound({ p1: 5, p2: 6, p4: 5 }, 200000); // p3 미참여 (2라운드 입력 4 는 3라운드에 쓰이지 않음), 6 → p2
  assert.equal(h.s.results[2].submittedCount, 3);
  assert.equal(h.s.results[2].picks.p3, undefined, '지난 라운드 입력 재사용 안 함');
  assert.equal(h.run(host, { type: 'start-round', round: 4 }, 300000).ok, false, '4라운드 없음');
  h.must(host, { type: 'finish-game' }, 300000);
  const res = rules.getResult(h.s);
  assert.equal(res.finished, true); assert.equal(res.aborted, false); assert.equal(res.completedRounds, 3);
  assert.deepEqual(res.ranking.map((r) => [r.playerId, r.rank, r.wins]), [['p1', 1, 1], ['p2', 1, 1], ['p3', 3, 0], ['p4', 3, 0]]);
  assert.deepEqual(res.champions.map((c) => c.playerId), ['p1', 'p2'], '공동 우승');
  assert.equal(h.run(host, { type: 'end-game' }, 300001).error.code, 'game-finished');
  assert.equal(h.run(P('p1'), { type: 'submit', round: 3, attempt: 1, value: 1 }, 300001).error.code, 'game-finished');
});
test('finish-game 은 3라운드 공개 후에만, end-game(비상 중단)은 공개된 결과 보존', () => {
  const h = game(2);
  h.playRound({ p1: 1, p2: 1 }, 0);
  assert.equal(h.run(host, { type: 'finish-game' }, 50000).error.code, 'stale-round');
  h.must(host, { type: 'start-round', round: 2 }, 60000);
  h.submit('p1', 1, 61000);
  h.must(host, { type: 'end-game' }, 62000);
  const res = rules.getResult(h.s);
  assert.equal(res.finished, true); assert.equal(res.aborted, true); assert.equal(res.completedRounds, 1);
  assert.equal(h.s.audit.at(-1).type, 'abort');
});

// ── 비공개 정보 분리 ────────────────────────────────────
test('비공개: 진행 중·마감 후 공개 전에는 공개·진행자·다른 참가자 화면에 숫자·분포 없음', () => {
  const h = game(3);
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  h.submit('p1', 17, 1); h.submit('p2', 13, 2);
  const check = (label) => {
    const pub = JSON.stringify(rules.getView(h.s, { role: 'public' }));
    const hostView = JSON.stringify(rules.getView(h.s, { role: 'host' }));
    const p3 = JSON.stringify(rules.getView(h.s, { role: 'player', playerId: 'p3', input: null }));
    for (const [name, text] of [['public', pub], ['host', hostView], ['p3', p3]]) {
      assert.ok(!/17|13/.test(text), `${label}: ${name} 화면에 다른 참가자 숫자 노출: ${text}`);
      assert.ok(!text.includes('distribution') && !text.includes('picks'), `${label}: ${name} 에 분포 노출`);
    }
    const p1 = rules.getView(h.s, { role: 'player', playerId: 'p1', input: h.inputs.p1 });
    assert.equal(p1.current.number, 17, '본인 숫자는 본인 화면에만');
    assert.ok(!JSON.stringify(p1).includes('13'));
  };
  check('진행 중');
  assert.equal(rules.getView(h.s, { role: 'public' }).inputKey, 'r1a1');
  h.close(40000);
  check('마감 후 공개 전');
  assert.ok(!JSON.stringify(h.s.pending).includes('undefined'));
  h.reveal(41000);
  const pub = rules.getView(h.s, { role: 'public' });
  assert.equal(pub.results[0].distribution[12], 1, '공개 후 분포 공개');
  assert.equal(pub.results[0].winningNumber, 13);
  assert.ok(!('picks' in pub.results[0]), '공개 후에도 개인별 선택 목록은 공개 안 함');
  assert.deepEqual(rules.getView(h.s, { role: 'player', playerId: 'p3', input: null }).history, [{ round: 1, number: null }], '미참여 기록');
});
test('입력 불변: executeAction·playerInput.execute 는 이전 상태·입력을 바꾸지 않음', () => {
  const h = game(2);
  const frozen = JSON.stringify(h.s);
  const s0 = h.s;
  h.must(host, { type: 'start-round', round: 1, attempt: 1 }, 0);
  assert.equal(JSON.stringify(s0), frozen);
  const first = h.submit('p1', 3, 1).input;
  const firstJson = JSON.stringify(first);
  h.submit('p1', 4, 2);
  assert.equal(JSON.stringify(first), firstJson);
});
test('로컬 연결부도 같은 개인 입력 경로로 판정 (플랫폼 공통 계약)', async () => {
  const session = createLocalSession({ rules, players: players(3), config: { roundSeconds: 5 }, hostActions: ['start-round', 'close-round'] });
  await session.send({ type: 'start-round', round: 1, attempt: 1 });
  assert.ok((await session.send({ type: 'submit', round: 1, attempt: 1, value: 4 }, { playerId: 'p1' })).ok);
  assert.ok((await session.send({ type: 'submit', round: 1, attempt: 1, value: 4 }, { playerId: 'p2' })).ok);
  let snap; const off = session.subscribe((s) => { snap = s; }); off();
  assert.equal(snap.inputCounts.r1a1, 2);
});
