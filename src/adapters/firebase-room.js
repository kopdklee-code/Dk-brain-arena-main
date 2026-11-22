// 온라인 연결부: Firebase(Functions 판정 + Firestore 구독). 게임 모듈은 이 파일을 알지 못한다.
// 서버가 판정한 결과(공개 문서·개인 문서)만 받아서 화면에 전달한다.
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, signInWithPopup, GoogleAuthProvider,
} from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import {
  FUNCTIONS_REGION, EMULATOR_HOST, EMULATOR_PORTS, PRODUCTION_CONFIG, emulatorAppConfig, resolveFirebaseMode,
} from '../shared/firebase-env.js';

let services = null;

/**
 * appName 을 화면별로 다르게 주면 인증 상태 저장 키가 분리된다.
 * (같은 브라우저에서 진행자 탭과 참가자 탭이 서로의 로그인을 덮어쓰지 않게 함)
 */
export function initFirebase(hostname, appName = 'dkba') {
  if (services) return services;
  const mode = resolveFirebaseMode(hostname);
  if (mode === 'unconfigured') {
    throw new Error('Firebase 운영 설정이 없습니다. 로컬에서는 127.0.0.1 또는 localhost 주소에서 에뮬레이터를 사용하세요.');
  }
  const app = initializeApp(mode === 'emulator' ? emulatorAppConfig() : PRODUCTION_CONFIG, appName);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  if (mode === 'emulator') {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
    connectFunctionsEmulator(functions, EMULATOR_HOST, EMULATOR_PORTS.functions);
  }
  services = { mode, app, auth, db, functions };
  return services;
}

export function waitForUser(auth) {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (user) => { off(); resolve(user); });
  });
}

