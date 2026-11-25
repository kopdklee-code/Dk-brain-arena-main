// 가위바위보 하나빼기 — 실제 브라우저 E2E (Hosting·Auth·Firestore·Functions 에뮬레이터, emulators:exec 안에서 실행).
// 진행자(1280×860)·공개 화면(1920×1080)·모바일 참가자 3명(360·390·430px)은 Edge 로,
// 나머지 27명은 독립 익명 세션의 서버 호출로 참가시켜 30명(최대 정원) 방에서 최후의 1인까지 진행한다.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import jsQR from 'jsqr';
import { doc, getDoc } from 'firebase/firestore';
import { approveHostInEmulator } from '../../../scripts/emulator-approve-host.mjs';
import { client, closeAll, rid, sleep, warmUpFunctions, limitCalls } from '../../helpers/emulator-clients.mjs';

const BASE = process.env.DKBA_BASE_URL || 'http://127.0.0.1:5000';
const ART = path.resolve('tests/.artifacts/rps-minus-one');
const CHANNEL = process.env.DKBA_BROWSER_CHANNEL || 'msedge';
const BOTS = 27;
const R = 1; const S = 2; const P = 3;
const log = (...a) => console.log('[rps-e2e]', ...a);
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); assert.ok(ok, `${name} ${detail}`); };

