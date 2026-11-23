// 진행자 화면: 로그인 → 방 생성 → 대기실 → 게임 시작 → 라운드 마감 → 결과
import { initFirebase, waitForUser, hostAuth, createRoomApi, watchRoom, createOnlineSession, describeError, createServerClock } from '../adapters/firebase-room.js';
import { getGame, listManifests } from '../games/registry.js';
import { el, $, message, pill, param, setParams, setModeBadge, connectionNotice, CONNECTION_LABEL, ROOM_STATUS_LABEL } from './ui.js';
import { createGameArea } from './game-area.js';
import { createJoinQr, joinUrlFor, isLocalOnlyUrl } from './qr.js';

const root = $('[data-host]');
let services;
let api;
let user;
let clock = null;
let stopWatch = null;

function fatal(text) {
  root.replaceChildren(el('section', { class: 'dk-card' }, [message(text, 'error')]));
}

function authMessage(err) {
  const map = {
    'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/wrong-password': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/user-not-found': '등록되지 않은 계정입니다. 먼저 계정을 만드세요.',
    'auth/email-already-in-use': '이미 있는 계정입니다. 로그인하세요.',
    'auth/weak-password': '비밀번호는 6자 이상이어야 합니다.',
    'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
    'auth/popup-closed-by-user': '로그인 창이 닫혔습니다. 다시 시도하세요.',
    'auth/cancelled-popup-request': '로그인 창이 닫혔습니다. 다시 시도하세요.',
    'auth/popup-blocked': '브라우저가 로그인 창을 차단했습니다. 팝업을 허용한 뒤 다시 시도하세요.',
    'auth/operation-not-allowed': 'Firebase 콘솔에서 Google 로그인 제공자가 사용 설정되어 있지 않습니다.',
    'auth/unauthorized-domain': '이 주소는 Firebase Authentication 승인 도메인이 아닙니다.',
  };
  return map[err.code] || describeError(err);
}

function renderLogin(errorText = '') {
  const status = el('div', { 'aria-live': 'polite' }, errorText ? message(errorText, 'error') : null);
  const googleBtn = el('button', {
    class: 'dk-btn', type: 'button', 'data-action': 'google-sign-in', text: 'Google로 로그인',
    onclick: async () => {
      googleBtn.disabled = true;
      status.replaceChildren(message('… Google 로그인 창에서 계정을 선택하세요'));
      try {
        const cred = await hostAuth.signInWithGoogle(services.auth);
        user = cred.user;
        afterLogin();
      } catch (err) {
        googleBtn.disabled = false;
        status.replaceChildren(message(`실패: ${authMessage(err)}`, 'error'));
      }
    },
  });
  root.replaceChildren(el('section', { class: 'dk-card dk-main--narrow' }, [
    el('h1', { text: '진행자 로그인' }),
    el('p', { text: '진행자는 Google 계정으로 로그인합니다. 관리자가 승인한 계정만 방을 만들 수 있습니다.' }),
    el('div', { class: 'dk-actions' }, [googleBtn]),
    status,
    services.mode === 'emulator' ? emulatorTestLogin(status) : null,
  ]));
  googleBtn.focus();
}

