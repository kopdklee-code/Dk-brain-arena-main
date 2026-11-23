// 단 하나의 숫자 — 규칙 원본 (순수 함수).
// DOM·Firebase·네트워크·저장소·시계·난수를 직접 쓰지 않는다. 시각은 서버(또는 로컬 연결부)가 ctx.now 로 넘긴다.
//
// 판정 (지시문 v1.1 §1.2, 변경 금지)
//   1~20 중 하나 선택 → 2명 이상이 고른 숫자는 무효 → 정확히 1명이 고른 숫자만 유효
//   → 유효 숫자 중 가장 작은 숫자를 고른 참가자가 그 라운드 1승 → 유효 숫자가 없으면 승자 없음
//   → 3라운드 누적 승리 횟수로 순위, 같으면 공동 순위. 탈락 없음. 보너스·가중치·동점 해소 없음.

export const PHASE = Object.freeze({
  LOBBY: 'LOBBY', // 게임 시작 후 라운드 시작 전 (규칙 설명·다음 라운드 대기·재진행 대기)
  ACTIVE: 'ROUND_ACTIVE',
  CLOSED: 'ROUND_CLOSED', // 마감·판정 확정, 공개 전 (판정 결과는 서버 전용 상태에만 있음)
  RESULT: 'ROUND_RESULT',
  FINISHED: 'GAME_FINISHED',
});

export const MIN_NUMBER = 1;
export const MAX_NUMBER = 20;
export const TOTAL_ROUNDS = 3;
export const DEFAULT_ROUND_SECONDS = 40;
export const ROUND_SECONDS_RANGE = Object.freeze({ min: 5, max: 120 });
/** 한 라운드 시도에서 한 참가자가 숫자를 바꿀 수 있는 최대 횟수 (반복 요청 제한) */
export const MAX_REVISIONS = 30;

const err = (code, message) => ({ ok: false, error: { code, message } });
const ok = (state) => ({ ok: true, state });

// ── 판정 엔진 ───────────────────────────────────────────
/**
 * 숫자 목록 → 숫자별 선택 인원과 승리 숫자.
 * @param {number[]} numbers 제출된 숫자(미참여는 포함하지 않음)
 * @returns {{ distribution:number[], winningNumber:number|null, validNumbers:number[] }}
 *   distribution[i] = 숫자 i+1 을 고른 인원
 */
export function judge(numbers, maxNumber = MAX_NUMBER) {
  const distribution = Array.from({ length: maxNumber }, () => 0);
  for (const n of numbers) {
    if (!isValidNumber(n, maxNumber)) throw new Error(`판정 입력 숫자 범위 밖: ${n}`);
    distribution[n - 1] += 1;
  }
  const validNumbers = [];
  distribution.forEach((count, i) => { if (count === 1) validNumbers.push(i + 1); });
  return { distribution, winningNumber: validNumbers.length ? validNumbers[0] : null, validNumbers };
}

export function isValidNumber(n, maxNumber = MAX_NUMBER) {
  return Number.isInteger(n) && n >= MIN_NUMBER && n <= maxNumber;
}

/** 공개 확정된 라운드 결과만으로 누적 승리·공동 순위를 계산 (증가 연산 없이 매번 집계) */
export function standings(players, results) {
  const wins = new Map(players.map((p) => [p.id, 0]));
  for (const r of results) if (r.winnerId && wins.has(r.winnerId)) wins.set(r.winnerId, wins.get(r.winnerId) + 1);
  const list = players.map((p) => ({ playerId: p.id, name: p.name, wins: wins.get(p.id) }));
  for (const entry of list) entry.rank = 1 + list.filter((o) => o.wins > entry.wins).length;
  // 같은 순위 안의 표시 순서는 입장 순서(playerId)일 뿐 순위 기준이 아님
  const seat = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  return list.sort((a, b) => a.rank - b.rank || seat(a.playerId) - seat(b.playerId));
}

