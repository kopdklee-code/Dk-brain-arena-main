// 가위바위보 하나빼기 — 화면 원본 (진행자·참가자·공개 화면).
// 서버가 정한 view 를 그리고 입력을 send(action)로 전달한다. Firebase·로그인·저장소를 알지 못한다.
// 시각은 플랫폼이 준 now()(서버 기준 추정 시각)로 표시만 한다. 마감·판정은 서버가 서버 시각으로 한다.

const HAND = {
  1: { name: '바위' },
  2: { name: '가위' },
  3: { name: '보' },
};
// 손 아이콘 (자체 SVG — 기기마다 모양이 달라지는 이모지 대신). 색은 game.css 의 [data-hand] 변수로 정한다
const HAND_SVG = {
  1: '<rect x="11" y="24" width="42" height="31" rx="13"/><rect x="11" y="13" width="11.5" height="22" rx="5.75"/><rect x="21.5" y="11" width="11.5" height="23" rx="5.75"/><rect x="32" y="11" width="11.5" height="23" rx="5.75"/><rect x="42.5" y="14" width="10.5" height="21" rx="5.25"/><rect x="8" y="33" width="30" height="11" rx="5.5"/>',
  2: '<rect x="15" y="3" width="11" height="36" rx="5.5" transform="rotate(-13 20.5 37)"/><rect x="33" y="3" width="11" height="36" rx="5.5" transform="rotate(13 38.5 37)"/><rect x="12" y="31" width="40" height="27" rx="13"/><rect x="29" y="33" width="22" height="10" rx="5"/><rect x="9" y="40" width="25" height="10" rx="5"/>',
  3: '<rect x="21" y="12" width="9.5" height="28" rx="4.75"/><rect x="30.5" y="5" width="9.5" height="33" rx="4.75"/><rect x="40" y="6" width="9.5" height="32" rx="4.75"/><rect x="49.5" y="13" width="9" height="26" rx="4.5"/><rect x="11" y="29" width="10" height="22" rx="5" transform="rotate(-28 18 48)"/><rect x="19" y="28" width="40" height="30" rx="13"/>',
};
const TROPHY_SVG = '<path d="M18 8h28v14a14 14 0 0 1-28 0z"/><path d="M18 12H9v4a10 10 0 0 0 10 10M46 12h9v4a10 10 0 0 1-10 10" fill="none"/><path d="M28 35h8v9h-8z"/><path d="M20 46h24v8H20z"/>';
function svgIcon(markup, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = markup;
  return svg;
}
const handIcon = (h) => svgIcon(HAND_SVG[h], 'g-rps__svg');
const trophyIcon = () => svgIcon(TROPHY_SVG, 'g-rps__trophy');
const BEATS = { 1: 2, 2: 3, 3: 1 };
const outcomeOf = (me, host) => (me === host ? 'draw' : BEATS[me] === host ? 'win' : 'lose');
const OUTCOME = { win: '이김 → 생존', draw: '비김 → 탈락', lose: '짐 → 탈락' };
const REASON = { draw: '진행자와 비김', lose: '진행자에게 짐', 'no-two': '두 손을 내지 않음', 'no-one': '하나를 남기지 않음' };

// 결과 공개 연출 단계 (ms): 진행자 두 손 → 남긴 손 → 손별 인원 → 생존 발표
export const REVEAL_STEPS = Object.freeze({ host: 1200, counts: 2400, banner: 4000 });

