// 에뮬레이터 전용: 진행자 승인 목록(hostAccounts/{이메일})에 계정을 추가한다.
// Firestore 에뮬레이터의 관리자 우회 헤더(Bearer owner)를 사용하므로 운영 프로젝트에는 쓸 수 없다.
// 사용: npm run emulator:approve-host -- someone@example.test   (에뮬레이터 실행 중일 때)
// 운영 프로젝트의 승인 목록은 관리자가 Firebase 콘솔 → Firestore → hostAccounts 에서 관리한다.
import { pathToFileURL } from 'node:url';

const PROJECT = 'demo-dk-brain-arena';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

export async function approveHostInEmulator(email, { enabled = true, note = '에뮬레이터 테스트' } = {}) {
  if (!PROJECT.startsWith('demo-')) throw new Error('에뮬레이터 전용 스크립트입니다.');
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(HOST)) throw new Error(`에뮬레이터 주소가 아닙니다: ${HOST}`);
  const id = String(email).trim().toLowerCase();
  if (!id.includes('@') || id.includes('/')) throw new Error(`이메일 형식이 아닙니다: ${email}`);
  const url = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/hostAccounts/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { enabled: { booleanValue: enabled }, note: { stringValue: note } } }),
  });
  if (!res.ok) throw new Error(`승인 목록 쓰기 실패 (${res.status}): ${await res.text()}`);
  return id;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.argv[2];
  if (!email) {
    console.error('사용법: npm run emulator:approve-host -- <이메일>');
    process.exit(1);
  }
  approveHostInEmulator(email)
    .then((id) => console.log(`에뮬레이터 승인 목록에 추가: hostAccounts/${id}`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
