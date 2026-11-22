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

    // 진행자 계정 생성 (에뮬레이터 전용 테스트 계정)
    await host.page.locator('#host-email').fill(`e2e-host-${randomUUID().slice(0, 8)}@example.test`);
    await host.page.locator('#host-password').fill(`test-${randomUUID()}`);
    await host.page.locator('[data-action="sign-up"]').click();
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
    // 허용: 'late' 컨텍스트의 joinRoom 400 응답(시작 이후 입장 거부 — 의도된 결과)만
    const unexpected = relevant.filter((e) => !(e.startsWith('late:') && (/HTTP 400 .*\/joinRoom$/.test(e) || /status of 400/.test(e))));
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