// ── 계약 함수 ───────────────────────────────────────────
export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return err('invalid-config', '설정 형식이 올바르지 않습니다.');
  const roundSeconds = input.roundSeconds ?? DEFAULT_ROUND_SECONDS;
  if (!Number.isInteger(roundSeconds) || roundSeconds < ROUND_SECONDS_RANGE.min || roundSeconds > ROUND_SECONDS_RANGE.max) {
    return err('invalid-config', `라운드 선택 시간은 ${ROUND_SECONDS_RANGE.min}~${ROUND_SECONDS_RANGE.max}초 정수입니다.`);
  }
  if ('totalRounds' in input && input.totalRounds !== TOTAL_ROUNDS) return err('invalid-config', `이 게임은 ${TOTAL_ROUNDS}라운드로 진행합니다.`);
  if ('maxNumber' in input && input.maxNumber !== MAX_NUMBER) return err('invalid-config', `숫자 범위는 1~${MAX_NUMBER}입니다.`);
  return { ok: true, config: { totalRounds: TOTAL_ROUNDS, minNumber: MIN_NUMBER, maxNumber: MAX_NUMBER, roundSeconds } };
}

export function createGame({ players, config, now } = {}) {
  const normalized = normalizeConfig(config || {});
  if (!normalized.ok) return normalized;
  if (!Array.isArray(players) || players.length < 1) return err('invalid-players', '참가자가 없습니다.');
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) return err('invalid-players', '참가자 ID가 중복되었습니다.');
  return ok({
    gameId: 'unique-number',
    config: normalized.config,
    players: players.map((p) => ({ id: String(p.id), name: String(p.name) })),
    phase: PHASE.LOBBY,
    round: 1,
    attempt: 1,
    deadlineAt: null,
    pausedRemainingMs: null,
    roundStartedAt: null,
    closedAt: null,
    pending: null, // 마감 시 확정한 판정 (공개 전, 서버 전용)
    results: [], // 공개 확정된 라운드 결과 (라운드당 1개)
    audit: [], // 진행자용 감사 기록 (무효화·일시정지·재개·중단)
    restart: null, // { round, attempt } 재진행 안내
    revealSkipped: false,
    ended: null,
    startedAt: Number.isFinite(now) ? now : null,
  });
}

const isPaused = (s) => s.pausedRemainingMs !== null;
const sameAttempt = (s, a) => a.round === s.round && a.attempt === s.attempt;
/** 현재 시도에 해당하는 입력만 유효 (지난 시도·지난 라운드 입력은 무시 — 재사용 안 함) */
const currentInput = (s, input) => (input && input.round === s.round && input.attempt === s.attempt ? input : null);
function currentPicks(state, inputs = {}) {
  const picks = {};
  for (const p of state.players) {
    const input = currentInput(state, inputs[p.id]);
    if (input && isValidNumber(input.number, state.config.maxNumber)) picks[p.id] = input.number;
  }
  return picks;
}

