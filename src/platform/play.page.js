// 참가자 화면 (모바일): 입장 코드·닉네임 → 대기 → 제출 → 결과. 새로고침·재접속 시 자리 복구.
import { initFirebase, ensureAnonymousUser, createRoomApi, watchRoom, createOnlineSession, describeError, createServerClock } from '../adapters/firebase-room.js';
import { el, $, message, pill, param, setParams, setModeBadge, storage, connectionNotice, CONNECTION_LABEL, ROOM_STATUS_LABEL } from './ui.js';
import { createGameArea } from './game-area.js';

const KEY = 'dkba.player.session';
const root = $('[data-play]');
let services;
let api;
let clock;
let user;
let stopWatch = null;

function stop() {
  stopWatch?.();
  stopWatch = null;
}

function loadSaved() {
  try {
    const raw = storage()?.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return saved && saved.uid === user.uid ? saved : null;
  } catch {
    return null;
  }
}
function save(value) {
  try { storage()?.setItem(KEY, JSON.stringify(value)); } catch { /* 저장소 사용 불가 시 재접속 복구만 생략 */ }
}
function clearSaved() {
  try { storage()?.removeItem(KEY); } catch { /* 무시 */ }
}

// 입장 요청이 몰려 서버 응답이 늦거나 실패하면 자동으로 다시 시도한다.
// 같은 익명 세션의 재요청은 서버가 같은 자리를 돌려주므로(중복 입장 없음) 안전하다.
const RETRY_CODES = ['functions/internal', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/aborted'];
async function joinWithRetry(code, nickname, onRetry) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.joinRoom(code, nickname);
    } catch (err) {
      if (!RETRY_CODES.includes(err.code) || attempt >= 3) throw err;
      onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1000) * attempt));
    }
  }
}

function card(...children) {
  return el('section', { class: 'dk-card' }, children);
}

function renderJoin(errorText = '') {
  stop();
  const code = el('input', {
    id: 'join-code', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: '8', required: true,
    value: param('code') || '', 'aria-describedby': 'join-code-help',
  });
  const nickname = el('input', { id: 'join-nickname', autocomplete: 'nickname', maxlength: '12', required: true });
  const status = el('div', { 'aria-live': 'polite' }, errorText ? message(errorText, 'error') : null);
  const btn = el('button', { class: 'dk-btn', type: 'submit', 'data-action': 'join', text: '입장하기' });
  const form = el('form', {
    class: 'dk-form',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = '입장 중…';
      status.replaceChildren(message('… 입장 요청 중'));
      try {
        const res = await joinWithRetry(code.value, nickname.value, (n) => status.replaceChildren(message(`연결을 복구하고 있습니다… (다시 시도 ${n}/2)`)));
        save({ uid: user.uid, roomId: res.roomId, code: res.code, nickname: res.nickname });
        enterRoom(res);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '입장하기';
        status.replaceChildren(message(`입장 실패: ${describeError(err, 'join')}`, 'error'));
      }
    },
  }, [
    el('div', { class: 'dk-field' }, [el('label', { for: 'join-code', text: '입장 코드' }), code, el('small', { id: 'join-code-help', text: '진행자 화면에 표시된 6자리 코드' })]),
    el('div', { class: 'dk-field' }, [el('label', { for: 'join-nickname', text: '닉네임 (1~12자)' }), nickname]),
    el('div', { class: 'dk-actions' }, [btn]),
    status,
  ]);
  root.replaceChildren(card(el('h1', { text: '게임 참가' }), form));
  (code.value ? nickname : code).focus();
}

function enterRoom(res) {
  stop();
  setParams({ code: null });
  const statusRow = el('div', { class: 'dk-status', 'aria-live': 'polite' });
  const connNotice = el('div', { 'data-connection-notice': true, 'aria-live': 'assertive' });
  const lobbyEl = el('div', { 'aria-live': 'polite' });
  const gameEl = el('div', { 'data-game-area': true });
  const notice = el('div', { 'aria-live': 'polite' }, res.rejoined ? message('연결되었습니다. 기존 참가 상태를 복구했습니다.') : null);
  const leaveBtn = el('button', {
    class: 'dk-btn dk-btn--danger', type: 'button', 'data-action': 'leave', text: '나가기',
    onclick: () => { clearSaved(); renderJoin(); },
  });
  let gameArea = null;

  root.replaceChildren(card(
    el('h1', { text: '게임 참가' }),
    el('p', { 'data-seat': res.playerId }, [`코드 ${res.code} · `, el('strong', { text: res.nickname }), ` (${res.playerId})`]),
    statusRow,
    connNotice,
    notice,
    lobbyEl,
    gameEl,
    el('div', { class: 'dk-actions' }, [leaveBtn]),
  ));

  stopWatch = watchRoom(services, { roomId: res.roomId, uid: user.uid, role: 'player' }, (s) => {
    const { room } = s;
    statusRow.replaceChildren(
      pill(s.connection, CONNECTION_LABEL[s.connection] || s.connection),
      room ? pill(room.status, `방 상태: ${ROOM_STATUS_LABEL[room.status] || room.status}`) : null,
    );
    connNotice.replaceChildren(connectionNotice(s.connection) || '');
    if (s.error) notice.replaceChildren(message(s.error, 'error'));
    if (!room) return;
    if (room.status === 'lobby') {
      lobbyEl.replaceChildren(message(`진행자가 게임을 시작하기를 기다리는 중입니다. (${room.playerCount} / ${room.maxPlayers}명 입장)`));
      return;
    }
    lobbyEl.replaceChildren();
    if (s.privateDoc?.view) {
      if (!gameArea) gameArea = createGameArea(gameEl, { gameId: room.gameId, role: 'player', session: createOnlineSession(api, res.roomId), now: clock.now });
      gameArea.update(s.privateDoc.view, room.result, room.publicView, room.inputCounts || null);
    }
  });
}

async function boot() {
  try {
    services = initFirebase(location.hostname, 'dkba-player');
  } catch (err) {
    setModeBadge('unconfigured');
    root.replaceChildren(card(message(err.message, 'error')));
    return;
  }
  setModeBadge(services.mode);
  api = createRoomApi(services);
  clock = createServerClock(api);
  root.replaceChildren(card(message('… 연결 중 (익명 인증)')));
  try {
    user = await ensureAnonymousUser(services.auth);
  } catch (err) {
    root.replaceChildren(card(
      message(describeError(err, 'join'), 'error'),
      el('button', { class: 'dk-btn', type: 'button', text: '다시 시도', onclick: () => location.reload() }),
    ));
    return;
  }
  clock.sync(); // 타이머 표시 보정 (판정과 무관, 기다리지 않음)
  const saved = loadSaved();
  // QR·링크로 다른 방 코드를 받아 온 경우: 이전 방 자동 재접속 대신 새 방 입장 화면 (이전 기록은 입장 성공 시 덮어씀)
  const linkedCode = (param('code') || '').trim().toUpperCase();
  if (!saved || (linkedCode && linkedCode !== String(saved.code).toUpperCase())) {
    renderJoin();
    return;
  }
  root.replaceChildren(card(message('↻ 재접속 중… 이전에 입장한 방의 자리를 확인하고 있습니다.')));
  try {
    const res = await joinWithRetry(saved.code, saved.nickname);
    enterRoom(res);
  } catch (err) {
    clearSaved();
    renderJoin(`재접속 실패: ${describeError(err, 'join')}`);
  }
}

// 화면을 떠날 때 실시간 구독 해제
window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
boot();
