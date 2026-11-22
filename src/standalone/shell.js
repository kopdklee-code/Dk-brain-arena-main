// 오프라인 실행형(standalone.html) 공통 껍데기.
// 같은 게임 규칙·화면 원본을 브라우저 안에서 로컬 연결부로 실행한다. 네트워크·Firebase 를 사용하지 않는다.
import { createLocalSession } from '../adapters/local-session.js';

function el(tag, attrs = {}, children = []) {
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

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 결과를 CSV 로 내보낸다 (엑셀 한글 호환을 위해 UTF-8 BOM 포함) */
function exportCsv(manifest, session) {
  const result = session.getResult();
  const state = session.getState();
  const lines = [];
  lines.push(['게임', manifest.title, '버전', manifest.gameVersion].map(csvCell).join(','));
  lines.push(['종료 여부', result.finished ? '종료' : '진행 중'].map(csvCell).join(','));
  lines.push('');
  lines.push(['순위', '플레이어', '누적 점수'].map(csvCell).join(','));
  for (const r of result.ranking) lines.push([r.rank, r.name, r.score].map(csvCell).join(','));
  if (Array.isArray(state.history)) {
    const names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
    lines.push('');
    lines.push(['라운드', '플레이어', '선택', '획득 점수'].map(csvCell).join(','));
    for (const h of state.history) {
      for (const id of Object.keys(h.gained)) {
        lines.push([h.round, names[id] ?? id, h.choices[id] ?? '미제출', h.gained[id]].map(csvCell).join(','));
      }
    }
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${manifest.gameId}-result.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function bootStandalone({ manifest, rules, view, iconUrl }) {
  const root = document.getElementById('app');
  const min = manifest.players.min;
  let session = null;
  let ui = null;
  let unsubscribe = null;

  const header = el('header', { class: 'sa-header' }, [
    iconUrl ? el('img', { src: iconUrl, alt: '', width: '40', height: '40' }) : null,
    el('div', {}, [
      el('h1', { text: manifest.title }),
      el('p', { class: 'sa-muted', text: `버전 ${manifest.gameVersion} · 오프라인 실행형 · 한 PC에서 진행자가 모든 입력을 합니다 (다기기 접속 기능 없음)` }),
    ]),
  ]);
  const demoNotice = manifest.isDemo
    ? el('p', { class: 'sa-demo', role: 'note', text: '개발 검증용 샘플입니다. 판매 상품이 아닙니다.' })
    : null;
  const toolbar = el('div', { class: 'sa-toolbar' });
  const stage = el('main', { class: 'sa-stage', id: 'stage' });
  root.replaceChildren(header, demoNotice, toolbar, stage);

  function renderSetup() {
    unsubscribe?.();
    ui?.destroy();
    session = null; ui = null; unsubscribe = null;
    toolbar.replaceChildren();
    const inputs = [];
    for (let i = 0; i < min; i += 1) {
      inputs.push(el('input', { id: `sa-name-${i + 1}`, value: `플레이어 ${i + 1}`, maxlength: '12', required: true }));
    }
    const errorEl = el('p', { class: 'sa-error', role: 'alert' });
    const form = el('form', {
      class: 'sa-form',
      onsubmit: (e) => {
        e.preventDefault();
        const names = inputs.map((inp) => inp.value.trim());
        if (names.some((n) => !n)) { errorEl.textContent = '플레이어 이름을 모두 입력하세요.'; return; }
        if (new Set(names).size !== names.length) { errorEl.textContent = '플레이어 이름이 중복되었습니다.'; return; }
        startGame(names);
      },
    }, [
      el('h2', { text: '새 게임 준비' }),
      ...inputs.map((inp, i) => el('div', { class: 'sa-field' }, [el('label', { for: inp.id, text: `플레이어 ${i + 1} 이름` }), inp])),
      el('button', { class: 'sa-btn', type: 'submit', 'data-action': 'start', text: '게임 시작' }),
      errorEl,
    ]);
    stage.replaceChildren(form);
    inputs[0].focus();
  }

  function startGame(names) {
    const players = names.map((name, i) => ({ id: `p${i + 1}`, name }));
    session = createLocalSession({ rules, players, config: manifest.defaultConfig || {} });
    stage.replaceChildren();
    ui = view.mount(stage, { role: 'local', send: (action, opts) => session.send(action, opts) });
    const exportBtn = el('button', { class: 'sa-btn sa-btn--ghost', type: 'button', 'data-action': 'export', text: '결과 내보내기 (CSV)', onclick: () => exportCsv(manifest, session) });
    const resetBtn = el('button', {
      class: 'sa-btn sa-btn--danger', type: 'button', 'data-action': 'reset', text: '진행 초기화',
      onclick: () => { if (window.confirm('진행 상황을 모두 지우고 처음으로 돌아갈까요?')) renderSetup(); },
    });
    toolbar.replaceChildren(exportBtn, resetBtn);
    unsubscribe = session.subscribe((snap) => ui.update({ view: snap.view, result: snap.result }));
  }

  renderSetup();
}
