// 게임 상세
import { getGame } from '../games/registry.js';
import { el, $, param, DISTRIBUTION_LABEL, SCREEN_LABEL } from './ui.js';

const root = $('[data-game-detail]');
const game = getGame(param('id') || '');
if (!game) {
  root.append(el('p', { class: 'dk-message dk-message--error', role: 'alert', text: '등록되지 않은 게임입니다.' }), el('a', { href: 'index.html', text: '게임 목록으로' }));
} else {
  const m = game.manifest;
  document.title = `${m.title} · DK BRAIN ARENA`;
  root.append(
    el('div', { class: 'dk-game-card' }, [
      el('img', { src: `games/${m.gameId}/assets/icon.svg`, alt: '' }),
      el('div', { class: 'dk-form' }, [
        el('h1', {}, [m.title, ' ', m.isDemo ? el('span', { class: 'dk-badge dk-badge--demo', text: '개발 검증용 · 판매 게임 아님' }) : null]),
        el('p', { text: m.description }),
      ]),
    ]),
    el('dl', { class: 'dk-meta' }, [
      el('dt', { text: '게임 ID' }), el('dd', { text: m.gameId }),
      el('dt', { text: '게임 버전' }), el('dd', { text: m.gameVersion }),
      el('dt', { text: '인원' }), el('dd', { text: m.players.min === m.players.max ? `${m.players.min}명` : `${m.players.min}~${m.players.max}명` }),
      el('dt', { text: '지원 화면' }), el('dd', { text: m.screens.map((s) => SCREEN_LABEL[s] || s).join(', ') }),
      el('dt', { text: '배포 방식' }), el('dd', { text: m.distributions.map((d) => DISTRIBUTION_LABEL[d] || d).join(', ') }),
    ]),
    el('div', { class: 'dk-actions' }, [
      el('a', { class: 'dk-btn', href: `host.html?game=${encodeURIComponent(m.gameId)}`, text: '진행자로 방 만들기' }),
      el('a', { class: 'dk-btn dk-btn--ghost', href: 'play.html', text: '참가자로 입장하기' }),
    ]),
    m.distributions.includes('offline-standalone')
      ? el('p', { class: 'dk-muted', text: '오프라인 실행형 파일은 개발자가 빌드 명령(npm run build:packages)으로 생성하며, 이 웹사이트(Hosting)에는 배포하지 않습니다.' })
      : null,
  );
}
