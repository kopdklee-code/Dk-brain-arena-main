// 가위바위보 하나빼기 — 규칙 원본 (순수 함수).
// DOM·Firebase·네트워크·저장소·시계·난수를 직접 쓰지 않는다. 시각은 서버(또는 로컬 연결부)가 ctx.now 로 넘긴다.
//
// 규칙 (사용자 확정)
//   진행자 1명과 살아 있는 참가자 전원이 겨룬다. 매 라운드:
//   ① 두 손 내기: 서로 다른 손 두 개(바위·가위·보 중 2개)를 낸다. 진행자도 두 손을 고른다.
//   ② 하나 빼기: 진행자의 두 손이 공개되고, 각자 자기 두 손 중 하나를 남긴다. 진행자도 하나를 남긴다.
//   ③ 진행자의 남긴 손을 **이긴 사람만 생존**. 비기거나 지면 탈락. 어느 단계든 내지 않으면 탈락.
//   ④ 살아 있는 전원이 탈락하게 되면 그 라운드의 탈락은 취소(전원 생존).
//   ⑤ 최후의 1인이 남을 때까지 라운드를 반복한다.

export const PHASE = Object.freeze({
  LOBBY: 'LOBBY', // 게임 시작 후 라운드 시작 전 (규칙 설명·재진행 대기)
  PICK_TWO: 'PICK_TWO', // ① 두 손 내기
  PICK_ONE: 'PICK_ONE', // ② 하나 빼기 (진행자 두 손 공개)
  CLOSED: 'ROUND_CLOSED', // 마감·판정 확정, 공개 전 (판정은 서버 전용 상태에만 있음)
  RESULT: 'ROUND_RESULT',
  FINISHED: 'GAME_FINISHED',
});

export const ROCK = 1;
export const SCISSORS = 2;
export const PAPER = 3;
export const HANDS = Object.freeze([ROCK, SCISSORS, PAPER]);
export const HAND_NAME = Object.freeze({ 1: '바위', 2: '가위', 3: '보' });
/** BEATS[a] = a 가 이기는 손 */
const BEATS = Object.freeze({ [ROCK]: SCISSORS, [SCISSORS]: PAPER, [PAPER]: ROCK });

export const DEFAULTS = Object.freeze({ twoSeconds: 20, oneSeconds: 15 });
export const SECONDS_RANGE = Object.freeze({ min: 5, max: 120 });
/** 한 단계에서 한 참가자가 선택을 바꿀 수 있는 최대 횟수 (반복 요청 제한) */
export const MAX_REVISIONS = 30;

const err = (code, message) => ({ ok: false, error: { code, message } });
const ok = (state) => ({ ok: true, state });

// ── 판정 ───────────────────────────────────────────────
export function isHand(h) { return HANDS.includes(h); }

/** 내 손(me)과 진행자 손(host)의 결과: 'win' | 'draw' | 'lose' */
export function outcome(me, host) {
  if (!isHand(me) || !isHand(host)) throw new Error('손 값이 올바르지 않습니다.');
  if (me === host) return 'draw';
  return BEATS[me] === host ? 'win' : 'lose';
}

/** 두 손 코드(12·13·23, 순서 무관 21·31·32) → 정렬된 [a,b]. 같은 손 두 개·범위 밖은 null */
export function decodePair(code) {
  if (!Number.isInteger(code)) return null;
  const a = Math.floor(code / 10);
  const b = code % 10;
  if (!isHand(a) || !isHand(b) || a === b || code > 99) return null;
  return a < b ? [a, b] : [b, a];
}
export const encodePair = ([a, b]) => Math.min(a, b) * 10 + Math.max(a, b);

/**
 * 한 라운드 판정.
 * @param {string[]} alive 살아 있는 참가자 ID
 * @param {object} picks { playerId: { two:[a,b]|null, one:h|null } } — 현재 시도의 입력
 * @param {number} hostOne 진행자가 남긴 손
 */
export function judgeRound(alive, picks, hostOne) {
  const counts = { [ROCK]: 0, [SCISSORS]: 0, [PAPER]: 0 };
  const survivors = [];
  const eliminated = [];
  for (const pid of alive) {
    const p = picks[pid];
    if (!p?.two) { eliminated.push({ playerId: pid, reason: 'no-two' }); continue; }
    if (!p.one) { eliminated.push({ playerId: pid, reason: 'no-one' }); continue; }
    counts[p.one] += 1;
    const o = outcome(p.one, hostOne);
    if (o === 'win') survivors.push(pid);
    else eliminated.push({ playerId: pid, reason: o });
  }
  const cancelled = survivors.length === 0; // 전원 탈락 → 이번 라운드 탈락 취소
  return { counts, survivors: cancelled ? [...alive] : survivors, eliminated: cancelled ? [] : eliminated, wouldEliminate: eliminated, cancelled };
}