// ── 참가자 개인 입력 (플랫폼 playerInput 계약) ──────────────
// 숫자 제출은 참가자별 서버 전용 입력 문서에 저장된다. 공유 상태는 읽기만 하므로 동시 제출끼리 경합하지 않는다.
// 마감(close-round) 때 플랫폼이 모든 입력을 ctx.inputs 로 넘기고, 규칙이 현재 시도의 입력만 집계한다.
export const playerInput = Object.freeze({
  actions: Object.freeze(['submit']),
  /** 화면 제출 인원 집계용 현재 입력 창 키 (라운드·시도) */
  key: (state) => (state.phase === PHASE.ACTIVE ? `r${state.round}a${state.attempt}` : null),
  /**
   * @returns {{ok:true, input:object, newInWindow:boolean} | {ok:false, error}}
   */
  execute(state, input, actor, action, ctx = {}) {
    const now = ctx.now;
    if (!Number.isFinite(now)) return err('no-clock', '서버 시각이 없어 처리할 수 없습니다.');
    const player = actor?.role === 'player' ? state.players.find((p) => p.id === actor.playerId) : null;
    if (!player) return err('not-player', '이 게임의 참가자만 제출할 수 있습니다.');
    if (action?.type !== 'submit') return err('unknown-action', '알 수 없는 행동입니다.');
    if (state.phase === PHASE.FINISHED) return err('game-finished', '이미 종료된 게임입니다.');
    if (state.phase !== PHASE.ACTIVE || !sameAttempt(state, action)) {
      return err(state.phase === PHASE.ACTIVE ? 'stale-round' : 'round-closed', '선택이 마감되었습니다. 지금은 제출할 수 없습니다.');
    }
    if (isPaused(state)) return err('paused', '일시정지 중에는 제출·변경할 수 없습니다.');
    if (now >= state.deadlineAt) return err('deadline-passed', '선택 시간이 끝났습니다. 마감 이후 제출은 인정되지 않습니다.');
    if (!isValidNumber(action.value, state.config.maxNumber)) return err('invalid-number', `1~${state.config.maxNumber} 사이의 정수만 낼 수 있습니다.`);
    const prev = currentInput(state, input);
    if (prev && prev.number === action.value) return { ok: true, input: prev, newInWindow: false }; // 같은 숫자 재제출: 변경 없음
    if (prev && prev.revision >= MAX_REVISIONS) return err('too-many-changes', `한 라운드에 ${MAX_REVISIONS}번까지만 바꿀 수 있습니다.`);
    return {
      ok: true,
      newInWindow: !prev,
      input: { round: state.round, attempt: state.attempt, number: action.value, revision: (prev?.revision || 0) + 1, at: now },
    };
  },
});

function closeOf(state, now, inputs) {
  const picks = currentPicks(state, inputs);
  const { distribution, winningNumber, validNumbers } = judge(Object.values(picks), state.config.maxNumber);
  const winnerId = winningNumber === null ? null : Object.keys(picks).find((pid) => picks[pid] === winningNumber);
  const winner = state.players.find((p) => p.id === winnerId);
  return {
    round: state.round,
    attempt: state.attempt,
    distribution,
    winningNumber,
    winnerId: winnerId ?? null,
    winnerName: winner ? winner.name : null,
    submittedCount: Object.keys(picks).length,
    validCount: validNumbers.length,
    participantCount: state.players.length,
    picks, // 참가자별 최종 선택 — 서버 전용 (본인 것만 개인 화면에 전달)
    finalizedAt: now,
  };
}

/**
 * @param {object} state
 * @param {{role:'host'|'player'|'local', playerId?:string}} actor
 * @param {{type:string, round?:number, attempt?:number, value?:number}} action
 * @param {{now:number, inputs?:object}} ctx 서버 시각(ms), 참가자별 입력 { playerId: input }
 */
