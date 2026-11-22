// 플랫폼과 게임 모듈 사이의 최소 공통 계약.
// 게임 내부 단계(라운드 등)와 점수 공식은 여기에 두지 않는다.

/** 플랫폼 방 상태. 게임 내부 세부 단계와 구분된다. */
export const ROOM_STATUS = Object.freeze({ LOBBY: 'lobby', PLAYING: 'playing', FINISHED: 'finished' });

export const REQUIRED_RULE_EXPORTS = Object.freeze(['normalizeConfig', 'createGame', 'executeAction', 'getView', 'getResult']);
export const REQUIRED_MANIFEST_FIELDS = Object.freeze(['gameId', 'title', 'description', 'gameVersion', 'players', 'screens', 'distributions', 'isDemo']);
export const KNOWN_DISTRIBUTIONS = Object.freeze(['platform', 'offline-standalone', 'buyer-firebase']);

export function assertGameModule(game) {
  const { manifest, rules } = game || {};
  if (!manifest || !rules) throw new Error('게임 모듈에 manifest 와 rules 가 필요합니다.');
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest)) throw new Error(`${manifest.gameId ?? '?'}: manifest.${field} 누락`);
  }
  for (const name of REQUIRED_RULE_EXPORTS) {
    if (typeof rules[name] !== 'function') throw new Error(`${manifest.gameId}: rules.${name} 함수 누락`);
  }
  for (const d of manifest.distributions) {
    if (!KNOWN_DISTRIBUTIONS.includes(d)) throw new Error(`${manifest.gameId}: 알 수 없는 배포 방식 ${d}`);
  }
  const { min, max } = manifest.players;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`${manifest.gameId}: players.min/max 가 올바르지 않습니다.`);
  }
  return Object.freeze({ manifest, rules });
}
