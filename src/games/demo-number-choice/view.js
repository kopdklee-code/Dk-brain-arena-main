// 숫자 선택 샘플 — 화면 원본.
// 상태(view)를 HTML로 표시하고 입력을 send(action, options)로 전달한다.
// Firebase·로그인·저장소를 직접 호출하지 않는다. 플랫폼판과 오프라인판이 같은 파일을 사용한다.

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

const ROLE_LABEL = { host: '진행자 화면', player: '참가자 화면', display: '공개 화면', local: '오프라인 진행 화면' };

/**
 * @param {HTMLElement} root
 * @param {{role:'host'|'player'|'display'|'local', send?:(action:object, options?:{playerId?:string})=>Promise<{ok:boolean,error?:{message:string}}>}} options
 */
export function mount(root, { role, send }) {
  const container = el('div', { class: `g-dnc g-dnc--${role}`, 'data-role': role });
  root.replaceChildren(container);
  let busyKey = null;
  let lastError = '';
  let current = null;

  async function act(key, action, opts) {
    if (!send || busyKey) return;
    busyKey = key;
    lastError = '';
    draw();
    let res;
    try {
      res = await send(action, opts);
    } catch (err) {
      res = { ok: false, error: { message: err?.message || '요청에 실패했습니다.' } };
    }
    busyKey = null;
    if (!res?.ok) lastError = res?.error?.message || '요청에 실패했습니다.';
    draw();
  }

  function statusText(p) {
    return p.submitted ? `제출 완료: ${p.choice}` : '미제출';
  }

  function scoreTable(view) {
    const showRound = view.phase !== 'finished'; // 종료 후에는 '이번 라운드' 열을 표시하지 않음
    return el('table', { class: 'g-dnc__table' }, [
      el('caption', { text: '플레이어 현황' }),
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col', text: '플레이어' }),
        showRound ? el('th', { scope: 'col', text: '이번 라운드' }) : null,
        el('th', { scope: 'col', text: '누적 점수' }),
      ])),
      el('tbody', {}, view.players.map((p) => el('tr', { 'data-player': p.id }, [
        el('th', { scope: 'row', text: p.name + (view.me === p.id ? ' (나)' : '') }),
        showRound
          ? el('td', {}, el('span', { class: `g-dnc__badge ${p.submitted ? 'is-done' : 'is-wait'}` },
            [p.submitted ? '✓ ' : '… ', statusText(p)]))
          : null,
        el('td', { class: 'g-dnc__score', text: `${p.score}점` }),
      ]))),
    ]);
  }

  function historyList(view) {
    if (!view.history.length) return null;
    const names = Object.fromEntries(view.players.map((p) => [p.id, p.name]));
    return el('details', { class: 'g-dnc__history', open: role === 'display' || view.phase === 'finished' }, [
      el('summary', { text: '라운드 기록' }),
      el('ol', {}, view.history.map((h) => el('li', {}, [
        `${h.round}라운드: `,
        Object.keys(h.gained).map((id) =>
          `${names[id] ?? id} ${h.choices[id] === null ? '미제출' : h.choices[id]} → +${h.gained[id]}점`).join(', '),
      ]))),
    ]);
  }

  function resultBlock(result) {
    if (!result?.finished) return null;
    return el('section', { class: 'g-dnc__result', 'aria-label': '최종 결과' }, [
      el('h3', { text: '최종 결과' }),
      el('ol', { class: 'g-dnc__ranking' }, result.ranking.map((r) => el('li', { 'data-rank': r.rank }, [
        el('strong', { text: `${r.rank}위` }), ` ${r.name} · ${r.score}점`,
        result.ranking.filter((x) => x.rank === r.rank).length > 1 ? ' (공동)' : '',
      ]))),
    ]);
  }

  function choiceButtons(view, playerId, label) {
    const player = view.players.find((p) => p.id === playerId);
    const canSubmit = view.phase === 'choosing' && player && !player.submitted;
    return el('div', { class: 'g-dnc__choose', role: 'group', 'aria-label': `${label} 숫자 선택` },
      view.choices.map((value) => {
        const key = `choose:${playerId}:${value}`;
        return el('button', {
          type: 'button',
          class: 'g-dnc__choice',
          'data-choice': value,
          'data-player': playerId,
          disabled: !canSubmit || Boolean(busyKey),
          'aria-busy': busyKey === key ? 'true' : null,
          onclick: () => act(key, { type: 'choose', round: view.round, value }, { playerId }),
        }, busyKey === key ? `${value} 제출 중…` : String(value));
      }));
  }

  function closeButton(view) {
    const key = `close:${view.round}`;
    return el('button', {
      type: 'button',
      class: 'g-dnc__close',
      'data-action': 'close-round',
      disabled: !view.canClose || Boolean(busyKey),
      onclick: () => act(key, { type: 'closeRound', round: view.round }),
    }, busyKey === key ? '마감 처리 중…' : `${view.round}라운드 마감`);
  }

  function draw() {
    if (!current) return;
    const { view, result } = current;
    const finished = view.phase === 'finished';
    const children = [
      el('p', { class: 'g-dnc__demo', text: '개발 검증용 샘플 · 판매 게임 아님' }),
      el('h2', { class: 'g-dnc__round' },
        finished ? `게임 종료 (총 ${view.totalRounds}라운드)` : `${view.round} / ${view.totalRounds} 라운드 · 숫자 선택 중`),
    ];

    if (role === 'player') {
      const me = view.players.find((p) => p.id === view.me);
      if (me && !finished) {
        children.push(el('p', { class: 'g-dnc__mine', 'aria-live': 'polite' },
          me.submitted ? `이번 라운드 제출 완료: ${me.choice}. 진행자의 마감을 기다리는 중입니다.` : '1, 2, 3 중 하나를 선택하세요. 한 번만 제출할 수 있습니다.'));
        children.push(choiceButtons(view, me.id, me.name));
      }
    }

    if (role === 'local' && !finished) {
      children.push(el('div', { class: 'g-dnc__local' }, view.players.map((p) => el('section', { class: 'g-dnc__seat' }, [
        el('h3', { text: `${p.name} 입력` }),
        el('p', { text: statusText(p) }),
        choiceButtons(view, p.id, p.name),
      ]))));
    }

    children.push(scoreTable(view));

    if ((role === 'host' || role === 'local') && !finished) {
      children.push(el('div', { class: 'g-dnc__host' }, [
        closeButton(view),
        el('p', { class: 'g-dnc__hint', text: '마감하면 제출한 숫자만큼 점수를 받고, 미제출자는 0점입니다.' }),
      ]));
    }

    children.push(resultBlock(result));
    children.push(historyList(view));
    if (lastError) children.push(el('p', { class: 'g-dnc__error', role: 'alert', text: `실패: ${lastError}` }));

    container.replaceChildren(el('p', { class: 'g-dnc__role', text: ROLE_LABEL[role] || role }), ...children.filter(Boolean));
  }

  return {
    update(next) {
      // 새 확정 상태(서버 판정 또는 로컬 규칙 결과)가 오면 이전 실패 안내를 지운다.
      // 제출 여부는 항상 이 상태(view)로만 표시한다.
      current = next;
      lastError = '';
      draw();
    },
    destroy() {
      current = null;
      container.remove();
    },
  };
}