/** 순위: 생존자 공동 1위(끝나면 최후의 1인), 탈락자는 늦게 탈락할수록 높은 순위. 같은 라운드 탈락은 공동 순위 */
export function standings(state) {
  const score = (p) => (state.alive.includes(p.id) ? Infinity : state.eliminated[p.id].round);
  const list = state.players.map((p) => ({
    playerId: p.id, name: p.name, alive: state.alive.includes(p.id), eliminatedRound: state.eliminated[p.id]?.round ?? null,
  }));
  for (const e of list) {
    const mine = score({ id: e.playerId });
    e.rank = 1 + state.players.filter((o) => score(o) > mine).length;
  }
  const seat = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  return list.sort((a, b) => a.rank - b.rank || seat(a.playerId) - seat(b.playerId));
}

// ── 계약 함수 ───────────────────────────────────────────
export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return err('invalid-config', '설정 형식이 올바르지 않습니다.');
  const out = {};
  for (const key of ['twoSeconds', 'oneSeconds']) {
    const v = input[key] ?? DEFAULTS[key];
    if (!Number.isInteger(v) || v < SECONDS_RANGE.min || v > SECONDS_RANGE.max) {
      return err('invalid-config', `선택 시간은 ${SECONDS_RANGE.min}~${SECONDS_RANGE.max}초 정수입니다.`);
    }
    out[key] = v;
  }
  return { ok: true, config: out };
}

export function createGame({ players, config, now } = {}) {
  const normalized = normalizeConfig(config || {});
  if (!normalized.ok) return normalized;
  if (!Array.isArray(players) || players.length < 1) return err('invalid-players', '참가자가 없습니다.');
  if (new Set(players.map((p) => p.id)).size !== players.length) return err('invalid-players', '참가자 ID가 중복되었습니다.');
  const list = players.map((p) => ({ id: String(p.id), name: String(p.name) }));
  return ok({
    gameId: 'rps-minus-one',
    config: normalized.config,
    players: list,
    alive: list.map((p) => p.id),
    eliminated: {}, // { playerId: { round, reason } }
    phase: PHASE.LOBBY,
    round: 1,
    attempt: 1,
    deadlineAt: null,
    pausedRemainingMs: null,
    hostTwo: null, // 진행자 두 손 (① 동안 비공개)
    hostOne: null, // 진행자가 남긴 손 (공개 전 비공개)
    pending: null, // 마감 시 확정한 판정 (공개 전, 서버 전용)
    results: [], // 공개된 라운드 결과
    audit: [],
    restart: null,
    revealSkipped: false,
    ended: null,
    startedAt: Number.isFinite(now) ? now : null,
  });
}

const isPaused = (s) => s.pausedRemainingMs !== null;
const sameAttempt = (s, a) => a.round === s.round && a.attempt === s.attempt;
const isActive = (s) => s.phase === PHASE.PICK_TWO || s.phase === PHASE.PICK_ONE;
const currentInput = (s, input) => (input && input.round === s.round && input.attempt === s.attempt ? input : null);
function currentPicks(state, inputs = {}) {
  const picks = {};
  for (const pid of state.alive) {
    const i = currentInput(state, inputs[pid]);
    if (i) picks[pid] = { two: i.two || null, one: i.one || null };
  }
  return picks;
}

