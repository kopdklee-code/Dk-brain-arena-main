// 단 하나의 숫자 — 실제 브라우저 E2E (Hosting·Auth·Firestore·Functions 에뮬레이터, firebase emulators:exec 안에서 실행).
// 진행자(1280×860)·공개 화면(1920×1080)·모바일 참가자 3명(360·390·430px)은 설치된 Edge 로,
// 나머지 26명은 독립 익명 세션의 서버 호출로 참가시켜 29명 방 전체 흐름을 진행한다.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import jsQR from 'jsqr';
import { doc, getDoc } from 'firebase/firestore';
import { approveHostInEmulator } from '../../../scripts/emulator-approve-host.mjs';
import { client, closeAll, rid, sleep, warmUpFunctions, limitCalls } from '../../helpers/emulator-clients.mjs';
import * as rules from '../../../src/games/unique-number/rules.js';

const BASE = process.env.DKBA_BASE_URL || 'http://127.0.0.1:5000';
const ART = path.resolve('tests/.artifacts/unique-number');
const CHANNEL = process.env.DKBA_BROWSER_CHANNEL || 'msedge';
const BOTS = 26;
const log = (...a) => console.log('[un-e2e]', ...a);
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
    // 서버 호출 참가자 26명 + Functions 에뮬레이터 준비 (같은 PC 자원 한계로 동시 처리 10개)
    bots = await Promise.all(Array.from({ length: BOTS }, () => client('player')));
    const warm = await warmUpFunctions(bots, [['joinRoom', { code: '!', nickname: 'x' }], ['gameAction', { roomId: '!', requestId: 'x', action: { type: 'x' } }]], [3, 6, 10]);
    limitCalls(bots, 10);
    log(`에뮬레이터 준비 ${Math.round(warm / 1000)}초`);

    // ── 진행자: 로그인 → 단 하나의 숫자 방 만들기 ──
    const host = await newPage(browser, 'host', { width: 1280, height: 860 });
    await host.page.goto(`${BASE}/index.html`);
    const card = host.page.locator('[data-game-id="unique-number"]');
    check('홈 게임 목록에 단 하나의 숫자 표시 (판매 게임, 개발 검증용 표시 없음)', (await card.count()) === 1 && !/개발 검증용/.test(await card.innerText()));
    check('기존 샘플도 목록 유지', (await host.page.locator('[data-game-id="demo-number-choice"]').count()) === 1);
    await host.page.goto(`${BASE}/host.html?game=unique-number`);
    const hostEmail = `un-host-${randomUUID().slice(0, 8)}@example.test`;
    await approveHostInEmulator(hostEmail);
    await host.page.locator('[data-emulator-login] summary').click();
    await host.page.locator('#host-email').fill(hostEmail);
    await host.page.locator('#host-password').fill(`pw-${randomUUID()}`);
    await host.page.locator('[data-action="sign-up"]').click();
    await host.page.locator('#game-select').waitFor();
    check('게임 선택에 단 하나의 숫자 기본 선택', (await host.page.locator('#game-select').inputValue()) === 'unique-number');
    await host.page.locator('[data-action="create-room"]').click();
    await host.page.locator('[data-room-code]').filter({ hasNotText: '------' }).waitFor();
    const code = (await host.page.locator('[data-room-code]').innerText()).trim();
    const roomId = new URL(host.page.url()).searchParams.get('room');
    const joinUrl = `${BASE}/play.html?code=${code}`;
    check('진행자 QR = 참가 주소', (await decodeQr(host.page)) === joinUrl, joinUrl);

    // ── 공개 화면 1920×1080 ──
    const display = await newPage(browser, 'display', { width: 1920, height: 1080 });
    await display.page.goto(`${BASE}/display.html?room=${roomId}`);
    await display.page.locator('[data-room-code]', { hasText: code }).waitFor();
    check('공개 화면 QR 해독 = 참가 주소', (await decodeQr(display.page)) === joinUrl);

    // ── 모바일 참가자 3명 (QR 주소로 입장) ──
    const widths = [[360, 740], [390, 844], [430, 932]];
    const names = ['가온', '나린', '다솜'];
    const mob = [];
    for (const [i, [w, h]] of widths.entries()) {
      const p = await newPage(browser, `p${w}`, { width: w, height: h }, true);
      await p.page.goto(joinUrl);
      check(`${w}px: QR 주소로 열면 코드 자동 입력`, (await p.page.locator('#join-code').inputValue()) === code);
      await p.page.locator('#join-nickname').fill(names[i]);
      await p.page.locator('[data-action="join"]').click();
      await p.page.locator('[data-seat]').waitFor();
      p.name = names[i];
      mob.push(p);
    }
    // ── 나머지 26명 (QR 현장 속도로 분산 입장) ──
    const joined = await Promise.all(bots.map(async (b, i) => { await sleep(i * 300); return b.call('joinRoom', { code, nickname: `봇${String(i + 1).padStart(2, '0')}` }); }));
    bots.forEach((b, i) => { b.playerId = joined[i].playerId; });
    await host.page.locator('[data-player-count], .dk-muted', { hasText: '29 / 29명 입장' }).first().waitFor();
    check('진행자 인원 표시 29 / 29', true);
    const pre = await host.page.locator('[data-precheck]').innerText();
    check('사전 점검: QR 생성·참가 인원·시작 가능·지연 미측정 표시', /QR코드 생성/.test(pre) && /29 \/ 29명/.test(pre) && /시작할 수 있음/.test(pre) && /측정 안 함/.test(pre), pre.replace(/\n/g, ' | '));
    check('사전 점검: 로컬 주소 경고 (휴대폰 접속용 아님)', /로컬 주소/.test(pre));
    await shot(host, '01-host-lobby-precheck');
    await shot(display, '02-display-lobby-qr');
    const late = await client('player');
    await assert.rejects(late.call('joinRoom', { code, nickname: '서른번째' }), (e) => e.code === 'functions/failed-precondition');
    check('30번째 신규 참가 차단', true);

    // ── 게임 시작 → 규칙 설명 ──
    await host.page.locator('[data-action="start-game"]').click();
    await host.page.locator('[data-action="start-round"]').waitFor();
    await display.page.locator('.g-un__rules').waitFor();
    check('공개 화면: 규칙 설명 단계', true);
    await shot(display, '03-display-rules');

    const roomPub = async () => (await getDoc(doc(bots[0].db, 'rooms', roomId))).data().publicView;
    async function botsSubmit(picks) {
      const pv = await roomPub();
      const res = await Promise.all(bots.map((b, i) => (picks[i] == null ? null : b.call('gameAction', { roomId, requestId: rid(), action: { type: 'submit', round: pv.round, attempt: pv.attempt, value: picks[i] } }))));
      return res.filter(Boolean);
    }
    async function mobSubmit(p, n) {
      await p.page.locator(`.g-un__num[data-choice="${n}"]`).click();
      await p.page.locator('[data-submit-status]', { hasText: '제출 버튼을 눌러야' }).waitFor();
      await p.page.locator('[data-action="submit"]').click();
      await p.page.locator(`[data-submitted="${n}"]`).waitFor();
    }
    async function waitClosedAndReveal(round, { skip = false } = {}) {
      await display.page.locator('[data-closed]').waitFor({ timeout: 70000 }); // 서버 기준 40초 후 자동 마감
      await shot(display, `r${round}-a-display-closed`);
      await host.page.locator('[data-action="reveal"]').click();
      await display.page.locator('.g-un__chart').waitFor();
      if (skip) {
        await host.page.locator('[data-action="skip-reveal"]').click();
      } else {
        await sleep(2500);
        const hidden = await display.page.locator('.g-un__col.is-hidden').count();
        check(`R${round} 결과 공개 연출: 숫자 순차 공개 중`, hidden > 0 && hidden < 20, `숨김 ${hidden}/20`);
        await shot(display, `r${round}-b-display-revealing`);
      }
      await display.page.locator('[data-winner]:not(.is-hidden)').waitFor({ timeout: skip ? 4000 : 15000 });
    }

    // ── 1라운드: 변경·일시정지·자동 마감·결과 ──
    await host.page.locator('[data-action="start-round"]').click();
    await display.page.locator('.g-un__timer--big').waitFor();
    for (const p of mob) {
      await p.page.locator('.g-un__grid').waitFor();
      const cols = await p.page.locator('.g-un__grid').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
      const btnH = await p.page.locator('.g-un__num').first().evaluate((b) => b.getBoundingClientRect().height);
      check(`${p.label}: 숫자 4열×5행, 가로 스크롤 없음, 버튼 높이 ≥44px`, cols === 4 && (await p.page.locator('.g-un__num').count()) === 20 && await noHScroll(p.page) && btnH >= 44, `열 ${cols}, 높이 ${Math.round(btnH)}`);
      await shot(p, `r1-${p.label}-grid`);
    }
    // 고르기만 하면 제출되지 않음 → 제출 → 변경 제출
    await mob[0].page.locator('.g-un__num[data-choice="2"]').click();
    check('숫자만 고르면 제출되지 않음', (await mob[0].page.locator('[data-submitted]').count()) === 0);
    await mob[0].page.locator('[data-action="submit"]').click();
    await mob[0].page.locator('[data-submitted="2"]').waitFor();
    await mobSubmit(mob[0], 6); // 2 → 6 변경
    await shot(mob[0], 'r1-p360-submitted');
    await mobSubmit(mob[1], 13);
    await mobSubmit(mob[2], 14);
    const r1bots = [...Array(8).fill(1), ...Array(5).fill(2), ...Array(4).fill(3), ...Array(3).fill(4), 5, 5, 9, 9, 11, 11];
    const r1res = await botsSubmit(r1bots);
    check('1라운드 봇 26명 제출 성공', r1res.every((r) => r.ok), `${r1res.filter((r) => r.ok).length}/26`);
    await host.page.locator('[data-submitted-count="29"]').waitFor();
    check('진행자 화면 제출 완료 29명', true);
    check('진행자 화면에 제출 숫자·분포 없음', !(await host.page.locator('.g-un__chart').count()));
    await shot(display, 'r1-display-active');
    // 일시정지 → 제출 차단·안내 → 재개
    await host.page.locator('[data-action="pause"]').click();
    await mob[1].page.locator('[data-paused]').waitFor();
    check('일시정지: 참가자 안내·숫자 버튼 비활성', await mob[1].page.locator('.g-un__num').first().isDisabled());
    await display.page.locator('.g-un__lead', { hasText: '일시정지' }).waitFor();
    await shot(display, 'r1-display-paused');
    const pv = await roomPub();
    const blocked = await bots[0].call('gameAction', { roomId, requestId: rid(), action: { type: 'submit', round: 1, attempt: 1, value: 20 } });
    check('일시정지 중 서버가 제출 거부', blocked.error?.code === 'paused');
    await sleep(1500);
    await host.page.locator('[data-action="resume"]').click();
    await host.page.locator('[data-action="pause"]').waitFor();
    check('재개: 남은 시간 보존', Math.abs((await roomPub()).deadlineAt - Date.now() - pv.pausedRemainingMs) < 2000);
    await waitClosedAndReveal(1);
    const r1 = rules.judge([6, 13, 14, ...r1bots]);
    check('1라운드 승리 숫자 = 로컬 판정(6)', (await display.page.locator('[data-winning-number]').innerText()) === String(r1.winningNumber));
    check('1라운드 승리자 닉네임', (await display.page.locator('[data-winner-name]').innerText()) === '가온');
    await shot(display, 'r1-c-display-winner');
    await mob[0].page.locator('[data-my-result]').waitFor();
    const card0 = await mob[0].page.locator('[data-my-result]').innerText();
    check('참가자 결과: 내 숫자·인원·판정·승리·누적', /6/.test(card0) && /1명/.test(card0) && /승리!/.test(card0) && /1승/.test(card0), card0.replace(/\n/g, ' | '));
    const card1 = await mob[1].page.locator('[data-my-result]').innerText();
    check('참가자 결과(비승리): 유효지만 더 작은 유일 숫자 안내', /○ 유효/.test(card1) && /승리하지 못했습니다/.test(card1));
    await shot(mob[0], 'r1-p360-result');
    await shot(mob[1], 'r1-p390-result');
    // 진행자 새로고침 복구
    await host.page.reload();
    await host.page.locator('[data-host-round]', { hasText: 'ROUND 1 / 3' }).waitFor();
    await host.page.locator('[data-action="next-round"]').waitFor();
    check('진행자 새로고침 후 방·라운드 상태 복구', true);

    // ── 2라운드: 마감 후 무효화 → 재진행(건너뛰기) ──
    await host.page.locator('[data-action="next-round"]').click();
    await mob[0].page.locator('.g-un__grid').waitFor();
    await mobSubmit(mob[0], 9);
    await display.page.locator('[data-closed]').waitFor({ timeout: 70000 });
    await host.page.locator('[data-action="void-round"]').click();
    await host.page.locator('[data-action="void-confirm"]').click();
    await mob[0].page.locator('[data-restart]').waitFor();
    check('무효화: 참가자에게 재진행 안내', true);
    await shot(mob[0], 'r2-p360-restart-notice');
    await host.page.locator('[data-action="start-round"]', { hasText: '다시 시작' }).click();
    await mob[0].page.locator('.g-un__grid').waitFor();
    check('재진행: 이전 선택 재사용 안 함', (await mob[0].page.locator('[data-submitted]').count()) === 0);
    await mobSubmit(mob[0], 1);
    await mobSubmit(mob[1], 15);
    await mobSubmit(mob[2], 15);
    const pairs = Array.from({ length: 26 }, (_, i) => Math.floor(i / 2) + 1); // 1~13 두 명씩
    await botsSubmit(pairs);
    await waitClosedAndReveal(2, { skip: true });
    check('건너뛰기: 전체 결과 즉시 표시', (await display.page.locator('.g-un__col.is-hidden').count()) === 0);
    check('2라운드 승자 없음 표시', /승자가 없습니다/.test(await display.page.locator('[data-winner]').innerText()));
    await shot(display, 'r2-display-no-winner');
    const audit = await host.page.locator('[data-audit]').textContent(); // 접힌 details 안의 기록
    check('진행자 감사 기록: 일시정지·재개·무효화', /일시정지/.test(audit) && /재개/.test(audit) && /라운드 무효화/.test(audit));

    // ── 3라운드: 참가자 새로고침 복구, 미참여 ──
    await host.page.locator('[data-action="next-round"]').click();
    await mob[1].page.locator('.g-un__grid').waitFor();
    await mobSubmit(mob[0], 20);
    await mobSubmit(mob[1], 18);
    await mob[1].page.reload();
    await mob[1].page.locator('.dk-message', { hasText: '기존 참가 상태를 복구했습니다' }).waitFor();
    await mob[1].page.locator('[data-submitted="18"]').waitFor();
    check('참가자 새로고침: 자리·제출값(서버 기준) 복구', true);
    check('새로고침 후 참가 인원 증가 없음', /29 \/ 29명/.test(await host.page.locator('section[aria-label="방 정보"]').innerText()));
    await botsSubmit(pairs);
    await waitClosedAndReveal(3);
    check('3라운드 승리 숫자 18 · 나린', (await display.page.locator('[data-winning-number]').innerText()) === '18' && (await display.page.locator('[data-winner-name]').innerText()) === '나린');
    await mob[2].page.locator('[data-my-result]').waitFor();
    check('미참여 참가자 결과 안내', /제출하지 않음/.test(await mob[2].page.locator('[data-my-result]').innerText()));

    // ── 최종 결과 ──
    await host.page.locator('[data-action="finish-game"]').click();
    await display.page.locator('[data-final]').waitFor();
    const champs = await display.page.locator('[data-champions]').innerText();
    check('최종: 공동 우승 가온·나린 (각 1승)', /가온/.test(champs) && /나린/.test(champs) && /공동 우승/.test(await display.page.locator('.g-un__final-champ').innerText()));
    const ranking = await display.page.locator('[data-ranking]').innerText();
    check('최종 순위: 1위 2명, 나머지 3위(공동)', (ranking.match(/1위/g) || []).length === 2 && (ranking.match(/3위/g) || []).length === 27);
    await shot(display, 'final-display');
    await shot(host, 'final-host');
    await mob[2].page.locator('[data-my-rank]').waitFor();
    await shot(mob[2], 'final-p430');
    await host.page.locator('[data-action="new-room"]').waitFor();
    check('진행자: 새 게임방 만들기 버튼', true);
    for (const p of mob) check(`${p.label}: 최종 화면 가로 스크롤 없음`, await noHScroll(p.page));
    check('공개 화면 1920 가로 스크롤 없음', await noHScroll(display.page));

    const relevant = errors.filter((e) => !/favicon/i.test(e));
    // 허용(의도된 거부만): 30번째 입장은 서버 호출로 시험했으므로 브라우저 오류 없음
    check('브라우저 콘솔·HTTP 오류 없음', relevant.length === 0, relevant.join(' / '));
    log(`PASS 단 하나의 숫자 브라우저 E2E (${checks.length}개 확인)`);
  } finally {
    await writeFile(path.join(ART, 'e2e-checks.json'), JSON.stringify(checks, null, 2)).catch(() => {});
    await browser.close();
    await closeAll();
  }
}

main().catch((err) => {
  console.error('[un-e2e] FAIL', err);
  process.exit(1);
});
