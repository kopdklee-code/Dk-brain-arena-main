// 게임 화면 영역: 게임 모듈의 view.js 를 붙이고 서버에서 받은 view 를 전달한다.
import { getView as getGameViewModule } from '../games/views.js';
import { ensureGameCss, el } from './ui.js';

export function createGameArea(container, { gameId, role, session }) {
  const viewModule = getGameViewModule(gameId);
  if (!viewModule) {
    container.replaceChildren(el('p', { class: 'dk-message dk-message--error', role: 'alert', text: `화면 모듈이 없는 게임입니다: ${gameId}` }));
    return { update() {}, destroy() {} };
  }
  ensureGameCss(gameId);
  const ui = viewModule.mount(container, { role, send: session ? (action, opts) => session.send(action, opts) : undefined });
  let last = '';
  return {
    update(view, result) {
      if (!view) return;
      const key = JSON.stringify([view, result]);
      if (key === last) return; // 같은 내용이면 다시 그리지 않음 (포커스 유지)
      last = key;
      ui.update({ view, result });
    },
    destroy() { ui.destroy(); },
  };
}