// ── 참가자 개인 입력 (플랫폼 playerInput 계약) ──────────────
export const playerInput = Object.freeze({
  actions: Object.freeze(['pick-two', 'keep-one']),
  /** 화면 제출 인원 집계용 입력 창 키 (라운드·시도·단계) */
  key: (state) => {
    if (state.phase === PHASE.PICK_TWO) return `r${state.round}a${state.attempt}t`;
    if (state.phase === PHASE.PICK_ONE) return `r${state.round}a${state.attempt}o`;
    return null;
  },
  execute(state, input, actor, action, ctx = {}) {
    const now = ctx.now;
    if (!Number.isFinite(now)) return err('no-clock', '서버 시각이 없어 처리할 수 없습니다.');
    const player = actor?.role === 'player' ? state.players.find((p) => p.id === actor.playerId) : null;
    if (!player) return err('not-player', '이 게임의 참가자만 낼 수 있습니다.');
    if (state.phase === PHASE.FINISHED) return err('game-finished', '이미 종료된 게임입니다.');
    if (!state.alive.includes(player.id)) return err('eliminated', '탈락해서 더 이상 낼 수 없습니다.');
    const step = action?.type === 'pick-two' ? PHASE.PICK_TWO : action?.type === 'keep-one' ? PHASE.PICK_ONE : null;
    if (!step) return err('unknown-action', '알 수 없는 행동입니다.');
    if (state.phase !== step || !sameAttempt(state, action)) return err('step-closed', '지금은 이 단계에 낼 수 없습니다. 화면의 현재 단계를 확인하세요.');
    if (isPaused(state)) return err('paused', '일시정지 중에는 낼 수 없습니다.');
    if (now >= state.deadlineAt) return err('deadline-passed', '시간이 끝났습니다. 마감 이후 제출은 인정되지 않습니다.');
    const cur = currentInput(state, input);

    if (step === PHASE.PICK_TWO) {
      const two = decodePair(action.value);
      if (!two) return err('invalid-hands', '서로 다른 손 두 개를 골라야 합니다.');
      if (cur?.two && cur.two[0] === two[0] && cur.two[1] === two[1]) return { ok: true, input: cur, newInWindow: false };
      if ((cur?.rev2 || 0) >= MAX_REVISIONS) return err('too-many-changes', `한 단계에서 ${MAX_REVISIONS}번까지만 바꿀 수 있습니다.`);
      return {
        ok: true, newInWindow: !cur?.two,
        input: { round: state.round, attempt: state.attempt, two, one: null, rev2: (cur?.rev2 || 0) + 1, rev1: 0, at: now },
      };
    }
    // 하나 빼기
    if (!cur?.two) return err('no-two', '두 손을 내지 않아 이번 라운드는 낼 수 없습니다 (탈락 예정).');
    if (!cur.two.includes(action.value)) return err('invalid-keep', '내가 낸 두 손 중 하나를 남겨야 합니다.');
    if (cur.one === action.value) return { ok: true, input: cur, newInWindow: false };
    if ((cur.rev1 || 0) >= MAX_REVISIONS) return err('too-many-changes', `한 단계에서 ${MAX_REVISIONS}번까지만 바꿀 수 있습니다.`);
    return { ok: true, newInWindow: !cur.one, input: { ...cur, one: action.value, rev1: (cur.rev1 || 0) + 1, at: now } };
  },
});

