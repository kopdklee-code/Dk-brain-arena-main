// 연결 대상 결정 테스트: 운영 설정이 있어도 로컬 주소는 항상 에뮬레이터, 배포 주소만 운영 프로젝트
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveFirebaseMode, PRODUCTION_CONFIG, EMULATOR_PROJECT_ID } from '../src/shared/firebase-env.js';

test('로컬 주소는 운영 설정이 있어도 에뮬레이터', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'app.localhost']) {
    assert.equal(resolveFirebaseMode(host), 'emulator', host);
  }
});

test('Firebase Hosting 주소는 운영 프로젝트 dk-brain-arena', () => {
  assert.equal(PRODUCTION_CONFIG.projectId, 'dk-brain-arena');
  assert.equal(PRODUCTION_CONFIG.messagingSenderId, '565207270396');
  for (const host of ['dk-brain-arena.web.app', 'dk-brain-arena.firebaseapp.com']) {
    assert.equal(resolveFirebaseMode(host), 'production', host);
  }
});

test('에뮬레이터 프로젝트와 운영 프로젝트가 분리됨 (.firebaserc 기본값은 demo-)', async () => {
  const rc = JSON.parse(await readFile(new URL('../.firebaserc', import.meta.url), 'utf8'));
  assert.equal(rc.projects.default, EMULATOR_PROJECT_ID);
  assert.ok(rc.projects.default.startsWith('demo-'), '기본 프로젝트는 에뮬레이터 전용 demo- ID');
  assert.equal(rc.projects.prod, PRODUCTION_CONFIG.projectId);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (cmd.includes('firebase emulators')) assert.ok(cmd.includes(`--project ${EMULATOR_PROJECT_ID}`), `${name} 는 demo 프로젝트를 명시해야 함`);
    assert.ok(!/firebase deploy/.test(cmd), `${name}: npm 스크립트에 배포 명령 금지`);
  }
});
