// 연결 끊김·재연결 E2E (Hosting·Auth·Firestore·Functions 에뮬레이터 필요). firebase emulators:exec 안에서 실행.
// 진행자(이메일 계정) + 참가자 2명(각각 별도 익명 UID, 독립 브라우저 컨텍스트).
// 참가자2의 통신을 차단·복원하며 다음을 확인한다:
//  A. 끊김 안내가 표시되고 유지되는가 (캐시 이벤트로 덮이지 않음)
//  B. 서버가 접수하지 않은 선택을 '제출 완료'로 표시하지 않는가
//  C. 복원 후 자리·현재 라운드·본인 제출 상태가 서버 기준으로 복구되는가
//  D. 서버는 접수했지만 응답이 유실된 경우, 화면은 서버 기준(제출 완료)으로 표시되고 점수는 1회만 반영되는가
//  E. 재접속(새로고침) 후 참가자 중복 등록이 없는가
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SEQUENCES, runLocal } from './fixtures/sequences.mjs';
import * as rules from '../src/games/demo-number-choice/rules.js';

const BASE = process.env.DKBA_BASE_URL || 'http://127.0.0.1:5000';
const CHANNEL = process.env.DKBA_BROWSER_CHANNEL || 'msedge';
const ART = path.resolve('tests/.artifacts');
const seq = SEQUENCES.find((s) => s.name === 'reconnect');
const log = (...a) => console.log('[reconnect]', ...a);
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  assert.ok(ok, `${label} ${detail}`);
};

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport });
  return { context, page: await context.newPage() };
}
const rowText = (page, id) => page.locator(`tr[data-player="${id}"]`).innerText();
const pillText = (page) => page.locator('.dk-status .dk-pill').first().innerText();