/** 에뮬레이터 전용: 자동 검증용 이메일 테스트 계정 (운영 화면에는 표시하지 않음, 승인 목록 검사는 동일) */
function emulatorTestLogin(status) {
  const email = el('input', { id: 'host-email', type: 'email', autocomplete: 'username', required: true });
  const password = el('input', { id: 'host-password', type: 'password', autocomplete: 'current-password', required: true, minlength: '6' });
  const signInBtn = el('button', { class: 'dk-btn', type: 'submit', 'data-action': 'sign-in', text: '로그인' });
  const signUpBtn = el('button', { class: 'dk-btn dk-btn--ghost', type: 'button', 'data-action': 'sign-up', text: '계정 만들기' });

  async function run(kind) {
    if (!email.value || password.value.length < 6) {
      status.replaceChildren(message('이메일과 6자 이상의 비밀번호를 입력하세요.', 'error'));
      return;
    }
    signInBtn.disabled = true; signUpBtn.disabled = true;
    status.replaceChildren(message(kind === 'up' ? '… 계정 만드는 중' : '… 로그인 중'));
    try {
      const cred = kind === 'up'
        ? await hostAuth.signUp(services.auth, email.value.trim(), password.value)
        : await hostAuth.signIn(services.auth, email.value.trim(), password.value);
      user = cred.user;
      afterLogin();
    } catch (err) {
      signInBtn.disabled = false; signUpBtn.disabled = false;
      status.replaceChildren(message(`실패: ${authMessage(err)}`, 'error'));
    }
  }

  const form = el('form', { class: 'dk-form', onsubmit: (e) => { e.preventDefault(); run('in'); } }, [
    el('div', { class: 'dk-field' }, [el('label', { for: 'host-email', text: '테스트 이메일' }), email]),
    el('div', { class: 'dk-field' }, [el('label', { for: 'host-password', text: '비밀번호' }), password]),
    el('div', { class: 'dk-actions' }, [signInBtn, signUpBtn]),
  ]);
  signUpBtn.addEventListener('click', () => run('up'));
  return el('details', { class: 'dk-form', 'data-emulator-login': true }, [
    el('summary', { text: '에뮬레이터 테스트 계정 (로컬 전용)' }),
    el('p', { class: 'dk-muted', text: '로컬 에뮬레이터 안에만 존재하는 계정입니다. 방을 만들려면 이 이메일도 에뮬레이터의 hostAccounts 승인 목록에 있어야 합니다 (README 참고).' }),
    form,
  ]);
}

function accountBar() {
  return el('div', { class: 'dk-status' }, [
    el('span', { text: `진행자: ${user.email || user.uid}` }),
    el('button', {
      class: 'dk-btn dk-btn--ghost', type: 'button', 'data-action': 'sign-out', text: '로그아웃',
      onclick: async () => { stopWatch?.(); stopWatch = null; await hostAuth.signOut(services.auth); user = null; setParams({ room: null }); renderLogin(); },
    }),
  ]);
}

function afterLogin() {
  const roomId = param('room');
  if (roomId) openRoom(roomId);
  else renderCreate();
}

function renderCreate(errorText = '') {
  const manifests = listManifests();
  const wanted = param('game');
  const select = el('select', { id: 'game-select' }, manifests.map((m) =>
    el('option', { value: m.gameId, selected: m.gameId === wanted, text: `${m.title}${m.isDemo ? ' (개발 검증용)' : ''}` })));
  const status = el('div', { 'aria-live': 'polite' }, errorText ? message(errorText, 'error') : null);
  const btn = el('button', { class: 'dk-btn', type: 'submit', 'data-action': 'create-room', text: '방 만들기' });
  const form = el('form', {
    class: 'dk-form',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      status.replaceChildren(message('… 방 만드는 중'));
      try {
        const res = await api.createRoom(select.value, {});
        setParams({ room: res.roomId, game: null });
        openRoom(res.roomId);
      } catch (err) {
        btn.disabled = false;
        status.replaceChildren(message(`실패: ${describeError(err)}`, 'error'));
      }
    },
  }, [
    el('div', { class: 'dk-field' }, [el('label', { for: 'game-select', text: '게임 선택' }), select]),
    el('div', { class: 'dk-actions' }, [btn]),
    status,
  ]);
  root.replaceChildren(el('section', { class: 'dk-card' }, [accountBar(), el('h1', { text: '새 방 만들기' }), form]));
}

