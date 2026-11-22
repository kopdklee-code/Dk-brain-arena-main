// 참가 주소 QR 코드 (플랫폼 공통, 게임 모듈과 무관). 네트워크 없이 브라우저 안에서 SVG 로 그린다.
import qrcode from 'qrcode-generator';

const SVG_NS = 'http://www.w3.org/2000/svg';
const QUIET = 4; // QR 규격의 여백(모듈 4칸)

/** 참가 주소: play.html?code=XXXXXX (코드가 입력된 상태로 입장 화면이 열림) */
export function joinUrlFor(code, base = location.href) {
  const url = new URL('play.html', base);
  if (code) url.searchParams.set('code', code);
  return url.href;
}

/** 텍스트 → 정사각형 SVG. 오류 정정 M(약 15% 손상 복구) */
export function qrSvg(text, { label = text } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + QUIET * 2;
  let d = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

/**
 * 참가 QR 영역. update(code) 로 코드가 정해지거나 바뀔 때만 다시 그린다.
 * 반환: { element, update(code) }
 */
export function createJoinQr({ size = 'md' } = {}) {
  const element = document.createElement('figure');
  element.className = `dk-qr dk-qr--${size}`;
  element.setAttribute('data-join-qr', '');
  const box = document.createElement('div');
  box.className = 'dk-qr__img';
  const caption = document.createElement('figcaption');
  caption.className = 'dk-qr__caption';
  caption.textContent = '휴대폰 카메라로 찍으면 입장 화면이 열립니다';
  element.append(box, caption);
  let current = null;
  return {
    element,
    update(code) {
      if (!code || code === current) return;
      current = code;
      const url = joinUrlFor(code);
      element.setAttribute('data-join-url', url);
      box.replaceChildren(qrSvg(url, { label: `참가 QR 코드 (입장 코드 ${code})` }));
    },
  };
}
