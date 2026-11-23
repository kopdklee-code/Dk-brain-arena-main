// 에뮬레이터 테스트 공용 도우미 (게임별 테스트에서 사용). 에뮬레이터 주소·demo- 프로젝트에서만 동작한다.
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { approveHostInEmulator } from '../../scripts/emulator-approve-host.mjs';

export const PROJECT = 'demo-dk-brain-arena';
const REGION = 'asia-northeast3';
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const apps = [];

/** kind: 'host'(승인된 이메일 테스트 계정) | 'player'(익명) | 'signed-out' */
export async function client(kind) {
  const app = initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT, appId: '1:0:web:test' }, `${kind}-${randomUUID()}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  if (kind === 'host') {
    const email = `host-${randomUUID().slice(0, 8)}@example.test`;
    await approveHostInEmulator(email);
    await createUserWithEmailAndPassword(auth, email, `test-${randomUUID()}`);
  } else if (kind === 'player') {
    await signInAnonymously(auth);
  }
  const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;
  return { app, auth, db, uid: auth.currentUser?.uid, call };
}

export async function closeAll() {
  await Promise.all(apps.splice(0).map((a) => deleteApp(a).catch(() => {})));
}

export const rid = () => randomUUID().replace(/-/g, '');

// ── 검증 전용: 서버 전용 문서를 에뮬레이터 관리자 권한(Bearer owner)으로 읽기 ──
function decode(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  throw new Error(`알 수 없는 값 형식: ${JSON.stringify(v)}`);
}
export async function readAsOwner(docPath) {
  if (!PROJECT.startsWith('demo-') || !/^(127\.0\.0\.1|localhost):\d+$/.test(FIRESTORE)) throw new Error('에뮬레이터 전용');
  const res = await fetch(`http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`, { headers: { Authorization: 'Bearer owner' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`읽기 실패 ${res.status}`);
  const body = await res.json();
  return Object.fromEntries(Object.entries(body.fields || {}).map(([k, x]) => [k, decode(x)]));
}

/** 서버 전용 컬렉션의 문서 목록 (에뮬레이터 관리자 권한) → { 문서ID: 필드 } */
export async function listAsOwner(collectionPath) {
  if (!PROJECT.startsWith('demo-') || !/^(127\.0\.0\.1|localhost):\d+$/.test(FIRESTORE)) throw new Error('에뮬레이터 전용');
  const res = await fetch(`http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${collectionPath}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
  if (!res.ok) throw new Error(`목록 실패 ${res.status}`);
  const body = await res.json();
  return Object.fromEntries((body.documents || []).map((d) => [d.name.split('/').pop(), Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, decode(x)]))]));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Functions 에뮬레이터 준비: 에뮬레이터는 동시 요청 수만큼 함수별 작업 프로세스를 새로 띄우며(로딩 제한 30초),
 * 수십 개를 한꺼번에 띄우면 로딩 시간 초과가 난다. 동시 호출 수를 단계적으로 늘려 프로세스를 미리 만들어 둔다.
 * (운영 Cloud Functions 2세대는 인스턴스당 동시 요청을 처리하므로 이 준비가 필요 없다. 판정·데이터와 무관한 잘못된 입력으로 호출)
 */
export async function warmUpFunctions(clients, calls, waves = [3, 6, 10, 15, 22, 29]) {
  const started = Date.now();
  for (const size of waves) {
    const group = clients.slice(0, Math.min(size, clients.length));
    for (const [name, data] of calls) await Promise.allSettled(group.map((c) => c.call(name, data)));
  }
  return Date.now() - started;
}

/**
 * 동시 처리 상한 (에뮬레이터 자원 한계 대응). 요청은 모두 동시에 발생시키되, 같은 PC의 Functions 에뮬레이터가
 * 함수별 작업 프로세스를 상한 수까지만 띄우도록 진행 중 요청 수를 제한한다.
 */
export function limitCalls(clients, max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  for (const c of clients) {
    const raw = c.call;
    c.call = (name, data) => new Promise((resolve, reject) => { queue.push({ fn: () => raw(name, data), resolve, reject }); next(); });
  }
  return { max };
}