export function executeAction(state, actor, action, ctx = {}) {
  const now = ctx.now;
  const inputs = ctx.inputs || {};
  if (!Number.isFinite(now)) return err('no-clock', '서버 시각이 없어 처리할 수 없습니다.');
  if (!action || typeof action.type !== 'string') return err('invalid-action', '행동 형식이 올바르지 않습니다.');
  if (state.phase === PHASE.FINISHED) return err('game-finished', '이미 종료된 게임입니다.');
  const isHost = actor?.role === 'host' || actor?.role === 'local';
  const player = actor?.role === 'player' ? state.players.find((p) => p.id === actor.playerId) : null;
  const hostOnly = () => (isHost ? null : err('not-host', '진행자만 할 수 있습니다.'));

  switch (action.type) {
    case 'start-round': {
      const denied = hostOnly(); if (denied) return denied;
      let round; let attempt;
      if (state.phase === PHASE.LOBBY && sameAttempt(state, action)) { round = state.round; attempt = state.attempt; }
      else if (state.phase === PHASE.RESULT && action.round === state.round + 1 && state.round < state.config.totalRounds) { round = state.round + 1; attempt = 1; }
      else return err('stale-round', '지금 시작할 수 있는 라운드가 아닙니다.');
      return ok({
        ...state, phase: PHASE.ACTIVE, round, attempt,
        deadlineAt: now + state.config.roundSeconds * 1000, pausedRemainingMs: null,
        roundStartedAt: now, closedAt: null, pending: null, revealSkipped: false,
        restart: state.restart && state.restart.round === round ? state.restart : null,
      });
    }

    case 'submit':
      // 숫자 제출은 참가자 개인 입력 경로(playerInput.execute)로만 처리한다
      return err('not-player', '이 게임의 참가자만 제출할 수 있습니다.');

    case 'close-round': {
      // 서버 시각으로 마감 시각이 지난 뒤에만 확정 (진행자 또는 참가자 화면이 요청, 여러 번 와도 한 번만 반영)
      if (!isHost && !player) return err('not-player', '이 게임의 참가자가 아닙니다.');
      if (state.phase !== PHASE.ACTIVE || !sameAttempt(state, action)) return err('already-closed', '이미 마감된 라운드입니다.');
      if (isPaused(state)) return err('paused', '일시정지 중에는 마감할 수 없습니다.');
      if (now < state.deadlineAt) return err('too-early', '아직 선택 시간이 남아 있습니다.');
      return ok({ ...state, phase: PHASE.CLOSED, closedAt: now, pending: closeOf(state, now, inputs) });
    }

    case 'pause': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.ACTIVE || !sameAttempt(state, action)) return err('stale-round', '진행 중인 라운드에서만 일시정지할 수 있습니다.');
      if (isPaused(state)) return err('already-paused', '이미 일시정지 상태입니다.');
      if (now >= state.deadlineAt) return err('deadline-passed', '선택 시간이 이미 끝났습니다.');
      const remaining = state.deadlineAt - now;
      return ok({
        ...state, deadlineAt: null, pausedRemainingMs: remaining,
        audit: [...state.audit, { type: 'pause', round: state.round, attempt: state.attempt, at: now, remainingMs: remaining }],
      });
    }

    case 'resume': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.ACTIVE || !sameAttempt(state, action)) return err('stale-round', '진행 중인 라운드가 아닙니다.');
      if (!isPaused(state)) return err('not-paused', '일시정지 상태가 아닙니다.');
      return ok({
        ...state, deadlineAt: now + state.pausedRemainingMs, pausedRemainingMs: null,
        audit: [...state.audit, { type: 'resume', round: state.round, attempt: state.attempt, at: now, remainingMs: state.pausedRemainingMs }],
      });
    }

    case 'reveal': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.CLOSED || !sameAttempt(state, action)) return err('stale-round', '공개할 마감 결과가 없습니다.');
      return ok({
        ...state, phase: PHASE.RESULT, pending: null, revealSkipped: false, restart: null,
        results: [...state.results, { ...state.pending, revealedAt: now }],
      });
    }

    case 'skip-reveal': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.RESULT || action.round !== state.round) return err('stale-round', '공개 중인 결과가 아닙니다.');
      return state.revealSkipped ? ok(state) : ok({ ...state, revealSkipped: true });
    }

    case 'void-round': {
      // 마감 후 공개 전에만: 이번 시도를 점수에서 빼고 같은 라운드 번호로 새 시도 (제출값 재사용 안 함)
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.CLOSED || !sameAttempt(state, action)) return err('stale-round', '마감 후 공개 전 라운드만 무효화할 수 있습니다.');
      const attempt = state.attempt + 1;
      return ok({
        ...state, phase: PHASE.LOBBY, attempt, deadlineAt: null, pausedRemainingMs: null, closedAt: null,
        pending: null, restart: { round: state.round, attempt },
        audit: [...state.audit, { type: 'void', round: state.round, attempt: state.attempt, at: now, submittedCount: Object.keys(currentPicks(state, inputs)).length }],
      });
    }

    case 'finish-game': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.RESULT || state.round !== state.config.totalRounds) return err('stale-round', '마지막 라운드 결과 공개 후에 최종 결과를 발표할 수 있습니다.');
      return ok({ ...state, phase: PHASE.FINISHED, ended: { reason: 'completed', at: now } });
    }

    case 'end-game': {
      // 비상 중단: 공개된 결과는 그대로 두고(덮어쓰지 않음) 게임을 끝낸다. 공개 전 판정·진행 중 제출은 반영하지 않는다.
      const denied = hostOnly(); if (denied) return denied;
      return ok({
        ...state, phase: PHASE.FINISHED, deadlineAt: null, pausedRemainingMs: null, pending: null,
        ended: { reason: 'aborted', at: now, phase: state.phase, round: state.round },
        audit: [...state.audit, { type: 'abort', round: state.round, attempt: state.attempt, at: now, phase: state.phase }],
      });
    }

    default:
      return err('unknown-action', '알 수 없는 행동입니다.');
  }
}

