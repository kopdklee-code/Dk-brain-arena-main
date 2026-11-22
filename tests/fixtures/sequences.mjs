// 온라인·오프라인 판정 비교용 고정 행동 순서 (동일 초기 상태: 2명 p1/p2)
export const SEQUENCES = [
  {
    name: 'mixed-with-missing',
    names: ['가람', '나래'],
    // 각 라운드: [p1 선택|null, p2 선택|null]
    rounds: [[3, 1], [2, 2], [1, null]],
  },
  {
    name: 'tie',
    names: ['다솜', '라온'],
    rounds: [[1, 3], [3, 1], [2, 2]],
  },
  {
    name: 'e2e-shared',
    names: ['하나', '두리'],
    rounds: [[2, 3], [3, null], [1, 1]],
  },
  {
    // 연결 끊김 시나리오: 1라운드 p2 는 오프라인 제출 실패(미접수 → 0점), 2라운드 p2 는 응답 유실(서버 접수 1회)
    name: 'reconnect',
    names: ['한결', '두빛'],
    rounds: [[2, null], [1, 3], [3, 2]],
  },
];

/** 규칙 모듈로 순서를 실행하고 최종 결과를 돌려준다 */
export function runLocal(rules, seq) {
  const players = seq.names.map((name, i) => ({ id: `p${i + 1}`, name }));
  let { state } = rules.createGame({ players, config: {} });
  seq.rounds.forEach((choices, index) => {
    const round = index + 1;
    choices.forEach((value, i) => {
      if (value === null) return;
      const res = rules.executeAction(state, { role: 'player', playerId: `p${i + 1}` }, { type: 'choose', round, value });
      if (!res.ok) throw new Error(`${seq.name} r${round} p${i + 1}: ${res.error.code}`);
      state = res.state;
    });
    const res = rules.executeAction(state, { role: 'host' }, { type: 'closeRound', round });
    if (!res.ok) throw new Error(`${seq.name} close r${round}: ${res.error.code}`);
    state = res.state;
  });
  return rules.getResult(state);
}
