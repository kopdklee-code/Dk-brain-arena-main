// 공개 화면 (빔프로젝터): 공개 문서만 구독한다. 입력 기능 없음.
import { initFirebase, ensureAnonymousUser, watchRoom, describeError } from '../adapters/firebase-room.js';
import { el, $, message, pill, param, setModeBadge, CONNECTION_LABEL, ROOM_STATUS_LABEL } from './ui.js';
import { createGameArea } from './game-area.js';

const root = $('[data-display]');
let stopWatch = null;

async function boot() {
  const roomId = param('room');
  if (!roomId) {
    root.replaceChildren(message('주소에 방 ID(?room=)가 없습니다. 진행자 화면의 "공개 화면 열기" 링크를 사용하세요.', 'error'));
    return;
  }
  let services;
  try {
    services = initFirebase(location.hostname, 'dkba-display');
  } catch (err) {
    setModeBadge('unconfigured');
    root.replaceChildren(message(err.message, 'error'));
    return;
  }
  setModeBadge(services.mode);
  root.replaceChildren(message('… 연결 중'));
  try {
    await ensureAnonymousUser(services.auth);
  } catch (err) {
    root.replaceChildren(message(`연결 실패: ${describeError(err)}`, 'error'));
    return;
  }

  const codeEl = el('div', { class: 'dk-code dk-code--huge', 'data-room-code': true, text: '------' });
  const statusRow = el('div', { class: 'dk-status' });
  const playersEl = el('ol', { class: 'dk-list' });
  const notice = el('div', { 'aria-live': 'polite' });
  const gameEl = el('div', { 'data-game-area': true });
  const joinUrl = new URL('play.html', location.href).href;
  let gameArea = null;

  root.replaceChildren(
    el('section', { class: 'dk-card' }, [
      el('div', { class: 'dk-status' }, [el('span', { class: 'dk-muted', text: '입장 코드' }), statusRow]),
      codeEl,
      el('p', { text: `참가 주소: ${joinUrl}` }),
      notice,
    ]),
    el('section', { class: 'dk-card', 'data-lobby': true }, [el('h2', { text: '참가자' }), playersEl]),
    el('section', { class: 'dk-card' }, [gameEl]),
  );

  stopWatch = watchRoom(services, { roomId, role: 'display' }, (s) => {
    const { room } = s;
    statusRow.replaceChildren(
      pill(s.connection, CONNECTION_LABEL[s.connection] || s.connection),
      room ? pill(room.status, ROOM_STATUS_LABEL[room.status] || room.status) : null,
    );
    notice.replaceChildren(s.error ? message(s.error, 'error') : '');
    if (!room) return;
    codeEl.textContent = room.code;
    playersEl.replaceChildren(...(s.players.length
      ? s.players.map((p) => el('li', { text: `${p.playerId} · ${p.nickname}` }))
      : [el('li', { class: 'dk-muted', text: '입장을 기다리는 중' })]));
    if (room.status !== 'lobby' && room.publicView) {
      if (!gameArea) gameArea = createGameArea(gameEl, { gameId: room.gameId, role: 'display' });
      gameArea.update(room.publicView, room.result);
    } else {
      gameEl.replaceChildren(el('p', { class: 'dk-muted', text: `${room.title} · 진행자가 시작하면 진행 상황이 표시됩니다.` }));
    }
  });
}

window.addEventListener('pagehide', () => { stopWatch?.(); stopWatch = null; });
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
boot();