/** 공개 결과 (판정 원자료 picks 는 제외) */
function publicResult(r) {
  const { picks, ...rest } = r;
  return rest;
}

/**
 * viewer 별로 허용된 정보만.
 *  public: 상태·인원·제출 인원·마감 시각·공개된 결과·누적 승리 (진행 중 숫자·분포 없음)
 *  host:   감사 기록 (진행 중 숫자 없음 — 힌트 노출 방지)
 *  player: 본인 제출(viewer.input — 플랫폼이 본인 입력만 넘김)·본인 지난 선택만
 */
export function getView(state, viewer = { role: 'public' }) {
  if (viewer.role === 'player') {
    const me = state.players.find((p) => p.id === viewer.playerId);
    const sub = state.phase === PHASE.ACTIVE || state.phase === PHASE.CLOSED ? currentInput(state, viewer.input) : null;
    return {
      playerId: viewer.playerId,
      name: me ? me.name : null,
      round: state.round,
      attempt: state.attempt,
      current: sub ? { number: sub.number, revision: sub.revision } : null,
      history: state.results.map((r) => ({ round: r.round, number: r.picks[viewer.playerId] ?? null })),
    };
  }
  if (viewer.role === 'host') {
    return { role: 'host', audit: state.audit };
  }
  // 진행 중 제출 인원은 플랫폼 화면 집계(inputCounts[inputKey])로 표시하고, 마감 후에는 확정 판정의 인원을 쓴다
  const submittedCount = state.phase === PHASE.CLOSED && state.pending ? state.pending.submittedCount : null;
  return {
    phase: state.phase,
    inputKey: playerInput.key(state),
    round: state.round,
    attempt: state.attempt,
    totalRounds: state.config.totalRounds,
    roundSeconds: state.config.roundSeconds,
    maxNumber: state.config.maxNumber,
    playerCount: state.players.length,
    submittedCount,
    deadlineAt: state.deadlineAt,
    paused: isPaused(state),
    pausedRemainingMs: state.pausedRemainingMs,
    closedAt: state.closedAt,
    results: state.results.map(publicResult),
    revealSkipped: state.revealSkipped,
    restart: state.restart,
    ended: state.ended,
    standings: standings(state.players, state.results),
  };
}

export function getResult(state) {
  const ranking = standings(state.players, state.results);
  const top = ranking.filter((r) => r.rank === 1 && r.wins > 0);
  return {
    finished: state.phase === PHASE.FINISHED,
    aborted: state.ended?.reason === 'aborted',
    completedRounds: state.results.length,
    totalRounds: state.config.totalRounds,
    ranking: ranking.map((r) => ({ rank: r.rank, playerId: r.playerId, name: r.name, wins: r.wins })),
    champions: top.map((r) => ({ playerId: r.playerId, name: r.name, wins: r.wins })),
  };
}
