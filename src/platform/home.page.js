// 플랫폼 홈·게임 목록. 코드 등록 목록(registry)에 있는 구현된 게임만 표시한다.
import { listManifests } from '../games/registry.js';
import { el, $, SCREEN_LABEL } from './ui.js';

const list = $('[data-game-list]');
const manifests = listManifests();
if (!manifests.length) {
  list.append(el('p', { class: 'dk-muted', text: '등록된 게임이 없습니다.' }));
}
for (const m of manifests) {
  list.append(el('article', { class: 'dk-card dk-game-card', 'data-game-id': m.gameId }, [
    el('img', { src: `games/${m.gameId}/assets/icon.svg`, alt: '' }),
    el('div', { class: 'dk-form' }, [
      el('h3', {}, [m.title, ' ', m.isDemo ? el('span', { class: 'dk-badge dk-badge--demo', text: '개발 검증용' }) : null]),
      el('p', { text: m.description }),
      el('p', { class: 'dk-muted', text: `인원 ${m.players.min === m.players.max ? m.players.min : `${m.players.min}~${m.players.max}`}명 · ${m.screens.map((s) => SCREEN_LABEL[s] || s).join(', ')}` }),
      el('div', { class: 'dk-actions' }, [
        el('a', { class: 'dk-btn', href: `game.html?id=${encodeURIComponent(m.gameId)}`, text: '자세히 보기' }),
      ]),
    ]),
  ]));
}
