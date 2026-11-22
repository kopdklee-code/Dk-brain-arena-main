// Firebase 연결 대상 결정. 로컬 주소에서는 항상 에뮬레이터만 사용하고, 실패해도 실서비스로 넘어가지 않는다.
export const FUNCTIONS_REGION = 'asia-northeast3';
export const EMULATOR_PROJECT_ID = 'demo-dk-brain-arena';
export const EMULATOR_HOST = '127.0.0.1';
export const EMULATOR_PORTS = Object.freeze({ auth: 9099, firestore: 8080, functions: 5001, hosting: 5000 });

// 운영 Firebase 프로젝트 dk-brain-arena (프로젝트 번호 565207270396) 의 웹 앱 "Dk brain arena" 설정.
// 웹 앱 설정은 브라우저에 공개되는 식별 정보이며 비밀키가 아니다. 접근 통제는 보안 규칙·Functions 검증이 담당한다.
// 로컬 주소(127.0.0.1, localhost)에서는 이 설정을 쓰지 않고 항상 에뮬레이터에 연결한다.
export const PRODUCTION_CONFIG = Object.freeze({
  apiKey: "AIzaSyAzD4CdIyIbadnohyYqzer52zPR9rVJbko",
  authDomain: "dk-brain-arena.firebaseapp.com",
  projectId: "dk-brain-arena",
  storageBucket: "dk-brain-arena.firebasestorage.app",
  messagingSenderId: "565207270396",
  appId: "1:565207270396:web:be7dcdbb220423ec38a879",
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function resolveFirebaseMode(hostname) {
  if (LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost')) return 'emulator';
  if (PRODUCTION_CONFIG && PRODUCTION_CONFIG.projectId) return 'production';
  return 'unconfigured';
}

export function emulatorAppConfig() {
  return {
    apiKey: 'demo-api-key',
    projectId: EMULATOR_PROJECT_ID,
    authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
    appId: '1:000000000000:web:demo',
  };
}