export async function ensureAnonymousUser(auth) {
  const user = (await waitForUser(auth)) || auth.currentUser;
  if (user) return user;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

export const hostAuth = {
  /** 진행자 로그인 (운영·에뮬레이터 공통). 진행자 권한은 서버가 승인 목록으로 판정한다. */
  signInWithGoogle: (auth) => signInWithPopup(auth, new GoogleAuthProvider()),
  /** 에뮬레이터 자동 검증 전용 (운영 화면에는 표시하지 않음) */
  signIn: (auth, email, password) => signInWithEmailAndPassword(auth, email, password),
  signUp: (auth, email, password) => createUserWithEmailAndPassword(auth, email, password),
  signOut: (auth) => signOut(auth),
};

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// 서버 응답을 받지 못한 경우(통신 끊김·응답 유실·서버 미배포·서버 내부 오류). 요청이 처리됐는지 알 수 없으므로
// 성공·실패를 단정하지 않는다. 게임 행동은 서버 기준 상태(Firestore 구독)를 확인하도록 안내한다.
const NO_RESPONSE_CODES = ['functions/unavailable', 'functions/internal', 'functions/deadline-exceeded', 'functions/not-found'];
export const NO_RESPONSE_MESSAGE = '서버(Functions) 응답을 받지 못했습니다. 네트워크 상태를 확인하고 잠시 후 다시 시도하세요. 계속되면 서버가 배포되지 않았거나 점검 중일 수 있습니다.';
export const GAME_NO_RESPONSE_MESSAGE = '서버 응답을 받지 못했습니다. 접수되지 않았을 수 있습니다. 연결이 복구되면 화면의 제출 상태(서버 기준)를 확인하고 필요하면 다시 선택하세요.';

/** callable 오류를 사용자 메시지로 변환. context 'game' 은 게임 행동(제출·마감)용 안내 */
export function describeError(err, context = 'general') {
  if (!err) return '알 수 없는 오류';
  if (NO_RESPONSE_CODES.includes(err.code)) {
    return context === 'game' ? GAME_NO_RESPONSE_MESSAGE : NO_RESPONSE_MESSAGE;
  }
  if (err.code === 'auth/network-request-failed') {
    return '인증 서버에 연결하지 못했습니다. 네트워크(로컬에서는 에뮬레이터 실행 상태)를 확인하세요.';
  }
  return err.message || String(err);
}

export function createRoomApi({ functions }) {
  const call = (name) => httpsCallable(functions, name);
  return {
    createRoom: async (gameId, config) => (await call('createRoom')({ gameId, config })).data,
    joinRoom: async (code, nickname) => (await call('joinRoom')({ code, nickname })).data,
    startGame: async (roomId, requestId = newRequestId()) => (await call('startGame')({ roomId, requestId })).data,
    /** 같은 requestId 로 재시도하면 서버는 저장된 결과를 돌려주고 점수를 다시 반영하지 않는다. */
    sendAction: async (roomId, action, requestId = newRequestId()) =>
      (await call('gameAction')({ roomId, requestId, action })).data,
  };
}

/**
 * 방 구독. role: 'host' | 'player' | 'display'.
 * listener({ room, players, privateDoc, connection, error })
 * 반환된 함수를 호출하면 모든 실시간 구독을 해제한다.
 */
export function watchRoom({ db }, { roomId, uid, role }, listener) {
  const state = { room: null, players: [], privateDoc: null, connection: 'connecting', error: null };
  const unsubs = [];
  let closed = false;
  let synced = false; // 마지막 공개 문서 스냅샷이 서버와 동기화된 상태인가 (fromCache === false)
  let failed = false;
  const browserOffline = () => globalThis.navigator?.onLine === false;
  // 연결 상태: 브라우저 오프라인 신호 → 'offline', 서버 동기화 전 → 'connecting'/'reconnecting', 동기화됨 → 'online'.
  // (이 값은 안내용이며, 제출 성공 여부는 서버 응답과 서버 기준 문서로만 판단한다.)
  const refreshConnection = () => {
    if (failed) state.connection = 'error';
    else if (browserOffline()) state.connection = 'offline';
    else if (synced) state.connection = 'online';
    else state.connection = state.room ? 'reconnecting' : 'connecting';
  };
  const emit = () => { if (!closed) { refreshConnection(); listener({ ...state }); } };
  const onError = (err) => {
    state.error = err.code === 'permission-denied' ? '이 방을 볼 권한이 없습니다.' : (err.message || '구독 오류');
    failed = true;
    emit();
  };
  unsubs.push(onSnapshot(doc(db, 'rooms', roomId), { includeMetadataChanges: true }, (snap) => {
    synced = !snap.metadata.fromCache;
    state.room = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    state.error = !snap.exists() && !snap.metadata.fromCache ? '방을 찾을 수 없습니다.' : null;
    emit();
  }, onError));
  unsubs.push(onSnapshot(query(collection(db, 'rooms', roomId, 'players'), orderBy('playerId')), (snap) => {
    state.players = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    emit();
  }, onError));
  if ((role === 'player' || role === 'host') && uid) {
    unsubs.push(onSnapshot(doc(db, 'rooms', roomId, 'private', uid), (snap) => {
      state.privateDoc = snap.exists() ? snap.data() : null;
      emit();
    }, onError));
  }
  // 브라우저 온라인 신호는 안내 갱신에만 사용 (온라인이 되어도 서버 동기화 전까지는 '재연결 중')
  const onOnline = () => emit();
  const onOffline = () => emit();
  globalThis.addEventListener?.('online', onOnline);
  globalThis.addEventListener?.('offline', onOffline);
  return () => {
    closed = true;
    unsubs.splice(0).forEach((u) => u());
    globalThis.removeEventListener?.('online', onOnline);
    globalThis.removeEventListener?.('offline', onOffline);
  };
}

/** 게임 화면에 넘길 세션 (로컬 연결부와 같은 send 계약). 판정은 서버가 한다. */
export function createOnlineSession(api, roomId) {
  return {
    async send(action) {
      try {
        const res = await api.sendAction(roomId, action);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: describeError(err, 'game') } };
      }
    },
  };
}
