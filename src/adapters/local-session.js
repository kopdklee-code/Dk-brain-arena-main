// 로컬 실행 연결부: 같은 규칙 원본을 브라우저(또는 Node) 안에서 직접 실행한다.
// 온라인 연결부(firebase-room.js)와 같은 세션 계약을 제공한다:
//   subscribe(listener) -> unsubscribe,  send(action, {playerId?}) -> Promise<{ok, error?}>
// 오프라인판은 한 PC에서 진행자가 모든 입력을 하므로 actor 는 action 종류와 playerId 로 정한다.

export function createLocalSession({ rules, players, config, hostActions = ['closeRound'] }) {
  const listeners = new Set();
  let state = null;
  let log = [];
  let inputs = {}; // 참가자 개인 입력 (rules.playerInput 이 있을 때)
  let inputCounts = {};

  function start() {
    const created = rules.createGame({ players, config, now: Date.now() });
    if (!created.ok) throw new Error(created.error.message);
    state = created.state;
    log = [];
    inputs = {};
    inputCounts = {};
    emit();
  }

  function snapshot() {
    const result = rules.getResult(state);
    return {
      status: result.finished ? 'finished' : 'playing',
      view: rules.getView(state, { role: 'local' }),
      result,
      inputCounts: { ...inputCounts },
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) fn(snap);
  }

  function dispatch(actor, action) {
    if (actor.role === 'player' && rules.playerInput?.actions.includes(action.type)) {
      const out = rules.playerInput.execute(state, inputs[actor.playerId] ?? null, actor, action, { now: Date.now() });
      log.push({ seq: log.length + 1, actor, action, ok: out.ok, error: out.ok ? null : out.error });
      if (!out.ok) return { ok: false, error: out.error };
      inputs = { ...inputs, [actor.playerId]: out.input };
      const key = out.newInWindow ? rules.playerInput.key(state) : null;
      if (key) inputCounts = { ...inputCounts, [key]: (inputCounts[key] || 0) + 1 };
      emit();
      return { ok: true };
    }
    const res = rules.executeAction(state, actor, action, { now: Date.now(), inputs });
    log.push({ seq: log.length + 1, actor, action, ok: res.ok, error: res.ok ? null : res.error });
    if (res.ok) {
      state = res.state;
      emit();
    }
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  start();

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    async send(action, options = {}) {
      const actor = hostActions.includes(action.type) ? { role: 'host' } : { role: 'player', playerId: options.playerId };
      return dispatch(actor, action);
    },
    dispatch,
    reset: start,
    getState: () => JSON.parse(JSON.stringify(state)),
    getLog: () => JSON.parse(JSON.stringify(log)),
    getResult: () => rules.getResult(state),
  };
}
