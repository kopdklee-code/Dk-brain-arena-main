// 브라우저 E2E (Hosting·Auth·Firestore·Functions 에뮬레이터 필요). firebase emulators:exec 안에서 실행.
// 설치된 Microsoft Edge(또는 Chrome)를 playwright-core 로 구동한다. 브라우저 다운로드 없음.
// 진행자·참가자1·참가자2·공개 화면을 각각 독립 브라우저 컨텍스트(서로 다른 인증 상태)로 연다.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SEQUENCES, runLocal } from './fixtures/sequences.mjs';
import * as rules from '../src/games/demo-number-choice/rules.js';
import { approveHostInEmulator } from '../scripts/emulator-approve-host.mjs';

const BASE = process.env.DKBA_BASE_URL || 'http://127.0.0.1:5000';
const ART = path.resolve('tests/.artifacts');
const CHANNEL = process.env.DKBA_BROWSER_CHANNEL || 'msedge';
const seq = SEQUENCES.find((s) => s.name === 'e2e-shared');

const log = (...a) => console.log('[e2e]', ...a);
const errors = [];

async function newPage(browser, label, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
  return { context, page };
}

async function join(page, code, nickname) {
  await page.goto(`${BASE}/play.html`);
  await page.locator('#join-code').fill(code);
  await page.locator('#join-nickname').fill(nickname);
  await page.keyboard.press('Enter'); // 키보드로 제출
  await page.locator('[data-seat]').waitFor();
}

async function pick(page, round, value) {
  await page.locator('.g-dnc__round', { hasText: `${round} / 3 라운드` }).waitFor();
  await page.locator(`.g-dnc__choice[data-choice="${value}"]`).click();
  await page.locator('.g-dnc__mine', { hasText: `제출 완료: ${value}` }).waitFor();
}

