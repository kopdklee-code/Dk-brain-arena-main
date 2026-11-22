// Cloud Functions 배포 묶음(functions/generated/games.js)을 만드는 빌드 입력.
// 규칙 원본은 src/games 에 하나만 있고, 이 입력을 번들해 Functions 디렉터리 안에 포함시킨다.
export { GAMES, getGame, listManifests } from '../games/registry.js';
export { ROOM_STATUS } from './contract.js';
export { normalizeCode, normalizeNickname, isValidRequestId, sanitizeAction, CODE_ALPHABET, CODE_LENGTH } from './validation.js';
