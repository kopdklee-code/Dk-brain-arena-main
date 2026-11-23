// 게임 화면 영역: 게임 모듈의 view.js 를 붙이고 서버에서 받은 view 를 전달한다.
// 플랫폼이 게임 화면에 주는 것: role, send(행동 전송), now(서버 기준 추정 시각 — 타이머 표시용).
// update 에는 역할별 view(개인 문서 또는 공개 문서), 공개 문서의 publicView, 종료 결과(result),
// 화면 표시용 입력 집계(inputCounts: 개인 입력 계약을 쓰는 게임의 입력 창별 제출 인원)를 넘긴다.
import { getView as getGameViewModule } from '../games/views.js';
import { ensureGameCss, el } from './ui.js';

export function createGameArea(container, { gameId, role, session, now = () => Date.now() }) {
  const viewModule = getGameViewModule(gameId);
  if (!viewModule) {
    container.replaceChildren(el('p', { class: 'dk-message dk-message--error', role: 'alert', text: `화면 모듈이 없는 게임입니다: ${gameId}` }));
    return { update() {}, destroy() {} };
  }
  ensureGameCss(gameId);
  const ui = viewModule.mount(container, { role, send: session ? (action, opts) => session.send(action, opts) : undefined, now });
  let last = '';
  return {
    update(view, result, publicView = null, inputCounts = null) {
      if (!view) return;
      const key = JSON.stringify([view, result, publicView, inputCounts]);
      if (key === last) return; // 같은 내용이면 다시 그리지 않음 (포커스 유지)
      last = key;
      ui.update({ view, result, publicView, inputCounts });
    },
    destroy() { ui.destroy(); },
  };
}
