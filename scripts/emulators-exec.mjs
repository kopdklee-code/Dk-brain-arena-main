// 에뮬레이터(demo- 프로젝트 고정) 안에서 명령을 실행한다. 다수 동시 접속 테스트용.
// Functions 에뮬레이터는 동시 요청마다 작업 프로세스를 새로 띄우므로, 수십 개를 띄울 때 로딩 제한(기본 30초)을 늘린다.
// 사용: node scripts/emulators-exec.mjs "node tests/..."
import { spawn } from 'node:child_process';

const command = process.argv.slice(2).join(' ');
if (!command) {
  console.error('사용법: node scripts/emulators-exec.mjs "<명령>"');
  process.exit(1);
}
const env = { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: process.env.FUNCTIONS_DISCOVERY_TIMEOUT || '120' };
const child = spawn('firebase', ['emulators:exec', '--project', 'demo-dk-brain-arena', JSON.stringify(command)], { stdio: 'inherit', shell: true, env });
child.on('exit', (code) => process.exit(code ?? 1));
