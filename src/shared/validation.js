// 서버·클라이언트 공용 입력 형식 검증 (권한 검증은 서버가 별도로 수행한다).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const NICKNAME_MAX = 12;

export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function normalizeNickname(input) {
  if (typeof input !== 'string') return null;
  // 제어문자 제거, 공백 정리
  const name = input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > NICKNAME_MAX) return null;
  return name;
}

export function isValidRequestId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/** 게임 행동은 허용된 원시 필드만 남긴다. */
export function sanitizeAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  if (typeof action.type !== 'string' || action.type.length > 40) return null;
  const out = { type: action.type };
  for (const key of ['round', 'value']) {
    if (key in action) {
      if (typeof action[key] !== 'number' || !Number.isFinite(action[key])) return null;
      out[key] = action[key];
    }
  }
  return out;
}
