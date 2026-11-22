// Functions 배포 묶음 자립성 확인:
//  1) firebase.json 의 ignore 규칙대로 functions/ 를 새 임시 디렉터리에 복사 (배포 업로드와 같은 범위)
//  2) 모든 상대 import 가 묶음 안에서 해석되는지, 외부 패키지는 dependencies 에 있는지 정적 확인
//  3) 새 디렉터리에서 npm install --omit=dev 후 index.js 와 규칙 번들을 실제로 import 해서 판정 실행
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve('.');
const FUNCTIONS = path.join(ROOT, 'functions');
const firebaseJson = JSON.parse(await readFile(path.join(ROOT, 'firebase.json'), 'utf8'));
const fnConfig = firebaseJson.functions[0];
const ignore = new Set(fnConfig.ignore.filter((p) => !p.includes('*')));

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dkba-functions-'));
await cp(FUNCTIONS, tmp, {
  recursive: true,
  filter: (src) => !path.relative(FUNCTIONS, src).split(path.sep).some((seg) => ignore.has(seg)) && !src.endsWith('.log'),
});
console.log(`[functions-bundle] 복사 위치: ${tmp}`);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...(await walk(p))); } else out.push(p);
  }
  return out;
}
const files = await walk(tmp);
console.log(`[functions-bundle] 묶음 파일: ${files.map((f) => path.relative(tmp, f).replace(/\\/g, '/')).join(', ')}`);
assert.ok(files.some((f) => f.endsWith(path.join('generated', 'games.js'))), 'generated/games.js 누락 (npm run build:functions 필요)');

const pkg = JSON.parse(await readFile(path.join(tmp, 'package.json'), 'utf8'));
const deps = new Set(Object.keys(pkg.dependencies || {}));
for (const f of files.filter((x) => x.endsWith('.js'))) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(target.startsWith(tmp), `${path.relative(tmp, f)}: 묶음 밖 참조 ${spec}`);
      await stat(target).catch(() => assert.fail(`${path.relative(tmp, f)}: 해석 불가 ${spec}`));
    } else if (!spec.startsWith('node:')) {
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      assert.ok(deps.has(name), `${path.relative(tmp, f)}: dependencies 에 없는 패키지 ${name}`);
    }
  }
}
console.log('[functions-bundle] 정적 확인: 상대 import 는 모두 묶음 내부, 외부 패키지는 dependencies 에 있음');

const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: tmp, encoding: 'utf8', shell: true });
assert.equal(install.status, 0, `npm install 실패: ${install.stderr}`);
console.log('[functions-bundle] 새 디렉터리 npm install --omit=dev 완료');

const games = await import(pathToFileURL(path.join(tmp, 'generated', 'games.js')).href);
const game = games.getGame('demo-number-choice');
let { state } = game.rules.createGame({ players: [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }] });
state = game.rules.executeAction(state, { role: 'player', playerId: 'p1' }, { type: 'choose', round: 1, value: 3 }).state;
state = game.rules.executeAction(state, { role: 'host' }, { type: 'closeRound', round: 1 }).state;
assert.deepEqual(state.scores, { p1: 3, p2: 0 });

// index.js 로드: Functions 정의(createRoom/joinRoom/startGame/gameAction)가 내보내지는지
process.env.GCLOUD_PROJECT ||= 'demo-dk-brain-arena';
const index = await import(pathToFileURL(path.join(tmp, 'src', 'index.js')).href);
for (const name of ['createRoom', 'joinRoom', 'startGame', 'gameAction']) assert.equal(typeof index[name], 'function', `${name} 누락`);
console.log(`[functions-bundle] 새 디렉터리에서 index.js·규칙 번들 import 및 판정 실행 OK (Node ${process.version})`);

// 목표 런타임(nodejs22) 호환: firebase-admin 의 하위 의존성 중 engines 가 Node 22 를 벗어나는 모듈
// (@firebase/database, @firebase/database-compat: >=24.12.0)이 실제로 로드되지 않는지 확인
const loaded = Object.keys(createRequire(import.meta.url).cache).map((p) => p.replace(/\\/g, '/'));
const nodeModulePkgs = new Set(loaded.filter((p) => p.includes('/node_modules/')).map((p) => {
  const rest = p.split('/node_modules/').pop().split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}));
const lock = JSON.parse(await readFile(path.join(tmp, 'package-lock.json'), 'utf8'));
const engineConflicts = Object.entries(lock.packages)
  .filter(([k, v]) => k && v.engines?.node && /^>=\s*(2[3-9]|[3-9]\d)/.test(v.engines.node.trim()))
  .map(([k, v]) => ({ name: k.split('node_modules/').pop(), range: v.engines.node }));
const loadedConflicts = engineConflicts.filter((c) => nodeModulePkgs.has(c.name));
console.log(`[functions-bundle] Node 22 범위를 벗어나는 engines 선언: ${engineConflicts.map((c) => `${c.name}(${c.range})`).join(', ') || '없음'}`);
console.log(`[functions-bundle] 실제 로드된 CommonJS 패키지 ${nodeModulePkgs.size}개 중 해당 모듈: ${loadedConflicts.map((c) => c.name).join(', ') || '없음'}`);
assert.deepEqual(loadedConflicts, [], 'Node 22 범위를 벗어나는 모듈이 실제로 로드됨');
console.log('[functions-bundle] PASS');
process.exit(0);