/**
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
      else if (state.phase === PHASE.RESULT && action.round === state.round + 1 && state.alive.length > 1) { round = state.round + 1; attempt = 1; }
      else return err('stale-round', '지금 시작할 수 있는 라운드가 아닙니다.');
      return ok({
        ...state, phase: PHASE.PICK_TWO, round, attempt,
        deadlineAt: now + state.config.twoSeconds * 1000, pausedRemainingMs: null,
        hostTwo: null, hostOne: null, pending: null, revealSkipped: false,
        restart: state.restart && state.restart.round === round ? state.restart : null,
      });
    }

    case 'host-two': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.PICK_TWO || !sameAttempt(state, action)) return err('stale-round', '두 손 내기 단계가 아닙니다.');
      const two = decodePair(action.value);
      if (!two) return err('invalid-hands', '서로 다른 손 두 개를 골라야 합니다.');
      return ok({ ...state, hostTwo: two });
    }

    case 'host-one': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.PICK_ONE || !sameAttempt(state, action)) return err('stale-round', '하나 빼기 단계가 아닙니다.');
      if (!state.hostTwo.includes(action.value)) return err('invalid-keep', '진행자가 낸 두 손 중 하나를 남겨야 합니다.');
      return ok({ ...state, hostOne: action.value });
    }

    case 'submit':
    case 'pick-two':
    case 'keep-one':
      // 참가자 손은 개인 입력 경로(playerInput.execute)로만 처리한다
      return err('not-player', '진행자 손은 진행자 화면의 손 고르기로 정합니다.');

    case 'close-round': {
      // 서버 시각으로 마감 시각이 지난 뒤에만. 진행자 손이 정해져 있어야 한다. 여러 번 와도 한 번만 반영
      if (!isHost && !player) return err('not-player', '이 게임의 참가자가 아닙니다.');
      if (!isActive(state) || !sameAttempt(state, action) || (action.value !== undefined && action.value !== (state.phase === PHASE.PICK_TWO ? 2 : 1))) {
        return err('already-closed', '이미 마감된 단계입니다.');
      }
      if (isPaused(state)) return err('paused', '일시정지 중에는 마감할 수 없습니다.');
      if (now < state.deadlineAt) return err('too-early', '아직 시간이 남아 있습니다.');
      if (state.phase === PHASE.PICK_TWO) {
        if (!state.hostTwo) return err('host-not-ready', '진행자가 두 손을 아직 고르지 않았습니다.');
        return ok({ ...state, phase: PHASE.PICK_ONE, deadlineAt: now + state.config.oneSeconds * 1000 });
      }
      if (!state.hostOne) return err('host-not-ready', '진행자가 남길 손을 아직 고르지 않았습니다.');
      const picks = currentPicks(state, inputs);
      const j = judgeRound(state.alive, picks, state.hostOne);
      return ok({
        ...state, phase: PHASE.CLOSED, deadlineAt: null,
        pending: {
          round: state.round, attempt: state.attempt, hostTwo: state.hostTwo, hostOne: state.hostOne,
          counts: j.counts, survivors: j.survivors, eliminated: j.eliminated, wouldEliminate: j.wouldEliminate,
          cancelled: j.cancelled, aliveBefore: state.alive.length,
          keptCount: Object.values(picks).filter((p) => p.one).length,
          picks, // 참가자별 손 — 서버 전용 (본인 것만 개인 화면에 전달)
          finalizedAt: now,
        },
      });
    }

    case 'pause': {
      const denied = hostOnly(); if (denied) return denied;
      if (!isActive(state) || !sameAttempt(state, action)) return err('stale-round', '진행 중인 단계에서만 일시정지할 수 있습니다.');
      if (isPaused(state)) return err('already-paused', '이미 일시정지 상태입니다.');
      if (now >= state.deadlineAt) return err('deadline-passed', '시간이 이미 끝났습니다.');
      const remaining = state.deadlineAt - now;
      return ok({
        ...state, deadlineAt: null, pausedRemainingMs: remaining,
        audit: [...state.audit, { type: 'pause', round: state.round, attempt: state.attempt, phase: state.phase, at: now, remainingMs: remaining }],
      });
    }

    case 'resume': {
      const denied = hostOnly(); if (denied) return denied;
      if (!isActive(state) || !sameAttempt(state, action)) return err('stale-round', '진행 중인 단계가 아닙니다.');
      if (!isPaused(state)) return err('not-paused', '일시정지 상태가 아닙니다.');
      return ok({
        ...state, deadlineAt: now + state.pausedRemainingMs, pausedRemainingMs: null,
        audit: [...state.audit, { type: 'resume', round: state.round, attempt: state.attempt, phase: state.phase, at: now, remainingMs: state.pausedRemainingMs }],
      });
    }

    case 'reveal': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.CLOSED || !sameAttempt(state, action)) return err('stale-round', '공개할 마감 결과가 없습니다.');
      const p = state.pending;
      const eliminated = { ...state.eliminated };
      for (const e of p.eliminated) eliminated[e.playerId] = { round: p.round, reason: e.reason };
      return ok({
        ...state, phase: PHASE.RESULT, pending: null, revealSkipped: false, restart: null,
        alive: p.survivors, eliminated,
        results: [...state.results, { ...p, revealedAt: now }],
      });
    }

    case 'skip-reveal': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.RESULT || action.round !== state.round) return err('stale-round', '공개 중인 결과가 아닙니다.');
      return state.revealSkipped ? ok(state) : ok({ ...state, revealSkipped: true });
    }

    case 'void-round': {
      // 마감 후 공개 전에만: 이번 시도를 반영하지 않고 같은 라운드 번호로 새 시도 (입력 재사용 안 함)
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.CLOSED || !sameAttempt(state, action)) return err('stale-round', '마감 후 공개 전 라운드만 무효화할 수 있습니다.');
      const attempt = state.attempt + 1;
      return ok({
        ...state, phase: PHASE.LOBBY, attempt, deadlineAt: null, pausedRemainingMs: null,
        hostTwo: null, hostOne: null, pending: null, restart: { round: state.round, attempt },
        audit: [...state.audit, { type: 'void', round: state.round, attempt: state.attempt, at: now, keptCount: state.pending.keptCount }],
      });
    }

    case 'finish-game': {
      const denied = hostOnly(); if (denied) return denied;
      if (state.phase !== PHASE.RESULT || state.alive.length !== 1) return err('stale-round', '최후의 1인이 남은 뒤에 최종 결과를 발표할 수 있습니다.');
      return ok({ ...state, phase: PHASE.FINISHED, ended: { reason: 'completed', at: now } });
    }

    case 'end-game': {
      // 비상 중단: 공개된 결과는 그대로 두고 끝낸다. 공개 전 판정·진행 중 입력은 반영하지 않는다
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

/** 공개 결과 (참가자별 손 picks 제외, 생존·탈락은 이름 목록으로) */
function publicResult(state, r) {
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  return {
    round: r.round, attempt: r.attempt, hostTwo: r.hostTwo, hostOne: r.hostOne, counts: r.counts,
    cancelled: r.cancelled, aliveBefore: r.aliveBefore, keptCount: r.keptCount,
    survivorCount: r.survivors.length, survivorNames: r.survivors.map(name),
    eliminatedCount: r.eliminated.length, wouldEliminateCount: r.wouldEliminate.length,
    revealedAt: r.revealedAt,
  };
}

