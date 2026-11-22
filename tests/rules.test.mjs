// 규칙 원본 단위 테스트 + 로컬 연결부 + 생성된 Functions 번들이 원본과 같은 판정을 하는지 확인
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/games/demo-number-choice/rules.js';
import { createLocalSession } from '../src/adapters/local-session.js';
import { GAMES } from '../src/games/registry.js';
import { sanitizeAction, normalizeCode, normalizeNickname } from '../src/shared/validation.js';
import { SEQUENCES, runLocal } from './fixtures/sequences.mjs';

const PLAYERS = [{ id: 'p1', name: '가' }, { id: 'p2', name: '나' }];
const host = { role: 'host' };
const p1 = { role: 'player', playerId: 'p1' };
const p2 = { role: 'player', playerId: 'p2' };

function start() {
  const r = rules.createGame({ players: PLAYERS, config: {} });
  assert.equal(r.ok, true);
  return r.state;
}
function must(res) {
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return res.state;
}

test('초기 상태: 2명·3라운드·0점', () => {
  const s = start();
  assert.equal(s.round, 1);
  assert.equal(s.totalRounds, 3);
  assert.deepEqual(s.scores, { p1: 0, p2: 0 });
});

test('인원·설정 검증', () => {
  assert.equal(rules.createGame({ players: [PLAYERS[0]] }).error.code, 'invalid-players');
  assert.equal(rules.createGame({ players: [...PLAYERS, { id: 'p3', name: '다' }] }).error.code, 'invalid-players');
  assert.equal(rules.createGame({ players: [PLAYERS[0], { id: 'p1', name: 'x' }] }).error.code, 'invalid-players');
  assert.equal(rules.createGame({ players: PLAYERS, config: { totalRounds: 5 } }).error.code, 'invalid-config');
});

test('제출·마감 시 선택한 숫자만큼 점수, 미제출 0점', () => {
  let s = start();
  s = must(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 3 }));
  s = must(rules.executeAction(s, host, { type: 'closeRound', round: 1 }));
  assert.deepEqual(s.scores, { p1: 3, p2: 0 });
  assert.equal(s.round, 2);
  assert.deepEqual(s.history[0].gained, { p1: 3, p2: 0 });
  assert.equal(s.history[0].choices.p2, null);
});

test('입력 상태는 변경하지 않는다 (순수 함수)', () => {
  const s = start();
  const before = JSON.stringify(s);
  rules.executeAction(s, p1, { type: 'choose', round: 1, value: 2 });
  assert.equal(JSON.stringify(s), before);
});

test('중복 제출·반복 마감·지난 라운드 제출 거부', () => {
  let s = start();
  s = must(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 2 }));
  assert.equal(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 3 }).error.code, 'already-submitted');
  s = must(rules.executeAction(s, host, { type: 'closeRound', round: 1 }));
  assert.equal(rules.executeAction(s, host, { type: 'closeRound', round: 1 }).error.code, 'stale-round');
  assert.equal(rules.executeAction(s, p2, { type: 'choose', round: 1, value: 3 }).error.code, 'stale-round');
  assert.deepEqual(s.scores, { p1: 2, p2: 0 });
});

test('권한·형식 검증', () => {
  const s = start();
  assert.equal(rules.executeAction(s, host, { type: 'choose', round: 1, value: 1 }).error.code, 'not-player');
  assert.equal(rules.executeAction(s, { role: 'player', playerId: 'p9' }, { type: 'choose', round: 1, value: 1 }).error.code, 'not-player');
  assert.equal(rules.executeAction(s, p1, { type: 'closeRound', round: 1 }).error.code, 'not-host');
  assert.equal(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 4 }).error.code, 'invalid-choice');
  assert.equal(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 1.5 }).error.code, 'invalid-choice');
  assert.equal(rules.executeAction(s, p1, { type: 'hack' }).error.code, 'unknown-action');
});

test('3라운드 후 종료, 이후 행동 거부, 동점 공동 순위', () => {
  let s = start();
  for (let r = 1; r <= 3; r += 1) {
    s = must(rules.executeAction(s, p1, { type: 'choose', round: r, value: 2 }));
    s = must(rules.executeAction(s, p2, { type: 'choose', round: r, value: 2 }));
    s = must(rules.executeAction(s, host, { type: 'closeRound', round: r }));
  }
  assert.equal(s.phase, 'finished');
  assert.equal(rules.executeAction(s, host, { type: 'closeRound', round: 3 }).error.code, 'game-finished');
  const result = rules.getResult(s);
  assert.equal(result.finished, true);
  assert.deepEqual(result.ranking.map((r) => [r.playerId, r.score, r.rank]), [['p1', 6, 1], ['p2', 6, 1]]);
});

test('getView: 역할별 정보 (player 는 me/canSubmit, host 는 canClose)', () => {
  let s = start();
  s = must(rules.executeAction(s, p1, { type: 'choose', round: 1, value: 1 }));
  const pv = rules.getView(s, { role: 'player', playerId: 'p1' });
  assert.equal(pv.me, 'p1');
  assert.equal(pv.canSubmit, false);
  assert.equal(rules.getView(s, { role: 'player', playerId: 'p2' }).canSubmit, true);
  assert.equal(rules.getView(s, { role: 'host' }).canClose, true);
  const pub = rules.getView(s, { role: 'public' });
  assert.equal('me' in pub, false);
  assert.equal('canClose' in pub, false);
});

test('로컬 연결부: 같은 계약(subscribe/send)으로 진행', async () => {
  const session = createLocalSession({ rules, players: PLAYERS, config: {} });
  const seen = [];
  const off = session.subscribe((snap) => seen.push(snap.view.round));
  assert.equal((await session.send({ type: 'choose', round: 1, value: 3 }, { playerId: 'p1' })).ok, true);
  assert.equal((await session.send({ type: 'choose', round: 1, value: 3 }, { playerId: 'p1' })).error.code, 'already-submitted');
  assert.equal((await session.send({ type: 'closeRound', round: 1 })).ok, true);
  off();
  assert.deepEqual(session.getState().scores, { p1: 3, p2: 0 });
  assert.ok(seen.length >= 3);
});

test('생성된 Functions 번들이 원본과 같은 결과를 낸다', async () => {
  const bundle = await import('../functions/generated/games.js');
  const bundled = bundle.getGame('demo-number-choice');
  assert.ok(bundled, '번들에 demo-number-choice 가 없습니다 (npm run build:functions 필요)');
  assert.equal(bundled.manifest.gameVersion, GAMES['demo-number-choice'].manifest.gameVersion);
  for (const seq of SEQUENCES) {
    const a = runLocal(rules, seq);
    const b = runLocal(bundled.rules, seq);
    assert.deepEqual(b, a, seq.name);
  }
});

test('입력 형식 정리', () => {
  assert.deepEqual(sanitizeAction({ type: 'choose', round: 1, value: 2, extra: 'x' }), { type: 'choose', round: 1, value: 2 });
  assert.equal(sanitizeAction({ type: 'choose', value: '2' }), null);
  assert.equal(normalizeCode(' abc-def '), 'ABCDEF'); // 공백·하이픈 제거, 대문자화
  assert.equal(normalizeCode('ABCDE0'), null); // 0/O/1/I 등 모호 문자는 코드 알파벳에 없음
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode('ab2c3d'), 'AB2C3D');
  assert.equal(normalizeNickname('  철수  '), '철수');
  assert.equal(normalizeNickname(''), null);
  assert.equal(normalizeNickname('가'.repeat(13)), null);
});
