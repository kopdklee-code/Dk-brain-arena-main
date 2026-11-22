// 브라우저 전용: 게임별 화면 모듈 등록. 게임을 추가하면 registry.js 와 함께 여기에 한 줄을 추가한다.
import * as demoNumberChoiceView from './demo-number-choice/view.js';

export const VIEWS = Object.freeze({
  'demo-number-choice': demoNumberChoiceView,
});

export function getView(gameId) {
  return Object.prototype.hasOwnProperty.call(VIEWS, gameId) ? VIEWS[gameId] : null;
}