async function newPage(browser, label, viewport, mobile = false) {
  const context = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
  return { context, page, label };
}
const shot = (p, name) => p.page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function decodeQr(page) {
  const svg = page.locator('[data-join-qr] svg');
  await svg.waitFor({ state: 'visible' });
  const img = await svg.evaluate(async (node) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(node))}`;
    await image.decode();
    const c = document.createElement('canvas'); c.width = 400; c.height = 400;
    const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(image, 0, 0, 400, 400);
    return Array.from(ctx.getImageData(0, 0, 400, 400).data);
  });
  return jsQR(Uint8ClampedArray.from(img), 400, 400)?.data || null;
}

async function main() {
  await mkdir(ART, { recursive: true });
  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  let bots = [];
  try {
    bots = await Promise.all(Array.from({ length: BOTS }, () => client('player')));
    const warm = await warmUpFunctions(bots, [['joinRoom', { code: '!', nickname: 'x' }], ['gameAction', { roomId: '!', requestId: 'x', action: { type: 'x' } }]], [3, 6, 10]);
    limitCalls(bots, 10);
    log(`에뮬레이터 준비 ${Math.round(warm / 1000)}초`);

    // ── 진행자: 로그인 → 가위바위보 하나빼기 방 ──
    const host = await newPage(browser, 'host', { width: 1280, height: 860 });
    await host.page.goto(`${BASE}/index.html`);
    check('홈 목록: 가위바위보 하나빼기 + 샘플, 단 하나의 숫자 없음', (await host.page.locator('[data-game-id="rps-minus-one"]').count()) === 1
      && (await host.page.locator('[data-game-id="demo-number-choice"]').count()) === 1 && (await host.page.locator('[data-game-id="unique-number"]').count()) === 0);
    await host.page.goto(`${BASE}/host.html?game=rps-minus-one`);
    const hostEmail = `rps-host-${randomUUID().slice(0, 8)}@example.test`;
    await approveHostInEmulator(hostEmail);
    await host.page.locator('[data-emulator-login] summary').click();
    await host.page.locator('#host-email').fill(hostEmail);
    await host.page.locator('#host-password').fill(`pw-${randomUUID()}`);
    await host.page.locator('[data-action="sign-up"]').click();
    await host.page.locator('#game-select').waitFor();
    check('게임 선택 기본값 = 가위바위보 하나빼기', (await host.page.locator('#game-select').inputValue()) === 'rps-minus-one');
    await host.page.locator('[data-action="create-room"]').click();
    await host.page.locator('[data-room-code]').filter({ hasNotText: '------' }).waitFor();
    const code = (await host.page.locator('[data-room-code]').innerText()).trim();
    const roomId = new URL(host.page.url()).searchParams.get('room');
    const joinUrl = `${BASE}/play.html?code=${code}`;
    check('진행자 QR = 참가 주소', (await decodeQr(host.page)) === joinUrl);

    const display = await newPage(browser, 'display', { width: 1920, height: 1080 });
    await display.page.goto(`${BASE}/display.html?room=${roomId}`);
    await display.page.locator('[data-room-code]', { hasText: code }).waitFor();
    check('공개 화면 QR = 참가 주소', (await decodeQr(display.page)) === joinUrl);

    const names = ['가온', '나린', '다솜'];
    const mob = [];
    for (const [i, [w, h]] of [[360, 740], [390, 844], [430, 932]].entries()) {
      const p = await newPage(browser, `p${w}`, { width: w, height: h }, true);
      await p.page.goto(joinUrl);
      await p.page.locator('#join-nickname').fill(names[i]);
      await p.page.locator('[data-action="join"]').click();
      await p.page.locator('[data-seat]').waitFor();
      mob.push(p);
    }
    await Promise.all(bots.map(async (b, i) => { await sleep(i * 300); await b.call('joinRoom', { code, nickname: `봇${String(i + 1).padStart(2, '0')}` }); }));
    await host.page.locator('.dk-muted', { hasText: '30 / 30명 입장' }).first().waitFor();
    check('진행자 인원 30 / 30, 시작 전 점검 표시', /시작할 수 있음/.test(await host.page.locator('[data-precheck]').innerText()));
    await shot(host, '01-host-lobby');
    await host.page.locator('[data-action="start-game"]').click();
    await display.page.locator('.g-rps__rules').waitFor();
    await shot(display, '02-display-rules');

    const pub = async () => (await getDoc(doc(bots[0].db, 'rooms', roomId))).data().publicView;
    async function botsAct(type, values) {
      const pv = await pub();
      return Promise.all(bots.map((b, i) => (values[i] == null ? null : b.call('gameAction', { roomId, requestId: rid(), action: { type, round: pv.round, attempt: pv.attempt, value: values[i] } }))));
    }
    async function hostTwo(a, b) {
      for (const h of [a, b]) await host.page.locator(`[data-host-pick="${h}"]`).click();
      await host.page.locator('[data-action="host-two"]').click();
      await host.page.locator(`[data-host-chosen="${Math.min(a, b) * 10 + Math.max(a, b)}"]`).waitFor();
    }
    async function mobTwo(p, a, b) {
      for (const h of [a, b]) await p.page.locator(`[data-pick="${h}"]`).click();
      await p.page.locator('[data-action="submit-two"]').click();
      await p.page.locator(`[data-submitted="${Math.min(a, b) * 10 + Math.max(a, b)}"]`).waitFor();
    }
    async function mobOne(p, h) {
      await p.page.locator(`[data-keep="${h}"]`).click();
      await p.page.locator('[data-action="submit-one"]').click();
      await p.page.locator(`[data-submitted="${h}"]`).waitFor();
    }
    const waitPhase = (phase, timeout = 40000) => display.page.locator(`.g-rps[data-phase="${phase}"]`).waitFor({ timeout });

    // ── 1라운드: 진행자 [바위,보] → 바위. 보를 남긴 사람만 생존 ──
    await host.page.locator('[data-action="start-round"]').click();
    await mob[0].page.locator('[data-pick="1"]').waitFor();
    for (const p of mob) {
      const cols = await p.page.locator('.g-rps__picker').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
      const bh = await p.page.locator('.g-rps__pick').first().evaluate((b) => b.getBoundingClientRect().height);
      check(`${p.label}: 손 3개 한 줄, 가로 스크롤 없음, 버튼 높이 ≥44px`, cols === 3 && await noHScroll(p.page) && bh >= 44, `높이 ${Math.round(bh)}`);
    }
    await hostTwo(R, P);
    await mob[0].page.locator('[data-pick="1"]').click();
    check('손 하나만 고르면 낼 수 없음', await mob[0].page.locator('[data-action="submit-two"]').isDisabled());
    await mob[0].page.locator('[data-pick="3"]').click();
    check('두 손 고르기만 하면 제출되지 않음', (await mob[0].page.locator('[data-submitted]').count()) === 0);
    await mob[0].page.locator('[data-action="submit-two"]').click();
    await mob[0].page.locator('[data-submitted="13"]').waitFor();
    await mob[0].page.locator('[data-pick="1"]').click(); // 바위 빼고
    await mob[0].page.locator('[data-pick="2"]').click(); // 가위 넣기 → 가위+보
    await mob[0].page.locator('[data-action="submit-two"]').click();
    await mob[0].page.locator('[data-submitted="23"]').waitFor();
    check('마감 전 두 손 변경', true);
    await shot(mob[0], 'r1-p360-two');
    await mobTwo(mob[1], R, P);
    await mobTwo(mob[2], S, P);
    const b1 = await botsAct('pick-two', Array(BOTS).fill(13));
    check('봇 27명 두 손 제출', b1.every((r) => r.ok));
    await host.page.locator('[data-submitted-count="30"]').waitFor();
    check('진행자: 제출 30명, 참가자 손은 보이지 않음', !(/가온.*보|g-rps__rows/.test(await host.page.locator('.g-rps').innerHTML())));
    await shot(display, 'r1-display-two');
    // 일시정지 → 차단 → 재개
    await host.page.locator('[data-action="pause"]').click();
    await mob[1].page.locator('[data-paused]').waitFor();
    check('일시정지: 참가자 안내·버튼 비활성', await mob[1].page.locator('.g-rps__pick').first().isDisabled());
    await display.page.locator('.g-rps__lead', { hasText: '일시정지' }).waitFor();
    const blocked = await bots[0].call('gameAction', { roomId, requestId: rid(), action: { type: 'pick-two', round: 1, attempt: 1, value: 12 } });
    check('일시정지 중 서버가 제출 거부', blocked.error?.code === 'paused');
    await sleep(1000);
    await host.page.locator('[data-action="resume"]').click();
    await host.page.locator('[data-action="pause"]').waitFor();
    // ① 자동 마감 → ② 진행자 두 손 공개
    await waitPhase('PICK_ONE');
    check('① 서버 기준 자동 마감 → ② 진행자 두 손 공개', (await display.page.locator('.g-rps__hostpair [data-hand]').count()) === 2);
    await shot(display, 'r1-display-one');
    await host.page.locator('[data-host-keep="1"]').click();
    await host.page.locator('[data-host-chosen="1"]').waitFor();
    await mob[0].page.locator('[data-keep="3"]').waitFor();
    check('참가자 ②: 내 두 손만 남길 손 후보', (await mob[0].page.locator('[data-keep]').count()) === 2 && (await mob[0].page.locator('[data-keep="1"]').count()) === 0);
    await mobOne(mob[0], P); // 보 → 바위를 이김
    await shot(mob[0], 'r1-p360-one');
    await mobOne(mob[1], R); // 바위 → 비김
    await mobOne(mob[2], S); // 가위 → 짐
    await botsAct('keep-one', bots.map((_, i) => (i < 13 ? P : R)));
    await waitPhase('ROUND_CLOSED');
    await shot(display, 'r1-display-closed');
    await host.page.locator('[data-action="reveal"]').click();
    await display.page.locator('[data-reveal][data-stage="2"]').waitFor();
    check('결과 공개 연출: 진행자 손 → 손별 인원 → 생존 발표 순서', (await display.page.locator('[data-banner]').isHidden()));
    await shot(display, 'r1-display-revealing');
    await display.page.locator('[data-reveal][data-stage="4"]').waitFor({ timeout: 8000 });
    check('1라운드 생존 14명 (보 남김), 손별 인원 표시', (await display.page.locator('[data-survivor-count]').getAttribute('data-survivor-count')) === '14'
      && (await display.page.locator('.g-rps__row[data-hand="3"]').getAttribute('data-count')) === '14');
    await shot(display, 'r1-display-result');
    await mob[0].page.locator('[data-my-result]').waitFor();
    check('참가자 결과: 생존', /이김 → 생존/.test(await mob[0].page.locator('[data-my-result]').innerText()));
    check('참가자 결과: 비김 탈락 사유', /탈락.*비김/.test(await mob[1].page.locator('[data-my-result]').innerText()));
    check('참가자 결과: 짐 탈락 사유', /탈락.*짐/.test(await mob[2].page.locator('[data-my-result]').innerText()));
    await shot(mob[0], 'r1-p360-result'); await shot(mob[1], 'r1-p390-result');
    await host.page.reload();
    await host.page.locator('[data-host-round]', { hasText: 'ROUND 1' }).waitFor();
    await host.page.locator('[data-action="next-round"]').waitFor();
    check('진행자 새로고침 후 상태 복구', true);

    // ── 2라운드: 무작위 손 → 마감 후 무효화 → 재진행 [가위,보] → 가위 (바위만 생존), 건너뛰기 ──
    await host.page.locator('[data-action="next-round"]').click();
    await mob[1].page.locator('[data-eliminated]').waitFor();
    check('탈락한 참가자: 탈락 안내·관전', /1라운드/.test(await mob[1].page.locator('[data-eliminated]').innerText()));
    await shot(mob[1], 'r2-p390-eliminated');
    await host.page.locator('[data-action="host-two-random"]').click();
    await host.page.locator('[data-host-chosen]:not([data-host-chosen="none"])').waitFor();
    await waitPhase('PICK_ONE');
    await host.page.locator('[data-action="host-one-random"]').click();
    await waitPhase('ROUND_CLOSED');
    await host.page.locator('[data-action="void-round"]').click();
    await host.page.locator('[data-action="void-confirm"]').click();
    await mob[0].page.locator('[data-restart]').waitFor();
    check('무효화: 재진행 안내, 미제출로 아무도 탈락하지 않음', (await pub()).aliveCount === 14);
    await host.page.locator('[data-action="start-round"]', { hasText: '다시 시작' }).click();
    await mob[0].page.locator('[data-pick="1"]').waitFor();
    check('재진행: 이전 손 재사용 안 함', (await mob[0].page.locator('[data-submitted]').count()) === 0);
    await hostTwo(S, P);
    await mobTwo(mob[0], R, S);
    await botsAct('pick-two', bots.map((_, i) => (i < 13 ? 13 : null)));
    await waitPhase('PICK_ONE');
    await host.page.locator('[data-host-keep="2"]').click();
    await host.page.locator('[data-host-chosen="2"]').waitFor();
    await mobOne(mob[0], R);
    await botsAct('keep-one', bots.map((_, i) => (i < 2 ? R : i < 13 ? P : null)));
    await waitPhase('ROUND_CLOSED');
    await host.page.locator('[data-action="reveal"]').click();
    await host.page.locator('[data-action="skip-reveal"]').click();
    await display.page.locator('[data-reveal][data-stage="4"]').waitFor({ timeout: 3000 });
    check('건너뛰기: 결과 바로 표시, 생존 3명', (await display.page.locator('[data-survivor-count]').getAttribute('data-survivor-count')) === '3');
    const audit = await host.page.locator('[data-audit]').textContent();
    check('감사 기록: 일시정지·재개·무효화', /일시정지/.test(audit) && /재개/.test(audit) && /라운드 무효화/.test(audit));

    // ── 3라운드: 참가자 새로고침 복구, [바위,보] → 보 (가위만 생존) → 최후의 1인 ──
    await host.page.locator('[data-action="next-round"]').click();
    await mob[0].page.locator('[data-pick="1"]').waitFor();
    await hostTwo(R, P);
    await mobTwo(mob[0], R, S);
    await mob[0].page.reload();
    await mob[0].page.locator('.dk-message', { hasText: '기존 참가 상태를 복구했습니다' }).waitFor();
    await mob[0].page.locator('[data-submitted="12"]').waitFor();
    check('참가자 새로고침: 자리·두 손(서버 기준) 복구', true);
    await botsAct('pick-two', bots.map((_, i) => (i < 2 ? 13 : null)));
    await waitPhase('PICK_ONE');
    await host.page.locator('[data-host-keep="3"]').click();
    await host.page.locator('[data-host-chosen="3"]').waitFor();
    await mobOne(mob[0], S);
    await botsAct('keep-one', bots.map((_, i) => (i < 2 ? R : null)));
    await waitPhase('ROUND_CLOSED');
    await host.page.locator('[data-action="reveal"]').click();
    await display.page.locator('[data-banner="winner"]:not(.is-hidden)').waitFor({ timeout: 8000 });
    check('최후의 1인 발표: 가온', (await display.page.locator('[data-winner-name]').innerText()) === '가온');
    await shot(display, 'r3-display-winner');
    await host.page.locator('[data-action="finish-game"]').click();
    await display.page.locator('[data-final]').waitFor();
    check('최종 화면: 최후의 1인 가온, 순위 표시', /가온/.test(await display.page.locator('[data-champion]').innerText())
      && (await display.page.locator('[data-ranking] li').count()) === 30);
    await shot(display, 'final-display');
    await mob[0].page.locator('[data-my-rank="1"]').waitFor();
    await shot(mob[0], 'final-p360');
    await shot(host, 'final-host');
    await host.page.locator('[data-action="new-room"]').waitFor();
    for (const p of mob) check(`${p.label}: 최종 화면 가로 스크롤 없음`, await noHScroll(p.page));
    check('공개 화면 1920 가로 스크롤 없음', await noHScroll(display.page));
    const relevant = errors.filter((e) => !/favicon/i.test(e));
    check('브라우저 콘솔·HTTP 오류 없음', relevant.length === 0, relevant.join(' / '));
    log(`PASS 가위바위보 하나빼기 브라우저 E2E (${checks.length}개 확인)`);
  } finally {
    await writeFile(path.join(ART, 'e2e-checks.json'), JSON.stringify(checks, null, 2)).catch(() => {});
    await browser.close();
    await closeAll();
  }
}

main().catch((err) => {
  console.error('[rps-e2e] FAIL', err);
  process.exit(1);
});
