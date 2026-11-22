// 숫자 선택 샘플(demo-number-choice) — 게임 규칙 원본.
// 이 파일은 DOM·Firebase SDK·네트워크·브라우저 저장소·시간·난수를 사용하지 않는 순수 함수만 둔다.
// 플랫폼(브라우저), Cloud Functions(서버), 오프라인 standalone.html 이 모두 이 원본을 빌드해 사용한다.

export const CHOICES = Object.freeze([1, 2, 3]);
export const TOTAL_ROUNDS = 3;
export const PLAYER_COUNT = 2;

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 설정 정규화. 샘플은 3라운드 고정이며, 이 값은 플랫폼 전체 제한이 아니다. */
export function normalizeConfig(input = {}) {
  const totalRounds = input.totalRounds ?? TOTAL_ROUNDS;
  if (totalRounds !== TOTAL_ROUNDS) {
    return fail('invalid-config', `이 샘플은 ${TOTAL_ROUNDS}라운드로만 진행합니다.`);
  }
  return { ok: true, config: { totalRounds } };
}

/**
 * 초기 상태 생성.
 * @param {{players: {id:string, name:string}[], config?: object}} input
 */
export function createGame({ players, config } = {}) {
  const normalized = normalizeConfig(config);
  if (!normalized.ok) return normalized;
  if (!Array.isArray(players) || players.length !== PLAYER_COUNT) {
    return fail('invalid-players', `이 샘플은 플레이어 ${PLAYER_COUNT}명이 필요합니다.`);
  }
  const ids = new Set();
  for (const p of players) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') {
      return fail('invalid-players', '플레이어 정보가 올바르지 않습니다.');
    }
    if (ids.has(p.id)) return fail('invalid-players', '플레이어 ID가 중복되었습니다.');
    ids.add(p.id);
  }
  const submissions = {};
  const scores = {};
  for (const p of players) {
    submissions[p.id] = null;
    scores[p.id] = 0;
  }
  return {
    ok: true,
    state: {
      schema: 1,
      totalRounds: normalized.config.totalRounds,
      round: 1,
      phase: 'choosing',
      players: players.map((p) => ({ id: p.id, name: p.name })),
      submissions,
      scores,
      history: [],
    },
  };
}

function hasPlayer(state, playerId) {
  return state.players.some((p) => p.id === playerId);
}

/**
 * 행동 검증과 상태 변경. 입력 state 는 변경하지 않고 새 state 를 돌려준다.
 * @param {object} state
 * @param {{role:'host'|'player', playerId?:string}} actor
 * @param {{type:string, round?:number, value?:number}} action
 */
export function executeAction(state, actor, action) {
  if (!state || state.schema !== 1) return fail('invalid-state', '게임 상태가 올바르지 않습니다.');
  if (!actor || !action || typeof action.type !== 'string') {
    return fail('invalid-action', '행동 형식이 올바르지 않습니다.');
  }
  if (state.phase === 'finished') return fail('game-finished', '이미 종료된 게임입니다.');

  switch (action.type) {
    case 'choose': {
      if (actor.role !== 'player' || !hasPlayer(state, actor.playerId)) {
        return fail('not-player', '플레이어만 숫자를 제출할 수 있습니다.');
      }
      if (action.round !== state.round) {
        return fail('stale-round', `현재 라운드(${state.round})가 아닌 제출입니다.`);
      }
      if (!CHOICES.includes(action.value)) {
        return fail('invalid-choice', '1, 2, 3 중 하나만 제출할 수 있습니다.');
      }
      if (state.submissions[actor.playerId] !== null) {
        return fail('already-submitted', '이번 라운드에 이미 제출했습니다.');
      }
      const next = clone(state);
      next.submissions[actor.playerId] = action.value;
      return { ok: true, state: next };
    }
    case 'closeRound': {
      if (actor.role !== 'host') return fail('not-host', '진행자만 라운드를 마감할 수 있습니다.');
      if (action.round !== state.round) {
        return fail('stale-round', `현재 라운드(${state.round})가 아닌 마감 요청입니다.`);
      }
      const next = clone(state);
      const choices = {};
      const gained = {};
      for (const p of next.players) {
        const value = next.submissions[p.id];
        choices[p.id] = value;
        gained[p.id] = value === null ? 0 : value; // 미제출은 0점
        next.scores[p.id] += gained[p.id];
        next.submissions[p.id] = null;
      }
      next.history.push({ round: state.round, choices, gained });
      if (state.round >= state.totalRounds) {
        next.phase = 'finished';
      } else {
        next.round = state.round + 1;
      }
      return { ok: true, state: next };
    }
    default:
      return fail('unknown-action', `알 수 없는 행동입니다: ${action.type}`);
  }
}

/**
 * 보는 사람에게 허용된 정보만 만든다.
 * 이 샘플은 제출된 선택이 공개 정보이므로 비공개 항목이 없다.
 * @param {object} state
 * @param {{role:'public'|'host'|'player'|'local', playerId?:string}} viewer
 */
export function getView(state, viewer = { role: 'public' }) {
  const base = {
    round: state.round,
    totalRounds: state.totalRounds,
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: state.scores[p.id],
      submitted: state.submissions[p.id] !== null,
      choice: state.submissions[p.id],
    })),
    history: clone(state.history),
    choices: [...CHOICES],
  };
  if (viewer.role === 'player') {
    const me = state.players.find((p) => p.id === viewer.playerId);
    base.me = me ? me.id : null;
    base.canSubmit = Boolean(me) && state.phase === 'choosing' && state.submissions[me.id] === null;
  }
  if (viewer.role === 'host' || viewer.role === 'local') {
    base.canClose = state.phase === 'choosing';
  }
  return base;
}

/** 종료 결과. 누적 점수 내림차순, 동점은 공동 순위(1, 1, 3 방식). */
export function getResult(state) {
  const rows = state.players.map((p) => ({ playerId: p.id, name: p.name, score: state.scores[p.id] }));
  rows.sort((a, b) => b.score - a.score);
  let rank = 0;
  let prevScore = null;
  rows.forEach((row, index) => {
    if (row.score !== prevScore) {
      rank = index + 1;
      prevScore = row.score;
    }
    row.rank = rank;
  });
  return { finished: state.phase === 'finished', totalRounds: state.totalRounds, ranking: rows };
}
