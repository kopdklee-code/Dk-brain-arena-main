// 오프라인 실행형 검증: ZIP 을 새 임시 폴더에 풀고 standalone.html 을 file:// 로 연다.
// 브라우저 컨텍스트를 offline 으로 설정하고, file: 이외의 모든 요청을 차단·기록한다. 3라운드 완료·결과·내보내기·초기화 확인.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEQUENCES, runLocal } from './fixtures/sequences.mjs';
import * as rules from '../src/games/demo-number-choice/rules.js';

const CHANNEL = process.env.DKBA_BROWSER_CHANNEL || 'msedge';
const PKG_DIR = path.resolve('dist/packages');
const ART = path.resolve('tests/.artifacts');
const seq = SEQUENCES.find((s) => s.name === 'e2e-shared');
const log = (...a) => console.log('[offline]', ...a);

function extractZip(zip, dest) {
  // Windows: PowerShell Expand-Archive, 그 외: unzip
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { encoding: 'utf8' })
    : spawnSync('unzip', ['-q', zip, '-d', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ZIP 해제 실패: ${r.stderr || r.stdout}`);
}

async function runOnce(browser, htmlPath, label) {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const blocked = [];
  const allRequests = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    allRequests.push(url);
    if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    blocked.push(url);
    return route.abort('internetdisconnected');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());

  const url = pathToFileURL(htmlPath).href;
  await page.goto(url);
  assert.ok(page.url().startsWith('file:'), 'file:// 로 열림');
  await page.locator('.sa-demo', { hasText: '개발 검증용' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.onLine), false, '브라우저가 오프라인 상태');

  await page.locator('#sa-name-1').fill(seq.names[0]);
  await page.locator('#sa-name-2').fill(seq.names[1]);
  await page.locator('#sa-name-2').press('Enter'); // 키보드로 시작
  for (const [index, [a, b]] of seq.rounds.entries()) {
    const round = index + 1;
    await page.locator('.g-dnc__round', { hasText: `${round} / 3 라운드` }).waitFor();
    if (a !== null) await page.locator(`.g-dnc__choice[data-player="p1"][data-choice="${a}"]`).click();
    if (b !== null) await page.locator(`.g-dnc__choice[data-player="p2"][data-choice="${b}"]`).click();
    // 같은 플레이어 중복 제출 시도: 버튼 비활성
    if (a !== null) assert.equal(await page.locator('.g-dnc__choice[data-player="p1"][data-choice="1"]').isDisabled(), true);
    await page.locator('[data-action="close-round"]').click();
  }
  await page.locator('.g-dnc__result').waitFor();
  const text = await page.locator('.g-dnc__ranking').innerText();
  const expected = runLocal(rules, seq);
  for (const r of expected.ranking) assert.ok(text.includes(`${r.rank}위 ${r.name} · ${r.score}점`), `결과 불일치: ${text}`);
  log(`${label} result: ${text.replace(/\n/g, ' | ')}`);
  await page.screenshot({ path: path.join(ART, `offline-${label}-result.png`), fullPage: true });

  // 결과 내보내기 (CSV)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="export"]').click()]);
  const csvPath = path.join(ART, `offline-${label}-result.csv`);
  await download.saveAs(csvPath);
  const csv = (await readFile(csvPath, 'utf8')).replace(/^﻿/, '');
  for (const r of expected.ranking) assert.ok(csv.includes(`${r.rank},${r.name},${r.score}`), `CSV 불일치:\n${csv}`);
  log(`${label} CSV export OK (${download.suggestedFilename()})`);

  // 진행 초기화
  await page.locator('[data-action="reset"]').click();
  await page.locator('#sa-name-1').waitFor();
  log(`${label} reset OK`);

  assert.deepEqual(blocked, [], `외부 요청 발생: ${blocked.join(', ')}`);
  assert.ok(allRequests.every((u) => /^(file|data|blob):/.test(u)), `비-file 요청: ${allRequests.join(', ')}`);
  assert.deepEqual(errors, [], `페이지 오류: ${errors.join('\n')}`);
  log(`${label} requests: ${allRequests.length}개, 모두 file:/data:/blob: (외부 요청 0)`);
  await context.close();
}

async function main() {
  await mkdir(ART, { recursive: true });
  const zips = (await readdir(PKG_DIR)).filter((f) => f.endsWith('.zip'));
  assert.equal(zips.length, 1, `ZIP 1개 예상: ${zips}`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dkba-offline-'));
  extractZip(path.join(PKG_DIR, zips[0]), tmp);
  const files = (await readdir(tmp)).sort();
  log('ZIP contents:', files.join(', '));
  for (const f of ['standalone.html', 'QUICKSTART.txt', 'VERSION.txt', 'NOTICE_DEV_SAMPLE.txt']) assert.ok(files.includes(f), `${f} 누락`);
  assert.equal(files.length, 4, '예상 외 파일 포함');
  const notice = await readFile(path.join(tmp, 'NOTICE_DEV_SAMPLE.txt'), 'utf8');
  assert.match(notice, /판매 상품이 아니며/);

  const browser = await chromium.launch({ channel: CHANNEL, headless: true });
  try {
    await runOnce(browser, path.join(tmp, 'standalone.html'), 'zip-extracted');
  } finally {
    await browser.close();
  }
  log('PASS 오프라인 실행형');
}

main().catch((err) => {
  console.error('[offline] FAIL', err);
  process.exit(1);
});
