// 온라인 연결부: Firebase(Functions 판정 + Firestore 구독). 게임 모듈은 이 파일을 알지 못한다.
// 서버가 판정한 결과(공개 문서·개인 문서)만 받아서 화면에 전달한다.
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
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
  signIn: (auth, email, password) => signInWithEmailAndPassword(auth, email, password),
  signUp: (auth, email, password) => createUserWithEmailAndPassword(auth, email, password),
  signOut: (auth) => signOut(auth),
};

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** callable 오류를 사용자 메시지로 변환 */
export function describeError(err) {
  if (!err) return '알 수 없는 오류';
  if (err.code === 'functions/unavailable' || (err.code === 'functions/internal' && /fetch|network/i.test(err.message))) {
    return '서버(Functions)에 연결하지 못했습니다. 에뮬레이터 실행 상태와 네트워크를 확인하세요.';
  }
  if (err.code === 'auth/network-request-failed') {
    return '인증 서버에 연결하지 못했습니다. 에뮬레이터 실행 상태를 확인하세요.';
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
  const emit = () => { if (!closed) listener({ ...state }); };
  const onError = (err) => {
    state.error = err.code === 'permission-denied' ? '이 방을 볼 권한이 없습니다.' : (err.message || '구독 오류');
    state.connection = 'error';
    emit();
  };
  unsubs.push(onSnapshot(doc(db, 'rooms', roomId), { includeMetadataChanges: true }, (snap) => {
    state.connection = snap.metadata.fromCache ? 'reconnecting' : 'online';
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
  const onOnline = () => { state.connection = 'reconnecting'; emit(); };
  const onOffline = () => { state.connection = 'offline'; emit(); };
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
        return { ok: false, error: { code: err.code, message: describeError(err) } };
      }
    },
  };
}
