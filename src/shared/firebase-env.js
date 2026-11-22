// Firebase 연결 대상 결정. 로컬 주소에서는 항상 에뮬레이터만 사용하고, 실패해도 실서비스로 넘어가지 않는다.
export const FUNCTIONS_REGION = 'asia-northeast3';
export const EMULATOR_PROJECT_ID = 'demo-dk-brain-arena';
export const EMULATOR_HOST = '127.0.0.1';
export const EMULATOR_PORTS = Object.freeze({ auth: 9099, firestore: 8080, functions: 5001, hosting: 5000 });

// 운영 배포 전에 실제 Firebase 웹 앱 설정으로 채운다. 비어 있으면 운영 모드는 동작하지 않는다.
export const PRODUCTION_CONFIG = null;

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
