// 검증된 게임만 코드에서 등록한다. 임의 JavaScript 업로드·플러그인 마켓은 지원하지 않는다.
// 이 파일은 서버(Functions)와 브라우저가 함께 쓰므로 DOM 의존 코드(view.js)를 import 하지 않는다.
import * as demoNumberChoiceRules from './demo-number-choice/rules.js';
import demoNumberChoiceManifest from './demo-number-choice/manifest.json' with { type: 'json' };
import * as rpsMinusOneRules from './rps-minus-one/rules.js';
import rpsMinusOneManifest from './rps-minus-one/manifest.json' with { type: 'json' };
import { assertGameModule } from '../shared/contract.js';

export const GAMES = Object.freeze({
  [demoNumberChoiceManifest.gameId]: assertGameModule({ manifest: demoNumberChoiceManifest, rules: demoNumberChoiceRules }),
  [rpsMinusOneManifest.gameId]: assertGameModule({ manifest: rpsMinusOneManifest, rules: rpsMinusOneRules }),
});

export function getGame(gameId) {
  return Object.prototype.hasOwnProperty.call(GAMES, gameId) ? GAMES[gameId] : null;
}

/** 등록된 게임 manifest 목록. { listedOnly: true } 이면 공개(listed !== false) 게임만 */
export function listManifests({ listedOnly = false } = {}) {
  return Object.values(GAMES).map((g) => g.manifest).filter((m) => !listedOnly || m.listed !== false);
}
