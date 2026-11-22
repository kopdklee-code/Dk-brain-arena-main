// 플랫폼 공통 화면 도우미 (게임 모듈과 무관)

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const CONNECTION_LABEL = {
  connecting: '… 연결 중',
  online: '● 연결됨',
  reconnecting: '↻ 재연결 중',
  offline: '× 오프라인 — 연결 대기',
  error: '! 연결 오류',
};

export const ROOM_STATUS_LABEL = {
  lobby: '대기 중',
  playing: '진행 중',
  finished: '종료',
};

export function pill(state, label) {
  return el('span', { class: 'dk-pill', 'data-state': state, text: label });
}

export function message(text, kind = 'info') {
  return el('p', { class: `dk-message dk-message--${kind}`, role: kind === 'error' ? 'alert' : 'status', text });
}

export function setModeBadge(mode) {
  const badge = document.querySelector('[data-mode-badge]');
  if (!badge) return;
  badge.textContent = mode === 'emulator' ? '로컬 에뮬레이터' : mode === 'production' ? '운영' : '설정 없음';
}

export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

export function setParams(params) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  history.replaceState(null, '', url);
}

export function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 게임 전용 CSS 를 한 번만 불러온다 */
export function ensureGameCss(gameId) {
  const id = `game-css-${gameId}`;
  if (document.getElementById(id)) return;
  document.head.append(el('link', { id, rel: 'stylesheet', href: `games/${gameId}/game.css` }));
}

export const DISTRIBUTION_LABEL = {
  platform: '플랫폼판 (온라인, Firebase)',
  'offline-standalone': '오프라인 실행형 (standalone.html)',
  'buyer-firebase': '구매자 Firebase 설치형',
};

export const SCREEN_LABEL = { host: '진행자(PC)', player: '참가자(모바일)', display: '공개 화면', local: '오프라인 단일 PC' };