function openRoom(roomId) {
  stopWatch?.();
  const codeEl = el('div', { class: 'dk-code', 'data-room-code': true, text: '------' });
  const statusRow = el('div', { class: 'dk-status', 'aria-live': 'polite' });
  const connNotice = el('div', { 'data-connection-notice': true, 'aria-live': 'assertive' });
  const playersEl = el('ol', { class: 'dk-list', 'data-players': true });
  const playerCountEl = el('p', { class: 'dk-muted' });
  const notice = el('div', { 'aria-live': 'polite' });
  const startBtn = el('button', { class: 'dk-btn', type: 'button', 'data-action': 'start-game', text: '게임 시작', disabled: true });
  const gameEl = el('div', { 'data-game-area': true }, el('p', { class: 'dk-muted', text: '게임을 시작하면 이곳에 진행 화면이 표시됩니다.' }));
  const joinLink = el('a', { href: joinUrlFor(null), target: '_blank', rel: 'noopener', 'data-join-link': true, text: joinUrlFor(null) });
  const joinQr = createJoinQr({ size: 'md' });
  joinQr.element.classList.add('dk-hidden'); // 코드가 정해지고 입장 가능한 동안(대기실)만 표시
  const displayUrl = new URL(`display.html?room=${encodeURIComponent(roomId)}`, location.href).href;
  const precheck = el('section', { class: 'dk-precheck', 'data-precheck': true, 'aria-label': '시작 전 점검' });
  const finishedEl = el('div', { 'data-finished-actions': true });
  let clockState = 'checking';
  clock.sync().then((ok) => { clockState = ok ? 'ok' : 'fail'; if (latest) update(latest); });

  let starting = false;
  let latest = null;
  let gameArea = null;

  startBtn.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    startBtn.disabled = true;
    startBtn.textContent = '시작 중…';
    notice.replaceChildren();
    try {
      const res = await api.startGame(roomId);
      if (!res.ok) notice.replaceChildren(message(`시작 실패: ${res.error.message}`, 'error'));
    } catch (err) {
      notice.replaceChildren(message(`시작 실패: ${describeError(err)}`, 'error'));
    }
    starting = false;
    startBtn.textContent = '게임 시작';
    if (latest) update(latest);
  });

  root.replaceChildren(el('div', { class: 'dk-split' }, [
    el('section', { class: 'dk-card', 'aria-label': '방 정보' }, [
      accountBar(),
      el('h1', { text: '진행자 화면' }),
      el('p', { class: 'dk-muted', text: '입장 코드' }), codeEl,
      statusRow,
      connNotice,
      joinQr.element,
      el('p', {}, ['참가 주소: ', joinLink]),
      el('p', {}, [el('a', { href: displayUrl, target: '_blank', rel: 'noopener', 'data-display-link': true, text: '공개 화면 열기 (빔프로젝터용)' })]),
      precheck,
      el('h2', { text: '참가자' }), playerCountEl, playersEl,
      el('div', { class: 'dk-actions' }, [startBtn]),
      finishedEl,
      notice,
    ]),
    el('section', { class: 'dk-card', 'aria-label': '게임 진행' }, [gameEl]),
  ]));

  function update(s) {
    latest = s;
    const { room } = s;
    statusRow.replaceChildren(
      pill(s.connection, CONNECTION_LABEL[s.connection] || s.connection),
      room ? pill(room.status, `방 상태: ${ROOM_STATUS_LABEL[room.status] || room.status}`) : null,
    );
    connNotice.replaceChildren(connectionNotice(s.connection) || '');
    if (s.error) notice.replaceChildren(message(s.error, 'error'));
    if (!room) return;
    if (room.hostUid !== user.uid) {
      notice.replaceChildren(message('이 방의 진행자가 아니므로 진행 명령을 사용할 수 없습니다.', 'error'));
      startBtn.disabled = true;
      return;
    }
    codeEl.textContent = room.code;
    const joinUrl = joinUrlFor(room.code);
    if (joinLink.href !== joinUrl) { joinLink.href = joinUrl; joinLink.textContent = joinUrl; }
    joinQr.update(room.code);
    joinQr.element.classList.toggle('dk-hidden', room.status !== 'lobby');
    playerCountEl.textContent = `${room.playerCount} / ${room.maxPlayers}명 입장 (최소 ${room.minPlayers}명)`;
    playersEl.replaceChildren(...(s.players.length
      ? s.players.map((p) => el('li', { 'data-player-id': p.playerId, text: `${p.playerId} · ${p.nickname}` }))
      : [el('li', { class: 'dk-muted', text: '아직 입장한 참가자가 없습니다.' })]));
    const inLobby = room.status === 'lobby';
    startBtn.classList.toggle('dk-hidden', !inLobby);
    startBtn.disabled = starting || !inLobby || room.playerCount < room.minPlayers;
    renderPrecheck(s, room, joinUrl, inLobby);
    finishedEl.replaceChildren(room.status === 'finished'
      ? el('div', { class: 'dk-actions' }, [el('a', { class: 'dk-btn', href: `host.html?game=${encodeURIComponent(room.gameId)}`, 'data-action': 'new-room', text: '새 게임방 만들기' })])
      : '');
    if (!inLobby && s.privateDoc?.view) {
      if (!gameArea) {
        const game = getGame(room.gameId);
        if (game && game.manifest.gameVersion !== room.gameVersion) {
          notice.replaceChildren(message(`이 화면의 게임 버전(${game.manifest.gameVersion})과 방의 게임 버전(${room.gameVersion})이 다릅니다.`, 'error'));
        }
        gameArea = createGameArea(gameEl, { gameId: room.gameId, role: 'host', session: createOnlineSession(api, roomId), now: clock.now });
      }
      gameArea.update(s.privateDoc.view, room.result, room.publicView, room.inputCounts || null);
    }
  }

  /** 시작 전 점검 (대기실에서만). 측정하지 않은 항목은 정상으로 표시하지 않는다. */
  function renderPrecheck(s, room, joinUrl, inLobby) {
    precheck.classList.toggle('dk-hidden', !inLobby);
    if (!inLobby) return;
    const local = isLocalOnlyUrl(joinUrl);
    const row = (state, label, detail) => el('li', { 'data-check': label, 'data-state': state }, [
      el('span', { class: `dk-check dk-check--${state}`, text: { ok: '✓ 확인', warn: '! 주의', fail: '✕ 문제', none: '– 측정 안 함' }[state] }),
      el('strong', { text: ` ${label}` }), detail ? ` — ${detail}` : '',
    ]);
    precheck.replaceChildren(
      el('h2', { text: '시작 전 점검' }),
      el('ul', { class: 'dk-checklist' }, [
        row(s.connection === 'online' ? 'ok' : 'warn', '실시간 연결', CONNECTION_LABEL[s.connection] || s.connection),
        row(clockState === 'ok' ? 'ok' : clockState === 'fail' ? 'fail' : 'warn', '서버 기능 응답', clockState === 'ok' ? '서버 시각 확인됨' : clockState === 'fail' ? '응답 없음 — 제출·진행이 동작하지 않습니다' : '확인 중'),
        row(local ? 'warn' : 'ok', '참가자 접속 주소', local ? `${joinUrl} (로컬 주소 — 이 PC에서만 열리며 휴대폰 접속용이 아닙니다)` : joinUrl),
        row(joinQr.element.querySelector('svg') ? 'ok' : 'fail', 'QR코드 생성', joinQr.element.querySelector('svg') ? '생성됨' : '생성 안 됨'),
        row(room.playerCount >= room.minPlayers ? 'ok' : 'warn', '참가 인원', `${room.playerCount} / ${room.maxPlayers}명 (시작 최소 ${room.minPlayers}명)`),
        row(room.playerCount >= room.minPlayers ? 'ok' : 'warn', '게임 시작 가능', room.playerCount >= room.minPlayers ? '시작할 수 있음' : '인원 부족'),
        row('none', '네트워크 속도·지연', '이 화면은 측정하지 않습니다'),
      ]),
    );
  }

  stopWatch = watchRoom(services, { roomId, uid: user.uid, role: 'host' }, update);
}

async function boot() {
  try {
    services = initFirebase(location.hostname, 'dkba-host');
  } catch (err) {
    setModeBadge('unconfigured');
    fatal(err.message);
    return;
  }
  setModeBadge(services.mode);
  api = createRoomApi(services);
  clock = createServerClock(api);
  root.replaceChildren(el('section', { class: 'dk-card' }, [message('… 로그인 상태 확인 중')]));
  const current = await waitForUser(services.auth);
  if (current && !current.isAnonymous) {
    user = current;
    afterLogin();
  } else {
    renderLogin();
  }
}

// 화면을 떠날 때 실시간 구독 해제, 뒤로 가기 캐시에서 복원되면 다시 연결
window.addEventListener('pagehide', () => { stopWatch?.(); stopWatch = null; });
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
boot();
