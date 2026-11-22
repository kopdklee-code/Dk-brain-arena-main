// Hosting 산출물과 판매 패키지가 분리되어 있는지 확인
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const HOSTING = path.join(ROOT, 'dist', 'hosting');
const PACKAGES = path.join(ROOT, 'dist', 'packages');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const firebaseJson = JSON.parse(await readFile(path.join(ROOT, 'firebase.json'), 'utf8'));
assert.equal(firebaseJson.hosting.public, 'dist/hosting', 'Hosting 공개 경로는 dist/hosting 만');
console.log('[dist] firebase.json hosting.public = dist/hosting');

const hostingFiles = await walk(HOSTING);
const packageFiles = await walk(PACKAGES);

// 1) Hosting 에 판매 패키지·오프라인 파일·서버 코드가 없음
const badHosting = hostingFiles.filter((f) => /\.zip$|standalone\.html$|QUICKSTART|NOTICE_DEV_SAMPLE|VERSION\.txt|packages|functions|firestore\.rules|\.env/i.test(rel(f)));
assert.deepEqual(badHosting.map(rel), [], 'Hosting 에 판매용·서버 파일 포함');
for (const f of hostingFiles.filter((x) => x.endsWith('.js'))) {
  const js = await readFile(f, 'utf8');
  // 배포 방식 이름 표시('standalone.html' 문구)는 허용, 패키지 경로·ZIP 링크는 금지
  assert.ok(!/dist\/packages|packages\/demo|\.zip\b/.test(js), `${rel(f)} 가 판매 패키지 경로를 참조`);
  assert.ok(!/private_key|BEGIN PRIVATE KEY|service_account/i.test(js), `${rel(f)} 에 비밀키 흔적`);
}
console.log(`[dist] hosting files: ${hostingFiles.length}개 — 판매 패키지·서버 코드 없음`);

// 2) 판매 패키지에 Firebase·플랫폼 관리 코드·외부 URL·다른 게임이 없음
const html = await readFile(path.join(PACKAGES, 'demo-number-choice', 'standalone.html'), 'utf8');
const urls = [...html.matchAll(/https?:\/\/[^\s"'()<>]+/g)].map((m) => m[0]);
const externalUrls = urls.filter((u) => !u.startsWith('http://www.w3.org/'));
assert.deepEqual(externalUrls, [], `외부 URL 포함: ${externalUrls}`);
for (const token of ['firebase', 'firestore', 'googleapis', 'gstatic', 'identitytoolkit', 'httpsCallable', 'host.page', 'hostUid', '<script src', '<link ', 'import(']) {
  assert.ok(!html.toLowerCase().includes(token.toLowerCase()), `standalone.html 에 '${token}' 포함`);
}
assert.ok(!/type=["']module["']/.test(html), 'ES module 스크립트 사용 금지 (file:// 실행)');
const pkgNames = packageFiles.map(rel);
assert.ok(pkgNames.every((n) => n.startsWith('dist/packages/demo-number-choice')), `다른 게임 포함: ${pkgNames}`);
const htmlStat = await stat(path.join(PACKAGES, 'demo-number-choice', 'standalone.html'));
console.log(`[dist] packages: ${pkgNames.join(', ')}`);
console.log(`[dist] standalone.html ${Math.round(htmlStat.size / 1024)} KB — 외부 URL·Firebase·module 스크립트 없음 (SVG 네임스페이스 ${urls.length - externalUrls.length}건 제외)`);
console.log('[dist] PASS');
