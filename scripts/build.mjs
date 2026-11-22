// DK BRAIN ARENA 빌드: 하나의 게임 원본(src/games)에서
//   functions  → functions/generated/games.js   (Cloud Functions 배포 묶음 안에 포함되는 규칙 번들)
//   hosting    → dist/hosting/                   (Firebase Hosting 공개 파일)
//   packages   → dist/packages/                  (개별 판매·배포용 오프라인 파일, Hosting 에 배포하지 않음)
// 사용법: node scripts/build.mjs [all|functions|hosting|packages]
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const GAMES_DIR = path.join(SRC, 'games');
const DIST_HOSTING = path.join(ROOT, 'dist', 'hosting');
const DIST_PACKAGES = path.join(ROOT, 'dist', 'packages');
const FUNCTIONS_GENERATED = path.join(ROOT, 'functions', 'generated');

const GENERATED_BANNER = '// 자동 생성 파일 — 직접 수정하지 마세요. 원본: src/games, src/shared. 생성: scripts/build.mjs';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function listGames() {
  const entries = await readdir(GAMES_DIR, { withFileTypes: true });
  const games = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(GAMES_DIR, e.name, 'manifest.json');
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.gameId !== e.name) throw new Error(`디렉터리 이름(${e.name})과 gameId(${manifest.gameId})가 다릅니다.`);
    games.push({ dir: path.join(GAMES_DIR, e.name), manifest });
  }
  return games;
}

async function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(ROOT, f).replace(/\\/g, '/'));
    h.update(await readFile(f));
  }
  return h.digest('hex').slice(0, 16);
}