/**
 * viewer 별로 허용된 정보만.
 *  public: 단계·인원·마감 시각·(②부터) 진행자 두 손·공개된 결과·순위. 진행 중 참가자 손·진행자 남긴 손 없음
 *  host:   진행자 본인이 고른 손·감사 기록 (참가자 손 없음)
 *  player: 본인 손·생존 여부·지난 라운드 본인 결과
 */
export function getView(state, viewer = { role: 'public' }) {
  if (viewer.role === 'player') {
    const me = state.players.find((p) => p.id === viewer.playerId);
    const cur = isActive(state) || state.phase === PHASE.CLOSED ? currentInput(state, viewer.input) : null;
    return {
      playerId: viewer.playerId,
      name: me ? me.name : null,
      round: state.round,
      attempt: state.attempt,
      alive: state.alive.includes(viewer.playerId),
      eliminated: state.eliminated[viewer.playerId] || null,
      current: cur ? { two: cur.two || null, one: cur.one || null } : null,
      history: state.results.map((r) => {
        const p = r.picks[viewer.playerId];
        const e = r.eliminated.find((x) => x.playerId === viewer.playerId);
        const was = r.survivors.includes(viewer.playerId) || !!e;
        return { round: r.round, two: p?.two ?? null, one: p?.one ?? null, played: was, survived: r.survivors.includes(viewer.playerId), reason: e?.reason ?? null };
      }),
    };
  }
  if (viewer.role === 'host') {
    return { role: 'host', round: state.round, attempt: state.attempt, hostTwo: state.hostTwo, hostOne: state.hostOne, audit: state.audit };
  }
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  return {
    phase: state.phase,
    round: state.round,
    attempt: state.attempt,
    twoSeconds: state.config.twoSeconds,
    oneSeconds: state.config.oneSeconds,
    playerCount: state.players.length,
    aliveCount: state.alive.length,
    inputKey: playerInput.key(state),
    deadlineAt: state.deadlineAt,
    paused: isPaused(state),
    pausedRemainingMs: state.pausedRemainingMs,
    hostTwo: state.phase === PHASE.PICK_ONE || state.phase === PHASE.CLOSED ? state.hostTwo : null,
    keptCount: state.phase === PHASE.CLOSED && state.pending ? state.pending.keptCount : null,
    results: state.results.map((r) => publicResult(state, r)),
    revealSkipped: state.revealSkipped,
    restart: state.restart,
    ended: state.ended,
    winnerName: state.alive.length === 1 && (state.phase === PHASE.RESULT || state.phase === PHASE.FINISHED) ? name(state.alive[0]) : null,
    standings: standings(state),
  };
}

export function getResult(state) {
  const ranking = standings(state);
  const winner = state.alive.length === 1 ? ranking.find((r) => r.alive) : null;
  return {
    finished: state.phase === PHASE.FINISHED,
    aborted: state.ended?.reason === 'aborted',
    roundsPlayed: state.results.length,
    ranking: ranking.map((r) => ({ rank: r.rank, playerId: r.playerId, name: r.name, alive: r.alive, eliminatedRound: r.eliminatedRound })),
    winner: winner ? { playerId: winner.playerId, name: winner.name } : null,
  };
}