const PHASE_LABEL = {
  LOBBY: '라운드 시작 대기',
  PICK_TWO: '① 두 손 내기',
  PICK_ONE: '② 하나 빼기',
  ROUND_CLOSED: '마감 — 결과 공개 대기',
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

export function formatRemaining(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
const handLabel = (h) => HAND[h].name;
const pairCode = (two) => Math.min(...two) * 10 + Math.max(...two);
const ERROR_SUBMIT = '손을 낸 것을 확인하지 못했습니다. 다시 시도해 주세요.';

/**
 * @param {HTMLElement} root
 * @param {{ role:'host'|'player'|'display', send?:Function, now?:()=>number }} options
 */
export function mount(root, { role, send, now = () => Date.now() }) {
  const box = el('div', { class: `g-rps g-rps--${role}`, 'data-role': role });
  root.replaceChildren(box);

  let pub = null; // 공개 상태
  let mine = null; // 참가자 본인 상태
  let hostView = null; // 진행자 본인이 고른 손·감사 기록
  let counts = null; // 화면 집계: 단계별 제출 인원
  let selTwo = []; // 화면에서 고른 두 손 (서버 확정 아님)
  let selOne = null; // 화면에서 고른 남길 손
  let ack = null; // 서버 응답으로 확정된 값 { key, two?, one? } (개인 문서 도착 전)
  let stepKey = '';
  let busy = null;
  let lastError = '';
  let confirmKind = null; // 진행자 두 단계 확인: 'void' | 'end'
  let tickers = [];
  const firstSeen = new Map();
  let autoClose = { key: '', nextAt: 0, inFlight: false };

  const key = () => (pub ? `${pub.round}:${pub.attempt}:${pub.phase}` : '');
  const active = () => pub && (pub.phase === 'PICK_TWO' || pub.phase === 'PICK_ONE');
  const mineMatches = () => mine && pub && mine.round === pub.round && mine.attempt === pub.attempt;
  // 진행자 본인 문서가 공개 문서보다 늦게 올 수 있으므로 같은 라운드·시도의 값만 쓴다
  const hostFresh = () => hostView && pub && hostView.round === pub.round && hostView.attempt === pub.attempt;
  const hostTwoChosen = () => (hostFresh() ? hostView.hostTwo : null);
  const hostOneChosen = () => (hostFresh() ? hostView.hostOne : null);
  const myTwo = () => (ack?.key === key() && ack.two) || (mineMatches() && mine.current?.two) || null;
  const myOne = () => (ack?.key === key() && ack.one) || (mineMatches() && mine.current?.one) || null;
  const remainingMs = () => {
    if (!active()) return null;
    if (pub.paused) return pub.pausedRemainingMs;
    return Math.max(0, pub.deadlineAt - now());
  };
  const timeUp = () => active() && !pub.paused && now() >= pub.deadlineAt;
  const submitted = () => (active() ? Math.min(pub.aliveCount, counts?.[pub.inputKey] || 0) : 0);
  const lastResult = () => (pub && (pub.phase === 'ROUND_RESULT' || pub.phase === 'GAME_FINISHED') ? pub.results.at(-1) || null : null);

  function revealElapsed(r) {
    if (!r) return Infinity;
    if (pub.phase === 'GAME_FINISHED' || pub.revealSkipped || pub.results.at(-1) !== r) return Infinity;
    const k = `${r.round}:${r.attempt}`;
    if (!firstSeen.has(k)) firstSeen.set(k, Date.now());
    return Math.max(now() - r.revealedAt, Date.now() - firstSeen.get(k));
  }
  const revealDone = (r) => revealElapsed(r) >= REVEAL_STEPS.banner;

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
      lastError = (kind === 'two' || kind === 'one') && noResponse ? ERROR_SUBMIT : (res?.error?.message || '요청을 처리하지 못했습니다.');
    }
    draw();
    return res;
  }

  async function submitTwo() {
    if (selTwo.length !== 2) return;
    const k = key(); const two = [...selTwo].sort();
    const res = await act('two', { type: 'pick-two', round: pub.round, attempt: pub.attempt, value: pairCode(two) });
    if (res?.ok && k === key()) { ack = { key: k, two }; draw(); }
  }
  async function submitOne() {
    if (!selOne) return;
    const k = key(); const one = selOne; const two = myTwo();
    const res = await act('one', { type: 'keep-one', round: pub.round, attempt: pub.attempt, value: one });
    if (res?.ok && k === key()) { ack = { key: k, two, one }; draw(); }
  }
  const hostAction = (kind, type, extra = {}) => { confirmKind = null; return act(kind, { type, round: pub.round, attempt: pub.attempt, ...extra }); };

  // 마감 시각이 지나면 서버에 마감 확정을 요청 (진행자 화면은 진행자 손을 고른 뒤, 참가자 화면은 예비로 늦게)
  function maybeAutoClose() {
    if (!send || !active() || pub.paused || !pub.deadlineAt) return;
    if (role === 'host') {
      const ready = pub.phase === 'PICK_TWO' ? hostTwoChosen() : hostOneChosen();
      if (!ready) return;
    }
    const k = key();
    if (autoClose.key !== k) {
      autoClose = { key: k, inFlight: false, nextAt: role === 'host' ? pub.deadlineAt + 300 : pub.deadlineAt + 6000 + Math.floor(Math.random() * 4000) };
    }
    if (autoClose.inFlight || now() < autoClose.nextAt) return;
    autoClose.inFlight = true;
    Promise.resolve(send({ type: 'close-round', round: pub.round, attempt: pub.attempt, value: pub.phase === 'PICK_TWO' ? 2 : 1 }))
      .catch(() => null)
      .then(() => { autoClose.inFlight = false; autoClose.nextAt = now() + (role === 'host' ? 1500 : 8000); });
  }

  // ── 공통 조각 ─────────────────────────────────────────
  function timerEl(big = false) {
    const node = el('div', { class: `g-rps__timer${big ? ' g-rps__timer--big' : ''}`, 'data-timer': true, role: 'timer', 'aria-live': 'off' });
    // 공개 화면: 남은 시간을 원형 게이지로 (표시만. 마감 판정은 서버)
    const label = big ? el('span', { class: 'g-rps__ring-label' }) : null;
    const ring = big ? el('div', { class: 'g-rps__ring' }, [node, label]) : null;
    tickers.push(() => {
      const ms = remainingMs();
      if (ms === null) { node.textContent = ''; return; }
      const urgent = !pub.paused && ms <= 5000;
      if (big) {
        const total = (pub.phase === 'PICK_TWO' ? pub.twoSeconds : pub.oneSeconds) * 1000;
        ring.style.setProperty('--p', total > 0 ? Math.max(0, Math.min(1, ms / total)).toFixed(4) : '0');
        node.textContent = String(Math.max(0, Math.ceil(ms / 1000)));
        label.textContent = pub.paused ? '일시정지' : '초 남음';
        ring.classList.toggle('is-urgent', urgent);
        ring.classList.toggle('is-paused', pub.paused);
      } else {
        node.textContent = pub.paused ? `⏸ ${formatRemaining(ms)}` : formatRemaining(ms);
      }
      node.classList.toggle('is-urgent', urgent);
      node.classList.toggle('is-paused', pub.paused);
    });
    return ring || node;
  }
  // 결과 공개 연출이 끝나기 전에는 생존 인원을 미리 보여 주지 않는다 (스포일러 방지)
  function aliveChip() {
    const node = el('span', { class: 'g-rps__chip g-rps__alive' });
    tickers.push(() => {
      const r = pub.phase === 'ROUND_RESULT' ? lastResult() : null;
      const n = r && !revealDone(r) ? r.aliveBefore : pub.aliveCount;
      node.textContent = `생존 ${n}명`;
    });
    return node;
  }
  function seatsEl() {
    const n = submitted();
    return el('div', { class: 'g-rps__seats', 'aria-hidden': 'true' }, Array.from({ length: pub.aliveCount }, (_, i) => el('i', { class: i < n ? 'is-on' : '' })));
  }
  const roundLabel = () => `ROUND ${pub.round}${pub.attempt > 1 ? ` · 재진행 ${pub.attempt}차` : ''}`;
  const HAND_TAG = { 'is-kept': '남김', 'is-dropped': '뺌' };
  const handEl = (h, cls = '') => el('span', { class: `g-rps__hand ${cls}`, 'data-hand': h }, [
    el('span', { class: 'g-rps__icon', 'aria-hidden': 'true' }, handIcon(h)),
    el('span', { class: 'g-rps__hname', text: HAND[h].name }),
    HAND_TAG[cls] ? el('span', { class: 'g-rps__tag', text: HAND_TAG[cls] }) : null,
  ]);
  const pickContent = (h) => [el('span', { class: 'g-rps__icon', 'aria-hidden': 'true' }, handIcon(h)), el('span', { class: 'g-rps__pname', text: HAND[h].name })];

  function restartNotice() {
    if (!pub?.restart || pub.restart.round !== pub.round || pub.phase === 'ROUND_RESULT' || pub.phase === 'GAME_FINISHED') return null;
    return el('p', { class: 'g-rps__notice g-rps__notice--warn', role: 'status', 'data-restart': true, text: `⟳ ${pub.restart.round}라운드를 다시 진행합니다. 이전에 낸 손은 반영되지 않으니 새로 내 주세요.` });
  }
  function rulesPanel() {
    return el('ol', { class: 'g-rps__rules' }, [
      el('li', { text: '① 서로 다른 손 두 개를 냅니다. (예: 바위 + 보)' }),
      el('li', { text: '② 진행자의 두 손이 공개되면, 내 두 손 중 하나를 남깁니다.' }),
      el('li', { text: '③ 진행자가 남긴 손을 이긴 사람만 살아남습니다. 비기거나 지면 탈락!' }),
      el('li', { text: '시간 안에 내지 않으면 탈락. 모두 탈락하게 되면 그 라운드는 무효. 최후의 1인까지 계속합니다.' }),
    ]);
  }

  /** 결과 공개 (단계별 연출) */
  function resultBoard(r, { compact = false } = {}) {
    const hostTwoEl = el('div', { class: 'g-rps__hostpair' }, [el('p', { class: 'g-rps__kicker', text: '진행자의 두 손' }), el('div', { class: 'g-rps__hands' }, r.hostTwo.map((h) => handEl(h, h === r.hostOne ? 'is-kept' : 'is-dropped')))]);
    const hostOneEl = el('div', { class: 'g-rps__hostone', 'data-host-one': r.hostOne }, [el('p', { class: 'g-rps__kicker', text: '진행자가 남긴 손' }), handEl(r.hostOne, 'is-big')]);
    const total = Math.max(1, r.counts[1] + r.counts[2] + r.counts[3]);
    const rows = [1, 2, 3].map((h) => {
      const o = outcomeOf(h, r.hostOne);
      const pct = Math.round((r.counts[h] / total) * 100);
      return el('li', { class: `g-rps__row is-${o}`, 'data-hand': h, 'data-count': r.counts[h] }, [
        handEl(h),
        el('span', { class: 'g-rps__barwrap' }, el('span', { class: 'g-rps__bar', style: `width:${r.counts[h] > 0 ? `max(${pct}%, 14px)` : '0'}` })),
        el('span', { class: 'g-rps__cnt', text: `${r.counts[h]}명` }),
        el('span', { class: 'g-rps__out', text: OUTCOME[o] }),
      ]);
    });
    const countsEl = el('ol', { class: 'g-rps__rows', 'aria-label': `${r.round}라운드 손별 인원` }, rows);
    const missing = r.aliveBefore - r.keptCount;
    const note = missing > 0 ? el('p', { class: 'g-rps__muted', text: `손을 끝까지 내지 않은 ${missing}명은 탈락 대상입니다.` }) : null;
    let banner;
    if (r.cancelled) {
      banner = el('div', { class: 'g-rps__banner g-rps__banner--none', 'data-banner': 'cancelled' }, [
        el('p', { class: 'g-rps__kicker', text: `ROUND ${r.round}` }),
        el('p', { class: 'g-rps__banner-main', text: '모두 탈락하게 되어 이번 라운드는 무효!' }),
        el('p', { class: 'g-rps__banner-sub', text: `${r.aliveBefore}명 모두 다음 라운드에 다시 도전합니다.` }),
      ]);
    } else if (r.survivorCount === 1) {
      banner = el('div', { class: 'g-rps__banner g-rps__banner--win', 'data-banner': 'winner' }, [
        el('p', { class: 'g-rps__kicker', text: 'LAST ONE STANDING' }),
        el('p', { class: 'g-rps__banner-main' }, [trophyIcon(), el('strong', { 'data-winner-name': true, text: r.survivorNames[0] })]),
        el('p', { class: 'g-rps__banner-sub', text: '최후의 1인!' }),
      ]);
    } else {
      banner = el('div', { class: 'g-rps__banner', 'data-banner': 'survivors' }, [
        el('p', { class: 'g-rps__kicker', text: `ROUND ${r.round} 결과` }),
        el('p', { class: 'g-rps__banner-main' }, [el('strong', { 'data-survivor-count': r.survivorCount, text: `생존 ${r.survivorCount}명` }), ` · 탈락 ${r.eliminatedCount}명`]),
        compact ? null : el('p', { class: 'g-rps__names', text: r.survivorNames.join(' · ') }),
      ]);
    }
    const wrap = el('div', { class: 'g-rps__reveal', 'data-reveal': true }, [
      el('div', { class: 'g-rps__reveal-host' }, [hostTwoEl, hostOneEl]),
      el('div', { class: 'g-rps__reveal-board' }, [countsEl, note, banner]),
    ]);
    let last = '';
    tickers.push(() => {
      const t = revealElapsed(r);
      const stage = t >= REVEAL_STEPS.banner ? 4 : t >= REVEAL_STEPS.counts ? 3 : t >= REVEAL_STEPS.host ? 2 : 1;
      if (String(stage) === last) return;
      last = String(stage);
      hostOneEl.classList.toggle('is-hidden', stage < 2);
      countsEl.classList.toggle('is-hidden', stage < 3);
      note?.classList.toggle('is-hidden', stage < 3);
      banner.classList.toggle('is-hidden', stage < 4);
      wrap.setAttribute('data-stage', stage);
    });
    return wrap;
  }

  function finalBoard({ highlight } = {}) {
    const aborted = pub.ended?.reason === 'aborted';
    const top = pub.standings.filter((s) => s.rank === 1);
    // 시상대: 단독 1위일 때 순위표 앞 3명 (공동 순위는 순위 숫자 그대로)
    const podium = top.length === 1 && pub.standings.length >= 2
      ? el('div', { class: 'g-rps__podium', 'aria-hidden': 'true' }, pub.standings.slice(0, 3).map((s, i) => el('div', { class: `g-rps__step g-rps__step--${i + 1} g-rps__step--r${Math.min(s.rank, 3)}` }, [
        el('span', { class: 'g-rps__step-name', text: s.name }),
        el('span', { class: 'g-rps__step-block' }, [el('span', { class: 'g-rps__step-rank', text: `${s.rank}위` })]),
      ])))
      : null;
    return el('div', { class: 'g-rps__final', 'data-final': true }, [
      el('p', { class: 'g-rps__kicker', text: aborted ? '게임 중단 — 공개된 결과 기준' : 'FINAL RESULT' }),
      el('div', { class: 'g-rps__final-hero' }, [
        el('p', { class: 'g-rps__final-champ' }, top.length === 1
          ? [trophyIcon(), '최후의 1인: ', el('strong', { 'data-champion': true, text: top[0].name })]
          : ['생존자 공동 1위: ', el('strong', { 'data-champion': true, text: top.map((t) => t.name).join(', ') })]),
        podium,
      ]),
      aborted ? el('p', { class: 'g-rps__notice g-rps__notice--warn', text: `진행자가 ${pub.ended.round}라운드 중 게임을 중단했습니다.` }) : null,
      el('ol', { class: 'g-rps__ranking', 'data-ranking': true }, pub.standings.map((s) => el('li', { class: `${s.playerId === highlight ? 'is-me' : ''}${s.rank === 1 ? ' is-top' : ''}`.trim(), 'data-player': s.playerId }, [
        el('span', { class: 'g-rps__rank', text: `${s.rank}위` }),
        el('span', { class: 'g-rps__rank-name', text: s.name }),
        el('span', { class: 'g-rps__rank-info', text: s.alive ? '생존' : `${s.eliminatedRound}R 탈락` }),
      ]))),
    ]);
  }

  // ── 참가자 화면 ───────────────────────────────────────
  function drawPlayer() {
    const nodes = [el('div', { class: 'g-rps__top' }, [
      el('span', { class: 'g-rps__chip g-rps__round', text: roundLabel() }),
      aliveChip(),
      active() && mine?.alive ? timerEl() : null,
    ])];
    const rn = restartNotice();
    if (rn && mine?.alive) nodes.push(rn);
    // 이번 라운드에 탈락했다면 결과 화면에서는 내 결과 카드를 먼저 보여 준다 (왜 탈락했는지 이해하도록)
    const outThisRound = pub.phase === 'ROUND_RESULT' && mine?.eliminated?.round === pub.results.at(-1)?.round;
    if (mine && !mine.alive && pub.phase !== 'GAME_FINISHED' && !outThisRound) {
      const e = mine.eliminated;
      nodes.push(el('div', { class: 'g-rps__card g-rps__card--out', 'data-eliminated': true }, [
        el('p', { class: 'g-rps__lead', text: '탈락했습니다' }),
        e ? el('p', { text: `${e.round}라운드 · ${REASON[e.reason] || e.reason}` }) : null,
        el('p', { class: 'g-rps__muted', text: '앞 화면에서 최후의 1인이 가려지는 과정을 함께 지켜봐 주세요.' }),
      ]));
      if (pub.phase === 'ROUND_RESULT') nodes.push(resultBoard(lastResult(), { compact: true }));
      return nodes;
    }
    if (pub.phase === 'LOBBY') {
      nodes.push(el('p', { class: 'g-rps__lead', text: `곧 ${pub.round}라운드가 시작됩니다.` }), rulesPanel());
    } else if (pub.phase === 'PICK_TWO') {
      const closed = timeUp();
      const disabled = busy === 'two' || pub.paused || closed;
      const confirmed = myTwo();
      const same = confirmed && selTwo.length === 2 && [...selTwo].sort().join() === confirmed.join();
      nodes.push(el('p', { class: 'g-rps__lead', text: '① 서로 다른 손 두 개를 고르세요' }));
      nodes.push(el('div', { class: 'g-rps__picker', role: 'group', 'aria-label': '두 손 고르기' }, [1, 2, 3].map((h) => el('button', {
        type: 'button', class: `g-rps__pick${selTwo.includes(h) ? ' is-selected' : ''}`, 'data-pick': h, 'data-hand': h, 'aria-pressed': selTwo.includes(h) ? 'true' : 'false', disabled,
        onclick: () => { selTwo = selTwo.includes(h) ? selTwo.filter((x) => x !== h) : [...selTwo, h].slice(-2); lastError = ''; draw(); },
      }, pickContent(h)))));
      nodes.push(el('button', {
        type: 'button', class: `g-rps__submit${same ? ' is-done' : ''}`, 'data-action': 'submit-two', disabled: disabled || selTwo.length !== 2 || same,
        text: busy === 'two' ? '내는 중…' : same ? '✓ 두 손 제출 완료' : confirmed ? '이 두 손으로 바꾸기' : '두 손 내기',
        onclick: submitTwo,
      }));
      nodes.push(statusLine({ closed, confirmedText: confirmed && `✓ 낸 두 손: ${confirmed.map(handLabel).join(' + ')}`, same, pending: selTwo.length === 2 && !same, need: selTwo.length < 2 ? '두 개를 고르면 "두 손 내기"를 누를 수 있습니다.' : null, pendingText: confirmed ? '새로 고른 두 손은 아직 제출되지 않았습니다. 버튼을 눌러야 바뀝니다.' : '"두 손 내기"를 눌러야 확정됩니다.', dataSubmitted: confirmed ? pairCode(confirmed) : null, hint: '마감 전에는 바꿀 수 있습니다.' }));
    } else if (pub.phase === 'PICK_ONE') {
      const two = myTwo();
      nodes.push(el('div', { class: 'g-rps__hostpair g-rps__hostpair--inline' }, [el('p', { class: 'g-rps__kicker', text: '진행자의 두 손' }), el('div', { class: 'g-rps__hands' }, pub.hostTwo.map((h) => handEl(h)))]));
      if (!two) {
        nodes.push(el('p', { class: 'g-rps__notice g-rps__notice--error', 'data-no-two': true, text: '두 손을 내지 않아 이번 라운드는 탈락 예정입니다.' }));
      } else {
        const closed = timeUp();
        const disabled = busy === 'one' || pub.paused || closed;
        const confirmed = myOne();
        const same = confirmed && selOne === confirmed;
        nodes.push(el('p', { class: 'g-rps__lead', text: '② 하나 빼기! 남길 손을 고르세요' }));
        nodes.push(el('div', { class: 'g-rps__picker g-rps__picker--two', role: 'group', 'aria-label': '남길 손 고르기' }, two.map((h) => el('button', {
          type: 'button', class: `g-rps__pick${selOne === h ? ' is-selected' : ''}`, 'data-keep': h, 'data-hand': h, 'aria-pressed': selOne === h ? 'true' : 'false', disabled,
          onclick: () => { selOne = h; lastError = ''; draw(); },
        }, pickContent(h)))));
        nodes.push(el('button', {
          type: 'button', class: `g-rps__submit${same ? ' is-done' : ''}`, 'data-action': 'submit-one', disabled: disabled || !selOne || same,
          text: busy === 'one' ? '내는 중…' : same ? '✓ 남길 손 제출 완료' : confirmed ? '이 손으로 바꾸기' : '이 손 남기기',
          onclick: submitOne,
        }));
        nodes.push(statusLine({ closed, confirmedText: confirmed && `✓ 남긴 손: ${handLabel(confirmed)}`, same, pending: selOne && !same, need: !selOne ? '두 손 중 하나를 고르세요.' : null, pendingText: confirmed ? '새로 고른 손은 아직 제출되지 않았습니다.' : '"이 손 남기기"를 눌러야 확정됩니다.', dataSubmitted: confirmed, hint: '마감 전에는 바꿀 수 있습니다.' }));
      }
    } else if (pub.phase === 'ROUND_CLOSED') {
      const one = mineMatches() ? mine.current?.one : null;
      nodes.push(el('p', { class: 'g-rps__lead g-rps__lead--center', text: '마감! 진행자의 손 공개를 기다리는 중' }));
      nodes.push(el('p', { class: 'g-rps__notice', 'data-final-pick': one || 'none', text: one ? `내가 남긴 손: ${handLabel(one)}` : '이번 라운드에 손을 끝까지 내지 않았습니다 (탈락 대상).' }));
    } else if (pub.phase === 'ROUND_RESULT') {
      const r = lastResult();
      const board = resultBoard(r, { compact: true });
      const card = myResultCard(r);
      tickers.push(() => card.classList.toggle('is-hidden', !revealDone(r)));
      nodes.push(card, board);
    } else if (pub.phase === 'GAME_FINISHED') {
      const me = pub.standings.find((s) => s.playerId === mine?.playerId);
      if (me) {
        const champ = me.alive && me.rank === 1 && pub.aliveCount === 1;
        nodes.push(el('p', { class: `g-rps__myrank${champ ? ' is-champ' : ''}`, 'data-my-rank': me.rank }, champ
          ? [trophyIcon(), '최후의 1인! 축하합니다']
          : [el('span', { class: 'g-rps__myrank-label', text: '내 최종 순위' }), el('strong', { text: `${me.rank}위${pub.standings.filter((s) => s.rank === me.rank).length > 1 ? ' (공동)' : ''}` })]));
      }
      nodes.push(finalBoard({ highlight: mine?.playerId }));
    }
    return nodes;
  }

  function statusLine({ closed, confirmedText, same, pending, need, pendingText, dataSubmitted, hint }) {
    let s;
    if (pub.paused) s = el('p', { class: 'g-rps__notice g-rps__notice--warn', 'data-paused': true, text: '⏸ 일시정지 중입니다. 진행자가 재개하면 계속됩니다. (지금은 낼 수 없음)' });
    else if (closed) s = el('p', { class: 'g-rps__notice', text: '시간이 끝났습니다. 마감을 확정하는 중입니다.' });
    else if (busy) s = el('p', { class: 'g-rps__notice', text: '… 내는 중 — 서버 확인을 기다리고 있습니다.' });
    else if (lastError) s = el('p', { class: 'g-rps__notice g-rps__notice--error', role: 'alert', text: lastError });
    else if (same) s = el('div', { class: 'g-rps__notice g-rps__notice--ok', 'data-submitted': dataSubmitted }, [el('strong', { text: confirmedText }), el('br'), `제출 완료! ${hint}`]);
    else if (confirmedText && pending) s = el('p', { class: 'g-rps__notice', 'data-submitted': dataSubmitted, text: `${confirmedText} · ${pendingText}` });
    else if (pending) s = el('p', { class: 'g-rps__notice', text: pendingText });
    else s = el('p', { class: 'g-rps__notice', ...(confirmedText ? { 'data-submitted': dataSubmitted } : {}), text: confirmedText ? `${confirmedText} · ${hint}` : need || '' });
    return el('div', { 'aria-live': 'polite', 'data-submit-status': true }, s);
  }

  function myResultCard(r) {
    const h = mine?.history?.find((x) => x.round === r.round);
    if (!h) return el('div', { class: 'g-rps__card', text: '내 결과를 불러오는 중…' });
    const rows = [['진행자가 남긴 손', handLabel(r.hostOne)]];
    if (h.two) rows.push(['내가 낸 두 손', h.two.map(handLabel).join(' + ')]);
    rows.push(['내가 남긴 손', h.one ? handLabel(h.one) : '없음 (내지 않음)']);
    let verdict;
    if (r.cancelled) verdict = '모두 탈락하게 되어 이번 라운드 무효 — 생존';
    else if (h.survived) verdict = '★ 이김 → 생존!';
    else verdict = `탈락 (${REASON[h.reason] || h.reason})`;
    rows.push(['결과', verdict]);
    const winner = r.survivorCount === 1 && h.survived;
    return el('div', { class: `g-rps__card${h.survived ? ' is-win' : ' is-out'}`, 'data-my-result': true }, [
      el('p', { class: 'g-rps__verdict', 'aria-hidden': 'true', text: r.cancelled ? '무효 · 생존' : h.survived ? '생존!' : '탈락' }),
      el('dl', { class: 'g-rps__dl' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      el('p', { class: 'g-rps__next', text: winner ? '최후의 1인이 되었습니다!' : h.survived ? `생존 ${r.survivorCount}명 — 진행자가 다음 라운드를 시작합니다.` : '앞 화면에서 남은 경기를 지켜봐 주세요.' }),
    ]);
  }

  // ── 진행자 화면 ───────────────────────────────────────
  function btn(label, attrs, kids = null) {
    return el('button', { type: 'button', class: 'g-rps__btn', ...attrs, text: kids ? undefined : label, disabled: attrs.disabled || !!busy }, kids || []);
  }

  function hostHandPicker() {
    if (pub.phase === 'PICK_TWO') {
      const chosen = hostTwoChosen();
      const send2 = (two) => hostAction('host-two', 'host-two', { value: pairCode(two) });
      return el('div', { class: 'g-rps__hostpick', 'data-host-picker': 'two' }, [
        el('p', { class: 'g-rps__kicker', text: '진행자 두 손 (참가자에게는 ② 단계에서 공개)' }),
        el('div', { class: 'g-rps__picker' }, [1, 2, 3].map((h) => btn(HAND[h].name, {
          class: `g-rps__btn g-rps__pick${selTwo.includes(h) ? ' is-selected' : ''}`, 'data-host-pick': h, 'data-hand': h, 'aria-pressed': selTwo.includes(h) ? 'true' : 'false',
          onclick: () => { selTwo = selTwo.includes(h) ? selTwo.filter((x) => x !== h) : [...selTwo, h].slice(-2); draw(); },
        }, pickContent(h)))),
        el('div', { class: 'g-rps__controls' }, [
          btn('이 두 손으로 정하기', { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'host-two', disabled: selTwo.length !== 2, onclick: () => send2(selTwo) }),
          btn('무작위로 정하기', { 'data-action': 'host-two-random', onclick: () => { const drop = 1 + Math.floor(Math.random() * 3); selTwo = [1, 2, 3].filter((x) => x !== drop); send2(selTwo); } }),
        ]),
        el('p', { class: chosen ? 'g-rps__notice g-rps__notice--ok' : 'g-rps__notice g-rps__notice--warn', 'data-host-chosen': chosen ? pairCode(chosen) : 'none', text: chosen ? `정해진 두 손: ${chosen.map(handLabel).join(' + ')} (마감 전 변경 가능)` : '아직 정하지 않았습니다. 정해야 마감됩니다.' }),
      ]);
    }
    if (pub.phase === 'PICK_ONE') {
      const chosen = hostOneChosen();
      const send1 = (h) => hostAction('host-one', 'host-one', { value: h });
      return el('div', { class: 'g-rps__hostpick', 'data-host-picker': 'one' }, [
        el('p', { class: 'g-rps__kicker', text: '진행자가 남길 손 (결과 공개 때 공개)' }),
        el('div', { class: 'g-rps__picker g-rps__picker--two' }, pub.hostTwo.map((h) => btn(HAND[h].name, {
          class: `g-rps__btn g-rps__pick${chosen === h ? ' is-selected' : ''}`, 'data-host-keep': h, 'data-hand': h, onclick: () => send1(h),
        }, pickContent(h)))),
        btn('무작위로 정하기', { 'data-action': 'host-one-random', onclick: () => send1(pub.hostTwo[Math.floor(Math.random() * 2)]) }),
        el('p', { class: chosen ? 'g-rps__notice g-rps__notice--ok' : 'g-rps__notice g-rps__notice--warn', 'data-host-chosen': chosen || 'none', text: chosen ? `남길 손: ${handLabel(chosen)} (마감 전 변경 가능)` : '아직 정하지 않았습니다. 정해야 마감됩니다.' }),
      ]);
    }
    return null;
  }

  function drawHost() {
    const nodes = [];
    const items = [
      el('strong', { class: 'g-rps__round', 'data-host-round': true, text: roundLabel() }),
      el('span', { 'data-alive-count': pub.aliveCount, text: `생존: ${pub.aliveCount} / ${pub.playerCount}명` }),
    ];
    if (active()) {
      items.push(el('span', { 'data-submitted-count': submitted(), text: `제출: ${submitted()}명` }));
      items.push(el('span', {}, ['남은 시간: ', timerEl()]));
    }
    items.push(el('span', { class: 'g-rps__phase', 'data-phase': pub.phase, text: active() && pub.paused ? '⏸ 일시정지' : PHASE_LABEL[pub.phase] }));
    nodes.push(el('div', { class: 'g-rps__hoststatus', role: 'status' }, items));
    const rn = restartNotice();
    if (rn) nodes.push(rn);
    const picker = hostHandPicker();
    if (picker) nodes.push(picker);

    const controls = [];
    if (pub.phase === 'LOBBY') {
      controls.push(btn(pub.restart?.round === pub.round ? `${pub.round}라운드 다시 시작` : `${pub.round}라운드 시작`, { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'start-round', onclick: () => hostAction('start', 'start-round') }));
    } else if (active()) {
      if (pub.paused) controls.push(btn('▶ 재개', { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'resume', onclick: () => hostAction('resume', 'resume') }));
      else controls.push(btn('⏸ 긴급 일시정지', { 'data-action': 'pause', onclick: () => hostAction('pause', 'pause') }));
      const closeBtn = btn('마감 확정', { 'data-action': 'close-round', onclick: () => hostAction('close', 'close-round', { value: pub.phase === 'PICK_TWO' ? 2 : 1 }) });
      tickers.push(() => closeBtn.classList.toggle('is-hidden', !timeUp()));
      controls.push(closeBtn);
    } else if (pub.phase === 'ROUND_CLOSED') {
      controls.push(btn('결과 공개', { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'reveal', onclick: () => hostAction('reveal', 'reveal') }));
      controls.push(confirmKind === 'void'
        ? el('span', { class: 'g-rps__confirm' }, ['이번 시도를 무효로 하고 같은 라운드를 다시 할까요? ',
          btn('무효화 확정', { class: 'g-rps__btn g-rps__btn--danger', 'data-action': 'void-confirm', onclick: () => hostAction('void', 'void-round') }),
          btn('취소', { onclick: () => { confirmKind = null; draw(); } })])
        : btn('라운드 무효화 후 재진행', { 'data-action': 'void-round', onclick: () => { confirmKind = 'void'; draw(); } }));
    } else if (pub.phase === 'ROUND_RESULT') {
      const r = lastResult();
      const skip = btn('건너뛰기 (결과 바로 표시)', { 'data-action': 'skip-reveal', onclick: () => hostAction('skip', 'skip-reveal') });
      tickers.push(() => skip.classList.toggle('is-hidden', revealDone(r)));
      controls.push(skip);
      controls.push(pub.aliveCount > 1
        ? btn(`${pub.round + 1}라운드 시작`, { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'next-round', onclick: () => act('start', { type: 'start-round', round: pub.round + 1 }) })
        : btn('최종 결과 발표', { class: 'g-rps__btn g-rps__btn--primary', 'data-action': 'finish-game', onclick: () => hostAction('finish', 'finish-game') }));
    }
    if (pub.phase !== 'GAME_FINISHED') {
      controls.push(confirmKind === 'end'
        ? el('span', { class: 'g-rps__confirm' }, ['게임을 중단하고 종료할까요? 공개된 결과만 남습니다. ',
          btn('중단 확정', { class: 'g-rps__btn g-rps__btn--danger', 'data-action': 'end-confirm', onclick: () => hostAction('end', 'end-game') }),
          btn('취소', { onclick: () => { confirmKind = null; draw(); } })])
        : btn('게임 중단', { class: 'g-rps__btn g-rps__btn--ghost', 'data-action': 'end-game', onclick: () => { confirmKind = 'end'; draw(); } }));
    }
    nodes.push(el('div', { class: 'g-rps__controls' }, controls));
    if (busy) nodes.push(el('p', { class: 'g-rps__notice', text: '… 서버 처리 중' }));
    if (lastError) nodes.push(el('p', { class: 'g-rps__notice g-rps__notice--error', role: 'alert', text: lastError }));
    if (active() && timeUp()) {
      const ready = pub.phase === 'PICK_TWO' ? hostTwoChosen() : hostOneChosen();
      if (!ready) nodes.push(el('p', { class: 'g-rps__notice g-rps__notice--warn', text: '시간이 끝났습니다. 진행자 손을 정하면 바로 마감됩니다.' }));
    }
    if (pub.phase === 'ROUND_RESULT') nodes.push(resultBoard(lastResult()));
    if (pub.phase === 'GAME_FINISHED') nodes.push(finalBoard());
    if (pub.phase === 'LOBBY' && pub.round === 1 && !pub.results.length) nodes.push(rulesPanel());
    if (pub.results.length) {
      nodes.push(el('details', { class: 'g-rps__history' }, [
        el('summary', { text: `공개된 라운드 결과 (${pub.results.length})` }),
        el('ul', {}, pub.results.map((r) => el('li', { text: `${r.round}라운드${r.attempt > 1 ? `(${r.attempt}차)` : ''}: 진행자 ${HAND[r.hostOne].name} · ${r.cancelled ? '전원 탈락 → 무효' : `생존 ${r.survivorCount}명 · 탈락 ${r.eliminatedCount}명`}` }))),
      ]));
    }
    const audit = hostView?.audit || [];
    if (audit.length) {
      const label = { void: '라운드 무효화', pause: '일시정지', resume: '재개', abort: '게임 중단' };
      nodes.push(el('details', { class: 'g-rps__history', 'data-audit': true }, [
        el('summary', { text: `감사 기록 (${audit.length})` }),
        el('ul', {}, audit.map((a) => el('li', { text: `${label[a.type] || a.type} · ${a.round}라운드 ${a.attempt}차${a.remainingMs != null ? ` · 남은 ${formatRemaining(a.remainingMs)}` : ''}` }))),
      ]));
    }
    return nodes;
  }

  // ── 공개 화면 ─────────────────────────────────────────
  function drawDisplay() {
    const nodes = [el('div', { class: 'g-rps__top' }, [
      el('span', { class: 'g-rps__title' }, [el('span', { class: 'g-rps__logo', 'aria-hidden': 'true' }, [1, 2, 3].map((h) => el('span', { 'data-logo-hand': h }, handIcon(h)))), '가위바위보 하나빼기']),
      el('span', { class: 'g-rps__round', 'data-display-round': true }, [el('span', { class: 'g-rps__chip', text: roundLabel() }), aliveChip()]),
    ])];
    const rn = restartNotice();
    if (rn) nodes.push(rn);
    if (pub.phase === 'LOBBY') {
      nodes.push(
        el('div', { class: 'g-rps__hero', 'aria-hidden': 'true' }, [1, 2, 3].map((h) => handEl(h, 'is-big'))),
        el('p', { class: 'g-rps__lead', text: pub.restart?.round === pub.round ? `${pub.round}라운드를 다시 시작합니다.` : `곧 ${pub.round}라운드가 시작됩니다.` }),
        rulesPanel(),
      );
    } else if (active()) {
      const state = el('p', { class: 'g-rps__lead' });
      tickers.push(() => {
        state.textContent = pub.paused ? '⏸ 일시정지 — 진행자가 재개하면 계속됩니다' : timeUp() ? '마감 중…' : pub.phase === 'PICK_TWO' ? '① 서로 다른 손 두 개를 내세요!' : '② 하나 빼기! 남길 손을 고르세요';
        state.classList.toggle('g-rps__notice--warn', pub.paused);
      });
      const clock = el('div', { class: 'g-rps__clock' }, [timerEl(true), state,
        el('div', { class: 'g-rps__submits' }, [seatsEl(), el('p', { class: 'g-rps__subcount', 'data-display-submitted': submitted(), text: `제출 ${submitted()} / ${pub.aliveCount}명` })])]);
      const host = pub.phase === 'PICK_ONE'
        ? el('div', { class: 'g-rps__hostpair g-rps__hostpair--stage' }, [el('p', { class: 'g-rps__kicker', text: '진행자의 두 손' }), el('div', { class: 'g-rps__hands' }, pub.hostTwo.map((h) => handEl(h, 'is-big')))])
        : null;
      nodes.push(el('div', { class: `g-rps__stage${host ? ' g-rps__stage--split' : ''}` }, [host, clock]));
    } else if (pub.phase === 'ROUND_CLOSED') {
      nodes.push(el('div', { class: 'g-rps__stage g-rps__drum' }, [
        el('p', { class: 'g-rps__big', 'data-closed': true, text: '마감!' }),
        pub.hostTwo ? el('div', { class: 'g-rps__hands g-rps__hands--drum', 'aria-hidden': 'true' }, pub.hostTwo.map((h) => el('span', { class: 'g-rps__hand is-big', 'data-hand': h }, [el('span', { class: 'g-rps__icon' }, handIcon(h)), el('span', { class: 'g-rps__hname', text: HAND[h].name })]))) : null,
        el('p', { class: 'g-rps__lead', text: '진행자가 남긴 손을 공개합니다…' }),
      ]));
    } else if (pub.phase === 'ROUND_RESULT') {
      nodes.push(resultBoard(lastResult()));
    } else if (pub.phase === 'GAME_FINISHED') {
      nodes.push(finalBoard());
    }
    return nodes;
  }

  function draw() {
    tickers = [];
    if (!pub) { box.replaceChildren(el('p', { class: 'g-rps__notice', text: '… 게임 상태를 불러오는 중' })); return; }
    const nodes = role === 'host' ? drawHost() : role === 'player' ? drawPlayer() : drawDisplay();
    box.replaceChildren(...nodes);
    box.setAttribute('data-phase', pub.phase);
    tick();
  }
  function tick() {
    for (const t of tickers) t();
    if (role === 'host' || (role === 'player' && mine?.alive)) maybeAutoClose();
  }
  const timer = setInterval(tick, 200);

  return {
    update({ view, publicView, inputCounts }) {
      counts = inputCounts || null;
      if (role === 'display') pub = view;
      else if (publicView) pub = publicView;
      if (role === 'player') mine = view;
      if (role === 'host') hostView = view;
      if (key() !== stepKey) {
        stepKey = key(); lastError = ''; confirmKind = null; selOne = null;
        // ① → ② 로 넘어갈 때는 서버가 확인한 두 손을 이어서 씀 (개인 문서가 늦게 와도 남길 손을 고를 수 있게)
        ack = pub?.phase === 'PICK_ONE' && ack?.two ? { key: key(), two: ack.two } : null;
        selTwo = [];
      }
      if (role === 'player' && ack && mineMatches()) {
        const c = mine.current;
        if (c && JSON.stringify(c.two) === JSON.stringify(ack.two) && (ack.one ?? null) === (c.one ?? null)) ack = null; // 서버 문서가 따라옴
      }
      if (role === 'player' && pub?.phase === 'PICK_TWO' && !selTwo.length && myTwo()) selTwo = [...myTwo()];
      if (role === 'player' && pub?.phase === 'PICK_ONE' && !selOne && myOne()) selOne = myOne();
      draw();
    },
    destroy() { clearInterval(timer); box.remove(); },
  };
}