// ── Functions 규칙 번들 ─────────────────────────────────────
async function buildFunctions() {
  await rm(FUNCTIONS_GENERATED, { recursive: true, force: true });
  await mkdir(FUNCTIONS_GENERATED, { recursive: true });
  const result = await build({
    entryPoints: [path.join(SRC, 'shared', 'server-entry.js')],
    outfile: path.join(FUNCTIONS_GENERATED, 'games.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: { js: GENERATED_BANNER },
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  if (inputs.some((i) => i.endsWith('view.js') || i.includes('firebase'))) {
    throw new Error(`서버 규칙 번들에 화면·Firebase 코드가 섞였습니다: ${inputs.join(', ')}`);
  }
  const games = await listGames();
  await writeFile(path.join(FUNCTIONS_GENERATED, 'BUILD_INFO.json'), JSON.stringify({
    note: '자동 생성. 원본을 수정한 뒤 npm run build:functions 로 다시 생성하세요.',
    sources: inputs,
    sourceHash: await hashFiles(inputs.map((i) => path.join(ROOT, i))),
    games: games.map((g) => ({ gameId: g.manifest.gameId, gameVersion: g.manifest.gameVersion })),
  }, null, 2));
  console.log(`[functions] functions/generated/games.js (입력 ${inputs.length}개)`);
}

// ── Hosting 공개 파일 ───────────────────────────────────────
async function buildHosting() {
  await rm(DIST_HOSTING, { recursive: true, force: true });
  await mkdir(path.join(DIST_HOSTING, 'css'), { recursive: true });
  const layout = await readFile(path.join(SRC, 'platform', 'html', '_layout.html'), 'utf8');
  const pages = JSON.parse(await readFile(path.join(SRC, 'platform', 'html', 'pages.json'), 'utf8'));
  for (const [file, data] of Object.entries(pages)) {
    const html = layout.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in data ? data[key] : ''));
    await writeFile(path.join(DIST_HOSTING, `${file}.html`), html);
  }
  await cp(path.join(SRC, 'platform', 'styles.css'), path.join(DIST_HOSTING, 'css', 'styles.css'));
  await cp(path.join(SRC, 'platform', 'assets'), path.join(DIST_HOSTING, 'assets'), { recursive: true });
  const entryPoints = (await readdir(path.join(SRC, 'platform')))
    .filter((f) => f.endsWith('.page.js'))
    .map((f) => path.join(SRC, 'platform', f));
  await build({
    entryPoints,
    outdir: path.join(DIST_HOSTING, 'js'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    chunkNames: 'chunks/[name]-[hash]',
    logLevel: 'warning',
  });
  for (const g of await listGames()) {
    if (!g.manifest.distributions.includes('platform')) continue;
    const out = path.join(DIST_HOSTING, 'games', g.manifest.gameId);
    await mkdir(out, { recursive: true });
    await cp(path.join(g.dir, 'game.css'), path.join(out, 'game.css'));
    if (await exists(path.join(g.dir, 'assets'))) await cp(path.join(g.dir, 'assets'), path.join(out, 'assets'), { recursive: true });
  }
  console.log('[hosting] dist/hosting');
}

// ── 오프라인 실행형 패키지 ───────────────────────────────────
function quickstartText(m) {
  return [
    `${m.title} — 빠른 시작`,
    '',
    m.isDemo ? '※ 개발 검증용 샘플입니다. 판매 상품이 아닙니다.' : '',
    '',
    '1. standalone.html 파일을 더블클릭해 PC 브라우저(Chrome, Edge 등)로 엽니다.',
    '   인터넷 연결이 필요 없습니다.',
    '2. 플레이어 이름을 입력하고 [게임 시작]을 누릅니다.',
    '3. 한 PC에서 진행자가 각 플레이어의 선택을 대신 입력하고 [라운드 마감]을 누릅니다.',
    '4. 마지막 라운드가 끝나면 최종 결과가 표시됩니다.',
    '   [결과 내보내기 (CSV)]로 결과 파일을 저장할 수 있습니다.',
    '5. [진행 초기화]를 누르면 처음부터 다시 시작합니다.',
    '',
    '안내: 이 파일은 여러 기기 접속(QR 등) 기능이 없습니다. 새로고침하면 진행 상황이 초기화됩니다.',
  ].join('\r\n');
}

function versionText(m, sourceHash) {
  return [
    `게임: ${m.title} (${m.gameId})`,
    `게임 버전: ${m.gameVersion}`,
    `배포 방식: 오프라인 실행형 (standalone.html 단일 파일)`,
    `원본 해시: ${sourceHash}`,
    `빌드 일시: ${new Date().toISOString()}`,
    '',
    '실행 조건',
    '- PC 브라우저: 최신 Chrome 또는 Microsoft Edge 권장',
    '- 인터넷 연결 불필요 (CDN, Firebase, 외부 폰트를 사용하지 않음)',
    '- 파일 직접 열기(file://)로 실행',
  ].join('\r\n');
}

function noticeText(m) {
  if (m.isDemo) {
    return [
      '개발 검증용 샘플 안내',
      '',
      `이 패키지(${m.gameId})는 DK BRAIN ARENA의 공통 구조와 오프라인 배포 방식을 검증하기 위한 개발용 샘플입니다.`,
      '판매 상품이 아니며, 상업용 라이선스 조건은 정해지지 않았습니다.',
    ].join('\r\n');
  }
  return null;
}

function escapeForInlineScript(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

async function buildPackages() {
  await rm(DIST_PACKAGES, { recursive: true, force: true });
  await mkdir(DIST_PACKAGES, { recursive: true });
  const shellCss = await readFile(path.join(SRC, 'standalone', 'shell.css'), 'utf8');
  for (const g of await listGames()) {
    const m = g.manifest;
    if (!m.distributions.includes('offline-standalone')) continue;
    const licensePath = path.join(g.dir, 'LICENSE.txt');
    if (!m.isDemo && !(await exists(licensePath))) {
      throw new Error(`${m.gameId}: 판매용 패키지에는 확정된 LICENSE.txt 가 필요합니다. (라이선스 조건 미확정)`);
    }
    const rel = (p) => './' + path.relative(ROOT, p).replace(/\\/g, '/');
    const hasIcon = await exists(path.join(g.dir, 'assets', 'icon.svg'));
    const entry = [
      `import { bootStandalone } from ${JSON.stringify(rel(path.join(SRC, 'standalone', 'shell.js')))};`,
      `import * as rules from ${JSON.stringify(rel(path.join(g.dir, 'rules.js')))};`,
      `import * as view from ${JSON.stringify(rel(path.join(g.dir, 'view.js')))};`,
      `import manifest from ${JSON.stringify(rel(path.join(g.dir, 'manifest.json')))};`,
      hasIcon ? `import iconUrl from ${JSON.stringify(rel(path.join(g.dir, 'assets', 'icon.svg')))};` : 'const iconUrl = null;',
      'bootStandalone({ manifest, rules, view, iconUrl });',
    ].join('\n');
    const result = await build({
      stdin: { contents: entry, resolveDir: ROOT, sourcefile: `standalone-${m.gameId}.js`, loader: 'js' },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
      metafile: true,
      logLevel: 'warning',
    });
    const inputs = Object.keys(result.metafile.inputs).filter((i) => !i.startsWith('<stdin>') && !i.startsWith('standalone-')).sort();
    const forbidden = inputs.filter((i) => i.includes('node_modules') || i.includes('adapters/firebase') || i.includes('src/platform'));
    if (forbidden.length) throw new Error(`${m.gameId}: 오프라인 패키지에 허용되지 않은 코드 포함: ${forbidden.join(', ')}`);
    const otherGames = inputs.filter((i) => i.startsWith('src/games/') && !i.startsWith(`src/games/${m.gameId}/`));
    if (otherGames.length) throw new Error(`${m.gameId}: 다른 게임 코드 포함: ${otherGames.join(', ')}`);
    const js = escapeForInlineScript(result.outputFiles[0].text);
    const gameCss = await readFile(path.join(g.dir, 'game.css'), 'utf8');
    const sourceHash = await hashFiles([...inputs.map((i) => path.join(ROOT, i)), path.join(SRC, 'standalone', 'shell.css'), path.join(g.dir, 'game.css')]);
    const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="dkba-game" content="${m.gameId}@${m.gameVersion}">
<meta name="dkba-source-hash" content="${sourceHash}">
<title>${m.title}${m.isDemo ? ' (개발 검증용)' : ''}</title>
<style>
${shellCss}
${gameCss}
</style>
</head>
<body>
<!-- 자동 생성 파일 — 직접 수정하지 마세요. 원본: src/games/${m.gameId}, src/standalone. 생성: scripts/build.mjs -->
<div id="app"><p>JavaScript를 켜야 실행됩니다.</p></div>
<script>
${js}
</script>
</body>
</html>
`;
    const outDir = path.join(DIST_PACKAGES, m.gameId);
    await mkdir(outDir, { recursive: true });
    const bom = '﻿';
    const files = [
      { name: 'standalone.html', data: html },
      { name: 'QUICKSTART.txt', data: bom + quickstartText(m) },
      { name: 'VERSION.txt', data: bom + versionText(m, sourceHash) },
    ];
    const notice = noticeText(m);
    if (notice) files.push({ name: 'NOTICE_DEV_SAMPLE.txt', data: bom + notice });
    else files.push({ name: 'LICENSE.txt', data: await readFile(licensePath) });
    for (const f of files) await writeFile(path.join(outDir, f.name), f.data);
    const zipName = `${m.gameId}-${m.gameVersion}${m.isDemo ? '-dev-sample' : ''}.zip`;
    await writeFile(path.join(DIST_PACKAGES, zipName), createZip(files));
    console.log(`[packages] dist/packages/${m.gameId}/standalone.html (${Math.round(Buffer.byteLength(html) / 1024)} KB), dist/packages/${zipName}`);
  }
}

const target = process.argv[2] || 'all';
const steps = { functions: buildFunctions, hosting: buildHosting, packages: buildPackages };
try {
  if (target === 'all') {
    for (const fn of Object.values(steps)) await fn();
  } else if (steps[target]) {
    await steps[target]();
  } else {
    throw new Error(`알 수 없는 대상: ${target} (all|functions|hosting|packages)`);
  }
} catch (err) {
  console.error(`[build] 실패: ${err.message}`);
  process.exit(1);
}
