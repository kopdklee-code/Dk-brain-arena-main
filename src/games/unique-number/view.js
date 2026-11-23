// 단 하나의 숫자 — 화면 원본 (진행자·참가자·공개 화면).
// 서버가 정한 view 를 그리고 입력을 send(action)로 전달한다. Firebase·로그인·저장소를 알지 못한다.
// 시각은 플랫폼이 준 now()(서버 기준 추정 시각)로 표시만 한다. 마감·판정은 서버가 서버 시각으로 한다.

export const REVEAL_STEP_MS = 400; // 숫자 하나 공개 간격
export const REVEAL_TOTAL_MS = REVEAL_STEP_MS * 20; // 8초 (지시문 §5.3: 6~10초)
const BANNER_DELAY_MS = 600;

const PHASE_LABEL = {
  LOBBY: '라운드 시작 대기',
  ROUND_ACTIVE: '선택 진행 중',
  ROUND_CLOSED: '선택 마감 — 결과 공개 대기',
  ROUND_RESULT: '결과 공개',
  GAME_FINISHED: '게임 종료',
};

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
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 남은 시간 표시 (올림 초, 00:12) */
export function formatRemaining(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** 숫자 하나의 판정 표시 (색 + 기호 + 글자) */
function statusOf(count, n, winningNumber) {
  if (count === 0) return { cls: 'zero', short: '–', text: '선택 없음' };
  if (count >= 2) return { cls: 'dup', short: '✕ 중복', text: '중복 무효' };
  if (n === winningNumber) return { cls: 'win', short: '★ 승리', text: '첫 유효 숫자 — 승리' };
  return { cls: 'valid', short: '○ 유효', text: '유효 (더 작은 유일 숫자가 있음)' };
}

const ERROR_SUBMIT = '숫자 제출을 확인하지 못했습니다. 다시 시도해 주세요.';

/**
 * @param {HTMLElement} root
 * @param {{ role:'host'|'player'|'display', send?:Function, now?:()=>number }} options
 */
export function mount(root, { role, send, now = () => Date.now() }) {
  const box = el('div', { class: `g-un g-un--${role}`, 'data-role': role });
  root.replaceChildren(box);

  let pub = null; // 공개 상태
  let mine = null; // 참가자 본인 상태
  let hostView = null; // 진행자 감사 기록
  let counts = null; // 플랫폼 화면 집계: 입력 창별 제출 인원 (진행 중 표시용)
  let selected = null; // 화면에서 고른 숫자 (아직 서버 확정 아님)
  let ack = null; // 서버 응답으로 확정된 숫자 (개인 문서 도착 전)
  let attemptKey = '';
  let busy = null; // 진행 중인 요청 종류
  let lastError = '';
  let confirmKind = null; // 진행자 두 단계 확인: 'void' | 'end'
  let tickers = [];
  const firstSeen = new Map();
  let autoClose = { key: '', nextAt: 0, inFlight: false };

  const key = () => (pub ? `${pub.round}:${pub.attempt}` : '');
  /** 제출 완료 인원: 진행 중에는 서버 집계(inputCounts), 마감 후에는 확정 판정의 인원 */
  const submittedCount = () => (pub.phase === 'ROUND_ACTIVE' ? Math.min(pub.playerCount, counts?.[pub.inputKey] || 0) : pub.submittedCount ?? 0);
  const mineMatches = () => mine && pub && mine.round === pub.round && mine.attempt === pub.attempt;
  const confirmedNumber = () => {
    if (!pub || pub.phase === 'LOBBY') return null;
    if (ack && ack.key === key()) return ack.number;
    return mineMatches() && mine.current ? mine.current.number : null;
  };
  const remainingMs = () => {
    if (!pub || pub.phase !== 'ROUND_ACTIVE') return null;
    if (pub.paused) return pub.pausedRemainingMs;
    return Math.max(0, pub.deadlineAt - now());
  };
  const timeUp = () => pub?.phase === 'ROUND_ACTIVE' && !pub.paused && now() >= pub.deadlineAt;
  const currentResult = () => (pub && (pub.phase === 'ROUND_RESULT' || pub.phase === 'GAME_FINISHED') ? pub.results.at(-1) || null : null);

  function revealProgress(r) {
    if (!r) return { shown: 0, done: true };
    if (pub.phase === 'GAME_FINISHED' || pub.revealSkipped || pub.results.at(-1) !== r) return { shown: 20, done: true };
    const k = `${r.round}:${r.attempt}`;
    if (!firstSeen.has(k)) firstSeen.set(k, Date.now());
    // 서버 기준 경과와 이 화면에서 본 뒤 경과 중 큰 값 (새로고침해도 이어서, 시계가 늦어도 멈추지 않게)
    const elapsed = Math.max(now() - r.revealedAt, Date.now() - firstSeen.get(k));
    const shown = elapsed < 0 ? 0 : Math.min(20, Math.floor(elapsed / REVEAL_STEP_MS) + 1);
    return { shown, done: elapsed >= REVEAL_TOTAL_MS + BANNER_DELAY_MS };
  }

  async function act(kind, action) {
    if (!send || busy) return null;
    busy = kind;
    lastError = '';
    draw();
    let res;
    try {
      res = await send(action);
    } catch (e) {
      res = { ok: false, error: { code: 'client', message: e?.message } };
    }
    busy = null;
    if (!res?.ok) {
      const code = res?.error?.code || '';
      const noResponse = code.startsWith('functions/') || code === 'client';
      lastError = kind === 'submit' && noResponse ? ERROR_SUBMIT : (res?.error?.message || '요청을 처리하지 못했습니다.');
    }
    draw();
    return res;
  }

  async function submit() {
    if (selected === null || !pub) return;
    const number = selected;
    const k = key();
    const res = await act('submit', { type: 'submit', round: pub.round, attempt: pub.attempt, value: number });
    if (res?.ok && k === key()) { ack = { key: k, number }; draw(); }
  }

  function hostAction(kind, type, extra = {}) {
    confirmKind = null;
    return act(kind, { type, round: pub.round, attempt: pub.attempt, ...extra });
  }

  // 마감 시각이 지나면 서버에 마감 확정을 요청 (진행자 화면 우선, 참가자 화면은 진행자가 없을 때의 예비 요청)
  function maybeAutoClose() {
    if (!send || !pub || pub.phase !== 'ROUND_ACTIVE' || pub.paused || !pub.deadlineAt) return;
    const k = key();
    if (autoClose.key !== k) {
      autoClose = { key: k, inFlight: false, nextAt: role === 'host' ? pub.deadlineAt + 300 : pub.deadlineAt + 6000 + Math.floor(Math.random() * 4000) };
    }
    if (autoClose.inFlight || now() < autoClose.nextAt) return;
    autoClose.inFlight = true;
    Promise.resolve(send({ type: 'close-round', round: pub.round, attempt: pub.attempt })).catch(() => null).then(() => {
      autoClose.inFlight = false;
      autoClose.nextAt = now() + (role === 'host' ? 2000 : 8000);
    });
  }

  // ── 공통 조각 ─────────────────────────────────────────
  function timerEl(big = false) {
    const node = el('div', { class: `g-un__timer${big ? ' g-un__timer--big' : ''}`, 'data-timer': true, role: 'timer', 'aria-live': 'off' });
    tickers.push(() => {
      const ms = remainingMs();
      if (ms === null) { node.textContent = ''; return; }
      node.textContent = pub.paused ? `⏸ ${formatRemaining(ms)}` : formatRemaining(ms);
      node.classList.toggle('is-urgent', !pub.paused && ms <= 10000);
      node.classList.toggle('is-paused', pub.paused);
    });
    return node;
  }

  function roundLabel() {
    if (!pub) return '';
    return `ROUND ${pub.round} / ${pub.totalRounds}${pub.attempt > 1 ? ` · 재진행 ${pub.attempt}차` : ''}`;
  }

  function restartNotice() {
    if (!pub?.restart || pub.restart.round !== pub.round || pub.phase === 'ROUND_RESULT' || pub.phase === 'GAME_FINISHED') return null;
    return el('p', { class: 'g-un__notice g-un__notice--warn', role: 'status', 'data-restart': true, text: `⟳ ${pub.restart.round}라운드를 다시 진행합니다. 이전 선택은 반영되지 않으니 새로 골라 주세요.` });
  }

  function chart(r, { compact = false } = {}) {
    const max = Math.max(1, ...r.distribution);
    const cols = r.distribution.map((count, i) => {
      const n = i + 1;
      const st = statusOf(count, n, r.winningNumber);
      const col = el('li', { class: `g-un__col is-${st.cls}`, 'data-number': n, 'data-count': count }, [
        el('span', { class: 'g-un__count', text: `${count}명` }),
        el('span', { class: 'g-un__bar-wrap' }, el('span', { class: 'g-un__bar', style: `height:${count === 0 ? 3 : Math.max(8, Math.round((count / max) * 100))}%` })),
        el('span', { class: 'g-un__num-label', text: String(n) }),
        compact ? null : el('span', { class: 'g-un__st', text: st.short }),
      ]);
      col.setAttribute('aria-label', `숫자 ${n}: ${count}명 선택, ${st.text}`);
      return col;
    });
    const caption = el('p', { class: 'g-un__step', 'aria-live': 'polite', 'data-reveal-step': true });
    const list = el('ol', { class: `g-un__chart${compact ? ' g-un__chart--compact' : ''}`, 'aria-label': `${r.round}라운드 숫자별 선택 인원` }, cols);
    const wrap = el('div', { class: 'g-un__chart-wrap' }, [list, caption]);
    let lastKey = '';
    tickers.push(() => {
      const { shown, done } = revealProgress(r);
      const k = `${shown}|${done}`;
      if (k === lastKey) return; // 공개 개수 또는 완료 여부가 바뀔 때만 갱신
      lastKey = k;
      cols.forEach((c, i) => c.classList.toggle('is-hidden', i >= shown));
      wrap.classList.toggle('is-done', done);
      if (shown > 0 && !done) {
        const n = shown;
        const count = r.distribution[n - 1];
        caption.textContent = `숫자 ${n} → ${count}명 선택 → ${statusOf(count, n, r.winningNumber).text}`;
      } else if (done) {
        caption.textContent = r.winningNumber ? `승리 숫자는 ${r.winningNumber}입니다.` : '유효한 숫자가 없습니다.';
      }
    });
    return wrap;
  }

  function winnerBanner(r) {
    const node = r.winningNumber
      ? el('div', { class: 'g-un__banner g-un__banner--win', 'data-winner': true }, [
        el('p', { class: 'g-un__banner-kicker', text: `ROUND ${r.round} WINNER` }),
        el('p', { class: 'g-un__banner-main' }, [el('span', { text: '승리 숫자 ' }), el('strong', { 'data-winning-number': true, text: String(r.winningNumber) })]),
        el('p', { class: 'g-un__banner-name' }, ['🏆 ', el('strong', { 'data-winner-name': true, text: r.winnerName })]),
      ])
      : el('div', { class: 'g-un__banner g-un__banner--none', 'data-winner': 'none' }, [
        el('p', { class: 'g-un__banner-kicker', text: `ROUND ${r.round}` }),
        el('p', { class: 'g-un__banner-main', text: '이번 라운드에는 승자가 없습니다.' }),
        el('p', { class: 'g-un__banner-name', text: r.submittedCount ? '혼자 고른 숫자가 하나도 없었습니다 (모두 중복).' : '제출한 사람이 없었습니다.' }),
      ]);
    tickers.push(() => node.classList.toggle('is-hidden', !revealProgress(r).done));
    return node;
  }

  function finalBoard({ highlight } = {}) {
    const champions = pub.standings.filter((s) => s.rank === 1 && s.wins > 0);
    const aborted = pub.ended?.reason === 'aborted';
    return el('div', { class: 'g-un__final', 'data-final': true }, [
      el('p', { class: 'g-un__banner-kicker', text: aborted ? '게임 중단 — 공개된 결과 기준' : 'FINAL RESULT' }),
      champions.length
        ? el('p', { class: 'g-un__final-champ' }, [`🏆 ${champions.length > 1 ? '공동 우승' : '최종 우승'}: `, el('strong', { 'data-champions': true, text: champions.map((c) => c.name).join(', ') }), ` (${champions[0].wins}승)`])
        : el('p', { class: 'g-un__final-champ', 'data-champions': '', text: '승리한 참가자가 없습니다.' }),
      aborted ? el('p', { class: 'g-un__notice g-un__notice--warn', text: `진행자가 ${pub.ended.round}라운드 중 게임을 중단했습니다. 공개된 ${pub.results.length}개 라운드 결과만 반영했습니다.` }) : null,
      el('ol', { class: 'g-un__ranking', 'data-ranking': true }, pub.standings.map((s) => el('li', {
        class: s.playerId === highlight ? 'is-me' : '', 'data-player': s.playerId,
      }, [el('span', { class: 'g-un__rank', text: `${s.rank}위` }), el('span', { class: 'g-un__rank-name', text: s.name }), el('span', { class: 'g-un__rank-wins', text: `${s.wins}승` })]))),
    ]);
  }

  function rulesPanel() {
    return el('ul', { class: 'g-un__rules' }, [
      el('li', { text: '1~20 중 숫자 하나를 골라 제출합니다.' }),
      el('li', { text: '다른 사람과 겹친 숫자는 무효입니다.' }),
      el('li', { text: '혼자 고른 숫자 중 가장 작은 숫자가 승리(1승)합니다.' }),
      el('li', { text: '3라운드 누적 승리로 순위를 정합니다. 같으면 공동 순위.' }),
    ]);
  }

  // ── 참가자 화면 ───────────────────────────────────────
  function drawPlayer() {
    const nodes = [];
    nodes.push(el('div', { class: 'g-un__top' }, [
      el('span', { class: 'g-un__round', text: roundLabel() }),
      pub.phase === 'ROUND_ACTIVE' ? timerEl() : el('span', { class: 'g-un__phase', text: PHASE_LABEL[pub.phase] }),
    ]));
    const rn = restartNotice();
    if (rn) nodes.push(rn);

    if (pub.phase === 'LOBBY') {
      nodes.push(el('p', { class: 'g-un__lead', text: `곧 ${pub.round}라운드가 시작됩니다.` }), rulesPanel());
    } else if (pub.phase === 'ROUND_ACTIVE') {
      const closed = timeUp();
      const disabled = busy === 'submit' || pub.paused || closed;
      const confirmed = confirmedNumber();
      const grid = el('div', { class: 'g-un__grid', role: 'group', 'aria-label': '숫자 선택 (1~20)' });
      for (let n = 1; n <= pub.maxNumber; n += 1) {
        grid.append(el('button', {
          type: 'button', class: `g-un__num${selected === n ? ' is-selected' : ''}${confirmed === n ? ' is-confirmed' : ''}`,
          'data-choice': n, 'aria-pressed': selected === n ? 'true' : 'false', disabled,
          text: String(n),
          onclick: () => { selected = n; lastError = ''; draw(); },
        }));
      }
      nodes.push(grid);
      const same = selected !== null && selected === confirmed;
      nodes.push(el('div', { class: 'g-un__actions' }, el('button', {
        type: 'button', class: 'g-un__submit', 'data-action': 'submit',
        disabled: disabled || selected === null || same,
        text: busy === 'submit' ? '제출 중…' : same ? '✓ 제출 완료' : confirmed !== null ? `${selected}(으)로 변경 제출` : '제출하기',
        onclick: submit,
      })));
      let status;
      if (pub.paused) status = el('p', { class: 'g-un__notice g-un__notice--warn', 'data-paused': true, text: '⏸ 일시정지 중입니다. 진행자가 재개하면 계속됩니다. (지금은 제출·변경 불가)' });
      else if (closed) status = el('p', { class: 'g-un__notice', text: '선택 시간이 끝났습니다. 마감을 확정하는 중입니다.' });
      else if (busy === 'submit') status = el('p', { class: 'g-un__notice', text: '… 제출 중 — 서버 확인을 기다리고 있습니다.' });
      else if (lastError) status = el('p', { class: 'g-un__notice g-un__notice--error', role: 'alert', text: lastError });
      else if (same) status = el('div', { class: 'g-un__notice g-un__notice--ok', 'data-submitted': confirmed }, [el('strong', { text: `선택한 숫자: ${confirmed}` }), el('br'), '✓ 제출 완료! 마감 전에는 다른 숫자로 변경할 수 있습니다.']);
      else if (confirmed !== null) status = el('p', { class: 'g-un__notice', 'data-submitted': confirmed, text: `✓ 제출된 숫자: ${confirmed} · 새로 고른 ${selected}은(는) 아직 제출되지 않았습니다. 제출 버튼을 눌러야 바뀝니다.` });
      else if (selected !== null) status = el('p', { class: 'g-un__notice', text: `${selected}을(를) 골랐습니다. 제출 버튼을 눌러야 확정됩니다.` });
      else status = el('p', { class: 'g-un__notice', text: '숫자를 하나 고른 뒤 제출 버튼을 누르세요.' });
      nodes.push(el('div', { 'aria-live': 'polite', 'data-submit-status': true }, status));
    } else if (pub.phase === 'ROUND_CLOSED') {
      const n = mineMatches() && mine.current ? mine.current.number : null;
      nodes.push(el('p', { class: 'g-un__lead', text: '선택이 마감되었습니다.' }));
      nodes.push(el('p', { class: 'g-un__notice', 'data-final-pick': n ?? 'none', text: n !== null ? `내 최종 선택: ${n} — 결과 공개를 기다리는 중입니다.` : '이번 라운드에 제출하지 않았습니다 (미참여).' }));
    } else if (pub.phase === 'ROUND_RESULT') {
      const r = currentResult();
      const pending = el('p', { class: 'g-un__notice', text: '결과를 공개하고 있습니다… 앞 화면을 봐 주세요.' });
      const card = myResultCard(r);
      tickers.push(() => { const { done } = revealProgress(r); pending.classList.toggle('is-hidden', done); card.classList.toggle('is-hidden', !done); });
      nodes.push(pending, card);
    } else if (pub.phase === 'GAME_FINISHED') {
      const me = pub.standings.find((s) => s.playerId === mine?.playerId);
      if (me) nodes.push(el('p', { class: 'g-un__lead', 'data-my-rank': me.rank, text: `내 최종 순위: ${me.rank}위${pub.standings.filter((s) => s.rank === me.rank).length > 1 ? ' (공동)' : ''} · 누적 ${me.wins}승` }));
      nodes.push(finalBoard({ highlight: mine?.playerId }));
    }
    return nodes;
  }

  function myResultCard(r) {
    const h = mine?.history?.find((x) => x.round === r.round);
    if (!h) return el('div', { class: 'g-un__card', text: '내 결과를 불러오는 중…' });
    const me = pub.standings.find((s) => s.playerId === mine.playerId);
    const rows = [];
    if (h.number === null) {
      rows.push(['내가 선택한 숫자', '제출하지 않음 (미참여)']);
    } else {
      const count = r.distribution[h.number - 1];
      const st = statusOf(count, h.number, r.winningNumber);
      rows.push(['내가 선택한 숫자', String(h.number)]);
      rows.push(['같은 숫자를 고른 인원', `${count}명${count > 1 ? ' (나 포함)' : ' (나 혼자)'}`]);
      rows.push(['판정', count >= 2 ? '✕ 중복 무효' : h.number === r.winningNumber ? '★ 유효 — 가장 작은 유일 숫자' : `○ 유효 — 하지만 더 작은 유일 숫자 ${r.winningNumber}이(가) 있었습니다`]);
    }
    rows.push(['이번 라운드 승리 숫자', r.winningNumber ? String(r.winningNumber) : '없음 (승자 없음)']);
    const won = r.winnerId === mine.playerId;
    rows.push(['나의 결과', won ? '★ 이번 라운드 승리! (+1승)' : '이번 라운드는 승리하지 못했습니다']);
    rows.push(['누적 승리', `${me ? me.wins : 0}승`]);
    return el('div', { class: `g-un__card${won ? ' is-win' : ''}`, 'data-my-result': true }, [
      el('dl', { class: 'g-un__dl' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      el('p', { class: 'g-un__next', text: r.round < pub.totalRounds ? `진행자가 ${r.round + 1}라운드를 시작하면 바로 숫자를 고를 수 있습니다.` : '진행자가 최종 결과를 발표합니다.' }),
    ]);
  }

  // ── 진행자 화면 ───────────────────────────────────────
  function btn(label, attrs) {
    return el('button', { type: 'button', class: 'g-un__btn', ...attrs, text: label, disabled: attrs.disabled || !!busy });
  }

  function drawHost() {
    const nodes = [];
    const statusItems = [
      el('strong', { class: 'g-un__round', 'data-host-round': true, text: roundLabel() }),
      el('span', { 'data-player-count': pub.playerCount, text: `참가자: ${pub.playerCount}명` }),
      el('span', { 'data-submitted-count': submittedCount(), text: `제출 완료: ${submittedCount()}명` }),
    ];
    if (pub.phase === 'ROUND_ACTIVE') statusItems.push(el('span', {}, ['남은 시간: ', timerEl()]));
    statusItems.push(el('span', { class: 'g-un__phase', 'data-phase': pub.phase, text: pub.phase === 'ROUND_ACTIVE' && pub.paused ? '⏸ 일시정지' : PHASE_LABEL[pub.phase] }));
    nodes.push(el('div', { class: 'g-un__hoststatus', role: 'status' }, statusItems));
    const rn = restartNotice();
    if (rn) nodes.push(rn);

    const controls = [];
    if (pub.phase === 'LOBBY') {
      controls.push(btn(pub.restart?.round === pub.round ? `${pub.round}라운드 다시 시작` : `${pub.round}라운드 시작 (${pub.roundSeconds}초)`, {
        class: 'g-un__btn g-un__btn--primary', 'data-action': 'start-round', onclick: () => hostAction('start', 'start-round'),
      }));
    } else if (pub.phase === 'ROUND_ACTIVE') {
      if (pub.paused) controls.push(btn('▶ 재개', { class: 'g-un__btn g-un__btn--primary', 'data-action': 'resume', onclick: () => hostAction('resume', 'resume') }));
      else controls.push(btn('⏸ 긴급 일시정지', { 'data-action': 'pause', onclick: () => hostAction('pause', 'pause') }));
      const closeBtn = btn('마감 확정', { 'data-action': 'close-round', onclick: () => hostAction('close', 'close-round') });
      tickers.push(() => closeBtn.classList.toggle('is-hidden', !timeUp()));
      controls.push(closeBtn);
    } else if (pub.phase === 'ROUND_CLOSED') {
      controls.push(btn('결과 공개', { class: 'g-un__btn g-un__btn--primary', 'data-action': 'reveal', onclick: () => hostAction('reveal', 'reveal') }));
      controls.push(confirmKind === 'void'
        ? el('span', { class: 'g-un__confirm' }, ['이번 시도를 무효로 하고 같은 라운드를 다시 진행할까요? ',
          btn('무효화 확정', { class: 'g-un__btn g-un__btn--danger', 'data-action': 'void-confirm', onclick: () => hostAction('void', 'void-round') }),
          btn('취소', { onclick: () => { confirmKind = null; draw(); } })])
        : btn('라운드 무효화 후 재진행', { 'data-action': 'void-round', onclick: () => { confirmKind = 'void'; draw(); } }));
    } else if (pub.phase === 'ROUND_RESULT') {
      const r = currentResult();
      const skip = btn('건너뛰기 (전체 결과 바로 표시)', { 'data-action': 'skip-reveal', onclick: () => hostAction('skip', 'skip-reveal') });
      tickers.push(() => skip.classList.toggle('is-hidden', revealProgress(r).done));
      controls.push(skip);
      controls.push(pub.round < pub.totalRounds
        ? btn(`${pub.round + 1}라운드 시작 (${pub.roundSeconds}초)`, { class: 'g-un__btn g-un__btn--primary', 'data-action': 'next-round', onclick: () => act('start', { type: 'start-round', round: pub.round + 1 }) })
        : btn('최종 결과 발표', { class: 'g-un__btn g-un__btn--primary', 'data-action': 'finish-game', onclick: () => hostAction('finish', 'finish-game') }));
    }
    if (pub.phase !== 'GAME_FINISHED') {
      controls.push(confirmKind === 'end'
        ? el('span', { class: 'g-un__confirm' }, ['게임을 중단하고 종료할까요? 공개된 결과만 남습니다. ',
          btn('중단 확정', { class: 'g-un__btn g-un__btn--danger', 'data-action': 'end-confirm', onclick: () => hostAction('end', 'end-game') }),
          btn('취소', { onclick: () => { confirmKind = null; draw(); } })])
        : btn('게임 중단', { class: 'g-un__btn g-un__btn--ghost', 'data-action': 'end-game', onclick: () => { confirmKind = 'end'; draw(); } }));
    }
    nodes.push(el('div', { class: 'g-un__controls' }, controls));
    if (busy) nodes.push(el('p', { class: 'g-un__notice', text: '… 서버 처리 중' }));
    if (lastError) nodes.push(el('p', { class: 'g-un__notice g-un__notice--error', role: 'alert', text: lastError }));
    if (pub.phase === 'ROUND_ACTIVE' || pub.phase === 'ROUND_CLOSED') {
      nodes.push(el('p', { class: 'g-un__muted', text: '진행 중·공개 전에는 진행자 화면에도 제출된 숫자와 분포가 표시되지 않습니다 (힌트 노출 방지).' }));
    }
    if (pub.phase === 'ROUND_RESULT') {
      const r = currentResult();
      nodes.push(chart(r), winnerBanner(r));
    }
    if (pub.phase === 'GAME_FINISHED') nodes.push(finalBoard());
    if (pub.results.length) {
      nodes.push(el('details', { class: 'g-un__history' }, [
        el('summary', { text: `공개된 라운드 결과 (${pub.results.length})` }),
        el('ul', {}, pub.results.map((r) => el('li', { text: `${r.round}라운드${r.attempt > 1 ? `(${r.attempt}차)` : ''}: 제출 ${r.submittedCount}/${r.participantCount}명 · 승리 숫자 ${r.winningNumber ?? '없음'}${r.winnerName ? ` · ${r.winnerName}` : ''}` }))),
      ]));
    }
    const audit = hostView?.audit || [];
    if (audit.length) {
      const label = { void: '라운드 무효화', pause: '일시정지', resume: '재개', abort: '게임 중단' };
      nodes.push(el('details', { class: 'g-un__history', 'data-audit': true }, [
        el('summary', { text: `감사 기록 (${audit.length})` }),
        el('ul', {}, audit.map((a) => el('li', { text: `${label[a.type] || a.type} · ${a.round}라운드 ${a.attempt}차${a.type === 'void' ? ` · 당시 제출 ${a.submittedCount}명` : ''}${a.remainingMs != null ? ` · 남은 ${formatRemaining(a.remainingMs)}` : ''}` }))),
      ]));
    }
    return nodes;
  }

  // ── 공개 화면 ─────────────────────────────────────────
  function drawDisplay() {
    const nodes = [el('div', { class: 'g-un__top' }, [
      el('span', { class: 'g-un__title', text: '단 하나의 숫자' }),
      el('span', { class: 'g-un__round', 'data-display-round': true, text: roundLabel() }),
    ])];
    const rn = restartNotice();
    if (rn) nodes.push(rn);
    if (pub.phase === 'LOBBY') {
      nodes.push(el('p', { class: 'g-un__lead', text: pub.restart?.round === pub.round ? `${pub.round}라운드를 다시 시작합니다.` : `곧 ${pub.round}라운드가 시작됩니다.` }), rulesPanel());
    } else if (pub.phase === 'ROUND_ACTIVE') {
      const count = el('p', { class: 'g-un__subcount', 'data-display-submitted': submittedCount(), text: `제출 ${submittedCount()} / ${pub.playerCount}명` });
      const bar = el('div', { class: 'g-un__progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': pub.playerCount, 'aria-valuenow': submittedCount() },
        el('span', { style: `width:${pub.playerCount ? Math.round((submittedCount() / pub.playerCount) * 100) : 0}%` }));
      const state = el('p', { class: 'g-un__lead' });
      tickers.push(() => {
        state.textContent = pub.paused ? '⏸ 일시정지 — 진행자가 재개하면 계속됩니다' : timeUp() ? '선택이 마감되었습니다 · 집계 중' : '1~20 중 숫자 하나를 고르세요';
        state.classList.toggle('g-un__notice--warn', pub.paused);
      });
      nodes.push(timerEl(true), state, count, bar);
    } else if (pub.phase === 'ROUND_CLOSED') {
      nodes.push(el('p', { class: 'g-un__big', text: '선택이 마감되었습니다.' }), el('p', { class: 'g-un__lead', 'data-closed': true, text: `${submittedCount()}명의 선택을 공개합니다.` }));
    } else if (pub.phase === 'ROUND_RESULT') {
      const r = currentResult();
      nodes.push(chart(r), winnerBanner(r));
    } else if (pub.phase === 'GAME_FINISHED') {
      nodes.push(finalBoard());
    }
    return nodes;
  }

  function draw() {
    tickers = [];
    if (!pub) { box.replaceChildren(el('p', { class: 'g-un__notice', text: '… 게임 상태를 불러오는 중' })); return; }
    const nodes = role === 'host' ? drawHost() : role === 'player' ? drawPlayer() : drawDisplay();
    box.replaceChildren(...nodes);
    box.setAttribute('data-phase', pub.phase);
    tick();
  }

  function tick() {
    for (const t of tickers) t();
    if (role === 'host' || role === 'player') maybeAutoClose();
  }
  const timer = setInterval(tick, 200);

  return {
    update({ view, publicView, inputCounts }) {
      counts = inputCounts || null;
      if (role === 'display') pub = view;
      else if (publicView) pub = publicView;
      if (role === 'player') mine = view;
      if (role === 'host') hostView = view;
      if (key() !== attemptKey) { attemptKey = key(); selected = null; ack = null; lastError = ''; confirmKind = null; }
      if (role === 'player' && ack && mineMatches() && mine.current?.number === ack.number) ack = null; // 서버 문서가 따라옴
      if (role === 'player' && selected === null && pub?.phase === 'ROUND_ACTIVE') selected = confirmedNumber();
      draw();
    },
    destroy() { clearInterval(timer); box.remove(); },
  };
}