async function main() {
  await mkdir(ART, { recursive: true });
  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  try {
    const host = await newPage(browser, { width: 1280, height: 860 });
    const p1 = await newPage(browser, { width: 390, height: 844 });
    const p2 = await newPage(browser, { width: 390, height: 844 });

    await host.page.goto(`${BASE}/host.html`);
    await host.page.locator('#host-email').fill(`reconnect-host-${randomUUID().slice(0, 8)}@example.test`);
    await host.page.locator('#host-password').fill(`test-${randomUUID()}`);
    await host.page.locator('[data-action="sign-up"]').click();
    await host.page.locator('[data-action="create-room"]').click();
    await host.page.locator('[data-room-code]').filter({ hasNotText: '------' }).waitFor();
    const code = (await host.page.locator('[data-room-code]').innerText()).trim();

    for (const [pp, name] of [[p1, seq.names[0]], [p2, seq.names[1]]]) {
      await pp.page.goto(`${BASE}/play.html`);
      await pp.page.locator('#join-code').fill(code);
      await pp.page.locator('#join-nickname').fill(name);
      await pp.page.locator('[data-action="join"]').click();
      await pp.page.locator('[data-seat]').waitFor();
    }
    const uid1 = await p1.page.evaluate(() => Object.keys(localStorage).length && JSON.parse(localStorage.getItem('dkba.player.session')).uid);
    const uid2 = await p2.page.evaluate(() => JSON.parse(localStorage.getItem('dkba.player.session')).uid);
    check('참가자 2명은 서로 다른 인증 UID', uid1 && uid2 && uid1 !== uid2);
    await host.page.locator('[data-player-id="p2"]').waitFor();
    await host.page.locator('[data-action="start-game"]').click();
    await p2.page.locator('.g-dnc__round', { hasText: '1 / 3 라운드' }).waitFor();

    // ── 1라운드: p1 제출, p2 통신 차단 ──
    await p1.page.locator('.g-dnc__choice[data-choice="2"]').click();
    await p1.page.locator('.g-dnc__mine', { hasText: '제출 완료: 2' }).waitFor();
    await p2.context.setOffline(true);
    await p2.page.locator('[data-connection-notice]', { hasText: '연결이 끊겼습니다' }).waitFor({ timeout: 10000 });
    check('A1 끊김 시 상태 라벨', (await pillText(p2.page)).includes('오프라인'), await pillText(p2.page));
    await p2.page.waitForTimeout(4000); // Firestore 가 캐시 상태로 전환할 시간
    const pillAfter = await pillText(p2.page);
    check('A2 끊김 안내 유지 (4초 후에도 오프라인 표시)', pillAfter.includes('오프라인') && await p2.page.locator('[data-connection-notice]', { hasText: '연결이 끊겼습니다' }).isVisible(), pillAfter);
    await p2.page.screenshot({ path: path.join(ART, 'reconnect-p2-offline.png'), fullPage: true });

    // 오프라인 상태에서 선택
    await p2.page.locator('.g-dnc__choice[data-choice="3"]').click();
    await p2.page.locator('.g-dnc__error').waitFor({ timeout: 30000 });
    const errText = await p2.page.locator('.g-dnc__error').innerText();
    check('B1 오프라인 제출 실패 안내 (internal 노출 없음)', errText.includes('서버 응답을 받지 못했습니다') && !/internal/i.test(errText), errText);
    const p2RowOffline = await rowText(p2.page, 'p2');
    check('B2 미접수 선택을 제출 완료로 표시하지 않음 (본인 화면)', p2RowOffline.includes('미제출') && !(await p2.page.locator('.g-dnc__mine').innerText()).includes('제출 완료'), p2RowOffline.replace(/\s+/g, ' '));
    await p2.page.screenshot({ path: path.join(ART, 'reconnect-p2-offline-submit.png'), fullPage: true });
    await p2.page.waitForTimeout(1500);
    check('B3 서버(진행자 화면)에도 p2 미제출', (await rowText(host.page, 'p2')).includes('미제출'));

    // p2 가 끊긴 동안 진행자가 1라운드 마감 → p2 는 0점, 라운드 2로 진행
    await host.page.locator('[data-action="close-round"]', { hasText: '1라운드 마감' }).click();
    await host.page.locator('[data-action="close-round"]', { hasText: '2라운드 마감' }).waitFor();

    // ── 통신 복원 ──
    await p2.context.setOffline(false);
    await p2.page.locator('.dk-status .dk-pill', { hasText: '연결됨' }).waitFor({ timeout: 30000 });
    check('C1 복원 후 연결됨 표시·끊김 안내 사라짐', !(await p2.page.locator('[data-connection-notice] .dk-message').count()));
    await p2.page.locator('.g-dnc__round', { hasText: '2 / 3 라운드' }).waitFor({ timeout: 30000 });
    check('C2 복원 후 현재 라운드(2) 복구', true);
    check('C3 복원 후 자리 유지 (p2)', await p2.page.locator('[data-seat="p2"]').count() === 1);
    const myRow = await rowText(p2.page, 'p2');
    check('C4 복원 후 본인 제출 상태 = 서버 기준 (2라운드 미제출, 1라운드 0점)', myRow.includes('미제출') && myRow.includes('0점'), myRow.replace(/\s+/g, ' '));
    check('C5 복원 후 이전 실패 안내 제거', await p2.page.locator('.g-dnc__error').count() === 0);
    await p2.page.screenshot({ path: path.join(ART, 'reconnect-p2-restored.png'), fullPage: true });

    // ── 2라운드: 서버는 접수했지만 응답 유실 ──
    let serverReply = null;
    await p2.page.route('**/gameAction', async (route) => {
      const res = await route.fetch(); // 요청은 실제로 서버에 도달
      serverReply = { status: res.status(), body: await res.text() };
      await route.abort('connectionreset'); // 응답만 브라우저에 전달하지 않음
    });
    await p2.page.locator('.g-dnc__choice[data-choice="3"]').click();
    await p2.page.locator('.g-dnc__mine', { hasText: '제출 완료: 3' }).waitFor({ timeout: 30000 });
    await p2.page.unroute('**/gameAction');
    check('D1 서버가 실제로 접수함 (응답만 유실)', serverReply?.status === 200 && serverReply.body.includes('"ok":true'), serverReply?.body);
    await p2.page.waitForTimeout(1000);
    const errAfterLost = await p2.page.locator('.g-dnc__error').count();
    check('D2 화면은 서버 기준 제출 완료로 표시 (확정 실패로 단정하지 않음)',
      errAfterLost === 0 || (await p2.page.locator('.g-dnc__error').innerText()).includes('서버 기준'),
      errAfterLost === 0 ? '실패 안내 없음' : '서버 기준 확인 안내 표시');
    check('D3 같은 라운드 재선택 불가 (버튼 비활성)', await p2.page.locator('.g-dnc__choice[data-choice="1"]').isDisabled());

    // ── E: 재접속(새로고침) 후 중복 등록 없음 ──
    await p2.page.reload();
    await p2.page.locator('.dk-message', { hasText: '재접속되었습니다' }).waitFor();
    await p2.page.locator('.g-dnc__mine', { hasText: '제출 완료: 3' }).waitFor();
    check('E1 새로고침 후 자리·제출 상태 복구', await p2.page.locator('[data-seat="p2"]').count() === 1);
    const hostPlayers = await host.page.locator('[data-players] li').count();
    const countText = await host.page.locator('p.dk-muted', { hasText: '명 입장' }).innerText();
    check('E2 참가자 중복 등록 없음 (진행자 목록 2명)', hostPlayers === 2 && countText.startsWith('2 / 2'), `${hostPlayers}명, ${countText}`);

    await p1.page.locator('.g-dnc__choice[data-choice="1"]').click();
    await host.page.locator('tr[data-player="p2"]', { hasText: '제출 완료: 3' }).waitFor();
    await host.page.locator('[data-action="close-round"]', { hasText: '2라운드 마감' }).click();
    await host.page.locator('[data-action="close-round"]', { hasText: '3라운드 마감' }).waitFor();

    // ── 3라운드: 정상 진행 ──
    await p1.page.locator('.g-dnc__round', { hasText: '3 / 3 라운드' }).waitFor();
    await p1.page.locator('.g-dnc__choice[data-choice="3"]').click();
    await p2.page.locator('.g-dnc__round', { hasText: '3 / 3 라운드' }).waitFor();
    await p2.page.locator('.g-dnc__choice[data-choice="2"]').click();
    await host.page.locator('tr[data-player="p2"]', { hasText: '제출 완료: 2' }).waitFor();
    await host.page.locator('[data-action="close-round"]', { hasText: '3라운드 마감' }).click();

    const expected = runLocal(rules, seq);
    for (const [label, page] of [['host', host.page], ['p1', p1.page], ['p2', p2.page]]) {
      await page.locator('.g-dnc__result').waitFor();
      const text = await page.locator('.g-dnc__ranking').innerText();
      const ok = expected.ranking.every((r) => text.includes(`${r.rank}위 ${r.name} · ${r.score}점`));
      check(`F 최종 점수 = 로컬 판정, 중복 반영 없음 (${label})`, ok, text.replace(/\n/g, ' | '));
    }
    await p2.page.screenshot({ path: path.join(ART, 'reconnect-p2-result.png'), fullPage: true });
    log(`PASS 연결 끊김·재연결 E2E (${results.length}개 확인)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[reconnect] FAIL', err);
  process.exit(1);
});