async function main() {
  await mkdir(ART, { recursive: true });
  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  try {
    const host = await newPage(browser, 'host', { width: 1280, height: 860 });
    const p1 = await newPage(browser, 'p1', { width: 390, height: 844 });
    const p2 = await newPage(browser, 'p2', { width: 390, height: 844 });

    // 홈·게임 목록·상세
    await host.page.goto(`${BASE}/index.html`);
    const cards = await host.page.locator('[data-game-id]').count();
    assert.equal(cards, 1, '구현된 샘플 1개만 표시');
    assert.match(await host.page.locator('[data-game-id]').innerText(), /개발 검증용/);
    await host.page.locator('a', { hasText: '자세히 보기' }).click();
    await host.page.locator('h1', { hasText: '숫자 선택 샘플' }).waitFor();
    await host.page.locator('a', { hasText: '진행자로 방 만들기' }).click();
    log('home/list/detail OK');

    // 진행자 Google 로그인 (Auth 에뮬레이터의 Google 로그인 창 사용, 에뮬레이터 전용 가상 계정)
    const hostEmail = `e2e-host-${randomUUID().slice(0, 8)}@example.test`;
    const [popup] = await Promise.all([
      host.page.waitForEvent('popup'),
      host.page.locator('[data-action="google-sign-in"]').click(),
    ]);
    await popup.waitForLoadState('load');
    await popup.locator('#add-account-button').waitFor({ state: 'visible' });
    for (let i = 0; i < 5 && !(await popup.locator('#email-input').isVisible()); i += 1) {
      await popup.locator('#add-account-button').click(); // 위젯 스크립트 준비 전 클릭 대비
      await popup.waitForTimeout(300);
    }
    await popup.locator('#email-input').fill(hostEmail);
    await popup.locator('#display-name-input').fill('E2E 진행자');
    await popup.locator('#sign-in').click();
    await host.page.locator('[data-action="create-room"]').waitFor();
    assert.match(await host.page.locator('.dk-status').first().innerText(), new RegExp(hostEmail));
    log('google sign-in OK');
    // 서버 응답이 없을 때(통신 실패·서버 미배포) 방 만들기 안내: 게임 제출용 문구가 아닌 일반 안내
    await host.page.route('**/createRoom', (route) => route.abort('failed'));
    await host.page.locator('[data-action="create-room"]').click();
    const noResp = await host.page.locator('.dk-message--error', { hasText: '서버(Functions) 응답을 받지 못했습니다' }).innerText();
    assert.ok(!noResp.includes('제출 상태'), `방 만들기 실패 안내에 제출 문구가 섞임: ${noResp}`);
    await host.page.unroute('**/createRoom');
    log('create-room no-response message OK');
    // 승인 전: 방 만들기 거부 + 승인 요청 안내
    await host.page.locator('[data-action="create-room"]').click();
    await host.page.locator('.dk-message--error', { hasText: '진행자 승인이 필요합니다' }).waitFor();
    log('unapproved host rejected');
    // 관리자가 승인 목록에 추가한 뒤 다시 시도
    await approveHostInEmulator(hostEmail);
    await host.page.locator('[data-action="create-room"]').click();
    await host.page.locator('[data-room-code]').filter({ hasNotText: '------' }).waitFor();
    const code = (await host.page.locator('[data-room-code]').innerText()).trim();
    assert.match(code, /^[A-Z2-9]{6}$/);
    const roomId = new URL(host.page.url()).searchParams.get('room');
    log('room created', code);

    // 공개 화면
    const display = await newPage(browser, 'display', { width: 1600, height: 900 });
    await display.page.goto(`${BASE}/display.html?room=${roomId}`);
    await display.page.locator('[data-room-code]', { hasText: code }).waitFor();

    // 참가자 입장
    await join(p1.page, code, seq.names[0]);
    await join(p2.page, code, seq.names[1]);
    await host.page.locator('[data-player-id="p2"]').waitFor();
    await p1.page.locator('.dk-message', { hasText: '기다리는 중' }).waitFor();
    log('players joined');

    // 시작 이후 신규 입장 차단 확인용 4번째 컨텍스트
    const late = await newPage(browser, 'late', { width: 390, height: 844 });

    // 게임 시작 (키보드 포커스 + Enter)
    const startBtn = host.page.locator('[data-action="start-game"]');
    await startBtn.focus();
    await host.page.keyboard.press('Enter');
    await host.page.locator('[data-action="close-round"]').waitFor();
    log('started');

    await late.page.goto(`${BASE}/play.html`);
    await late.page.locator('#join-code').fill(code);
    await late.page.locator('#join-nickname').fill('늦은참가');
    await late.page.locator('[data-action="join"]').click();
    await late.page.locator('.dk-message--error', { hasText: '이미 시작된 방' }).waitFor();
    log('late join rejected');

    for (const [index, [a, b]] of seq.rounds.entries()) {
      const round = index + 1;
      if (a !== null) await pick(p1.page, round, a);
      if (round === 2) {
        // 참가자2 새로고침 → 자리·상태 복구
        await p2.page.reload();
        await p2.page.locator('.dk-message', { hasText: '재접속되었습니다' }).waitFor();
        await p2.page.locator('[data-seat="p2"]').waitFor();
        await p2.page.locator('.g-dnc__round', { hasText: '2 / 3 라운드' }).waitFor();
        // 상대 제출 내역(공개 정보)도 복구되어 보임
        await p2.page.locator('tr[data-player="p1"]', { hasText: `제출 완료: ${a}` }).waitFor();
        log('p2 reload → seat restored');
      }
      if (b !== null) await pick(p2.page, round, b);
      // 진행자 화면에서 제출 상태 확인 후 마감
      if (a !== null) await host.page.locator('tr[data-player="p1"]', { hasText: `제출 완료: ${a}` }).waitFor();
      if (b !== null) await host.page.locator('tr[data-player="p2"]', { hasText: `제출 완료: ${b}` }).waitFor();
      else await host.page.locator('tr[data-player="p2"]', { hasText: '미제출' }).waitFor();
      await host.page.locator('[data-action="close-round"]', { hasText: `${round}라운드 마감` }).click();
      if (round < 3) await host.page.locator('[data-action="close-round"]', { hasText: `${round + 1}라운드 마감` }).waitFor();
      log(`round ${round} closed`);
      if (round === 1) {
        // 진행자 새로고침 → 로그인 유지·같은 방(?room=)과 진행 상태 복구
        await host.page.reload();
        await host.page.locator('[data-room-code]', { hasText: code }).waitFor();
        await host.page.locator('[data-action="close-round"]', { hasText: '2라운드 마감' }).waitFor();
        log('host reload → room restored');
      }
    }

    // 결과 확인 (진행자·참가자·공개 화면)
    const expected = runLocal(rules, seq);
    for (const [label, page] of [['host', host.page], ['p1', p1.page], ['p2', p2.page], ['display', display.page]]) {
      await page.locator('.g-dnc__result').waitFor();
      const text = await page.locator('.g-dnc__ranking').innerText();
      for (const r of expected.ranking) assert.ok(text.includes(`${r.rank}위 ${r.name} · ${r.score}점`), `${label} 결과 불일치: ${text}`);
      log(`${label} result: ${text.replace(/\n/g, ' | ')}`);
    }
    await host.page.screenshot({ path: path.join(ART, 'online-host-result.png'), fullPage: true });
    await p1.page.screenshot({ path: path.join(ART, 'online-player-result.png'), fullPage: true });
    await display.page.screenshot({ path: path.join(ART, 'online-display-result.png'), fullPage: true });

    // 참가자 나가기 → 입장 화면 복귀
    await p1.page.locator('[data-action="leave"]').click();
    await p1.page.locator('#join-code').waitFor();
    log('leave OK');

    const relevant = errors.filter((e) => !/favicon/i.test(e));
    if (relevant.length) {
      console.log('[e2e] 브라우저 콘솔 오류:\n' + relevant.join('\n'));
    }
    // 의도적으로 거부된 요청(늦은 입장)은 콘솔에 오류로 남을 수 있으므로 그 외 오류만 실패 처리
    // 허용(의도된 거부만): 'late' 의 joinRoom 400(시작 이후 입장 거부), 'host' 의 createRoom 403(승인 전 진행자) 각 1건
    const intended = (e) => (e.startsWith('late:') && (/HTTP 400 .*\/joinRoom$/.test(e) || /status of 400/.test(e)))
      || (e.startsWith('host:') && (/HTTP 403 .*\/createRoom$/.test(e) || /status of 403/.test(e)))
      || (e === 'host: Failed to load resource: net::ERR_FAILED'); // 의도적으로 차단한 createRoom 요청(응답 없음 안내 확인)
    const unexpected = relevant.filter((e) => !intended(e));
    assert.equal(unexpected.length, 0, `예상치 못한 콘솔 오류: ${unexpected.join('\n')}`);
    log('PASS 온라인 E2E');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exit(1);
});
