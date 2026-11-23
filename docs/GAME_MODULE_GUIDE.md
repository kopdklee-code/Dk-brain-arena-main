# 게임 모듈 추가 가이드

새 게임은 `src/games/<gameId>/`에 독립 모듈로 만들고, 코드 등록 목록에 한 줄씩 추가합니다.

## 0. 책임 경계 (요약)
| 플랫폼 공통 (게임별 분기 금지) | 게임 모듈 (`src/games/<gameId>/`) |
|---|---|
| 게임 등록·목록, 진행자 Google 로그인·승인, 참가자 익명 세션, 방 생성·입장·재접속·종료, 참가 QR·시작 전 점검, 실시간 구독·연결 상태 안내, 서버 시각 보정, 요청 멱등·트랜잭션·경합 재시도, 보안 규칙, 공통 UI | 규칙·판정·라운드 동작·입력 검증, 화면(진행자·참가자·공개), 결과 데이터 모양, 게임 전용 스타일, 게임별 테스트(`tests/games/<gameId>/`) |

- 게임은 다른 게임의 파일을 import 하지 않습니다. 게임 폴더 안의 파일은 `shared`·`platform`·`adapters`도 import 하지 않습니다 (계약으로만 연결).
- 서버 판정은 공통 함수(`functions/src/index.js`)가 **방에 고정된 gameId의 규칙만** 실행합니다. 게임 상태는 방마다 `rooms/{roomId}/server/*`에 있어 다른 게임·다른 방의 데이터에 닿지 않습니다.
- 플랫폼(공통) 코드를 바꾸면 `npm run verify`로 **모든 등록 게임의 회귀 테스트**를 실행합니다.

### 새 게임 추가 시 바꾸는 파일 (이것뿐)
| 파일 | 할 일 |
|---|---|
| `src/games/<gameId>/*` | 새로 만듦 (manifest·rules·view·game.css·assets·README) |
| `src/games/registry.js` | manifest·rules import 2줄 + `GAMES` 항목 1줄 |
| `src/games/views.js` | view import 1줄 + `VIEWS` 항목 1줄 |
| `tests/games/<gameId>/*` | 새로 만듦 (규칙 단위·에뮬레이터·필요 시 브라우저) |
| `package.json` | 테스트 명령 추가, `verify`에 연결 |
공통 화면·서버·보안 규칙은 바꾸지 않습니다. 공통 기능이 부족하면 **게임과 무관한 선택 계약**으로 확장하고(예: 아래 `playerInput`) 문서와 모든 게임 회귀 테스트를 함께 갱신합니다. 같은 원본에서 플랫폼판(온라인)과 판매용 파일이 생성되므로 **규칙·화면을 복사해 따로 고치지 않습니다.**

## 1. 디렉터리 구성
```
src/games/<gameId>/
  manifest.json   게임 정보
  rules.js        규칙 (순수 함수)
  view.js         화면 (DOM만)
  game.css        .g-<약어> 범위 안의 전용 스타일
  assets/         자료 (icon.svg 권장 — 목록·오프라인 헤더에 사용)
  README.md       운영·실행 안내 (규칙, 행동 표, 진행 방법)
  LICENSE.txt     판매용(isDemo:false) 오프라인 패키지를 만들 때 필수 — 확정된 조건만
```
디렉터리 이름은 `gameId`와 같아야 합니다 (빌드가 검사).

## 2. manifest.json
```json
{
  "gameId": "example-game",
  "title": "표시 이름",
  "description": "설명",
  "gameVersion": "1.0.0",
  "players": { "min": 2, "max": 8 },
  "screens": ["host", "player", "display", "local"],
  "distributions": ["platform", "offline-standalone"],
  "isDemo": false,
  "listed": true,
  "defaultConfig": {}
}
```
- 등록 정보 대응: gameId·게임명(`title`)·설명·최소/최대 인원(`players`)·지원 화면(`screens`)·지원 배포/플레이 방식(`distributions`)·공개 여부(`listed`, 생략 시 공개 — `false`면 홈 목록에서 숨김, 진행자 화면에서는 선택 가능)·상태와 서버 기능 연결(`rules.js` 계약, 아래 4절).
- 화면 경로는 플랫폼 공통입니다 (게임별 경로를 만들지 않음): 진행자 `host.html?game=<gameId>` → 방 생성 후 `host.html?room=<roomId>`, 참가자 `play.html?code=<입장 코드>`(QR), 공개 화면 `display.html?room=<roomId>`, 상세 `game.html?id=<gameId>`. 방에 기록된 gameId로 해당 게임 화면을 붙입니다.
- `gameVersion`: 규칙이 바뀌면 반드시 올립니다. 방은 생성 시 gameId·gameVersion·설정을 고정하며, 서버 규칙 버전과 다르면 진행 중인 방의 행동을 거부합니다(새 규칙을 섞지 않음).
- `players.min/max`: 방 정원·시작 조건으로 사용됩니다. 플랫폼 전체 제한이 아닙니다.
- `isDemo: true`인 게임은 화면·패키지에 "개발 검증용"으로 표시되며 판매 게임으로 소개하지 않습니다.

## 3. 배포 방식 선언 규칙 (`distributions`)
| 값 | 의미 | 빌드 결과 | 필요 조건 |
|---|---|---|---|
| `platform` | DK BRAIN ARENA 온라인 플랫폼에서 진행 | `dist/hosting/games/<id>/`(CSS·자료) + 플랫폼 번들 + Functions 규칙 번들 | `screens`에 host·player 포함 |
| `offline-standalone` | 한 PC에서 인터넷 없이 실행하는 단일 HTML | `dist/packages/<id>/standalone.html` + ZIP | `local` 화면 지원, 비데모는 `LICENSE.txt` |
| `buyer-firebase` | 구매자 Firebase 프로젝트에 설치 | **후속 단계(미구현)** | 해당 게임 Hosting 파일 + Functions + 보안 규칙 + 설정 + 설치 안내 전체 포함 필요 |

지원하지 않는 방식은 선언하지 않습니다. 알 수 없는 값은 `assertGameModule`이 거부합니다.

## 4. rules.js 계약
반드시 내보낼 함수: `normalizeConfig`, `createGame`, `executeAction`, `getView`, `getResult`.

- 서버 시각: `createGame({ players, config, now })`, `executeAction(state, actor, action, { now, inputs })`. `now`는 서버(로컬판은 로컬 연결부)가 넘기는 ms 시각입니다. 마감 같은 시간 판정은 이 값으로만 합니다.
- **선택 계약 `playerInput` (동시 제출이 많은 게임)**: 참가자 개인 입력을 참가자마다 서버 전용 문서(`server/state/inputs/{playerId}`)에 저장해, 여러 명이 동시에 내도 같은 문서를 두고 경합하지 않게 합니다.
  ```js
  export const playerInput = {
    actions: ['submit'],                       // 개인 입력으로 처리할 행동
    key: (state) => 'r1a1' | null,             // 현재 입력 창 (화면 제출 인원 집계용)
    execute(state, input, actor, action, { now }) → { ok:true, input, newInWindow } | { ok:false, error },
  };
  ```
  공유 상태는 읽기만 합니다. 그 밖의 행동은 `ctx.inputs`(모든 참가자 입력)를 받아 처리합니다(예: 마감 때 집계). `getView(state, { role:'player', playerId, input })`로 본인 입력만 전달됩니다. 진행 중 제출 인원은 방 문서 `inputCounts[key]`로 화면에 전달됩니다(표시용, 판정과 무관).
- DOM, Firebase SDK, 네트워크, `localStorage`, `Date.now()`, `Math.random()`을 직접 쓰지 않습니다. 시간·난수가 필요하면 `createGame`/`executeAction` 입력으로 받습니다(서버·로컬 연결부가 제공).
- 입력 `state`를 변경하지 않고 새 상태를 돌려줍니다.
- 거부는 예외가 아니라 `{ ok:false, error:{ code, message } }`로 돌려줍니다 (메시지는 한국어).
- 행동에는 현재 단계 식별값(예: `round`)을 넣어 지난 요청·반복 요청이 다시 반영되지 않게 합니다.
- 행동 필드는 서버에서 `type`, `round`, `value`(숫자)만 통과합니다(`src/shared/validation.js`의 `sanitizeAction`). 다른 필드가 필요하면 그 함수를 확장하고 테스트를 추가합니다.
- `getView(state, viewer)`는 viewer별로 **허용된 정보만** 만듭니다. 비밀 정보는 `public` 뷰에 넣지 않습니다(공개 문서에 넣고 CSS로 가리는 방식 금지). 개인 정보는 `player` 뷰에만 넣으면 서버가 `private/{uid}` 문서로 분리 저장합니다.
- 플랫폼 방 상태(lobby/playing/finished)는 플랫폼이 관리합니다. `getResult().finished`가 `true`가 되면 방이 종료됩니다.

## 5. view.js 계약
```js
export function mount(root, { role, send, now }) {
  // role: 'host' | 'player' | 'display' | 'local'
  // send(action, { playerId }) → Promise<{ ok, error? }>   (display 에서는 없음)
  // now() → 서버 기준 추정 시각(ms) — 타이머 표시용 (판정은 서버)
  return { update({ view, result, publicView, inputCounts }) {}, destroy() {} };
}
```
- `<button>` 등 키보드로 조작 가능한 요소를 사용하고, 상태를 색만으로 구분하지 않습니다(텍스트·기호 병기).
- 요청 중(제출 중)·실패 메시지를 화면에 표시합니다.
- 공통 CSS 변수(`--dk-*`)를 기본값과 함께 사용하면 플랫폼·오프라인 양쪽에서 같은 모양이 됩니다.

## 6. 등록
1. `src/games/registry.js`에 manifest·rules import 와 `GAMES` 항목 추가
2. `src/games/views.js`에 view import 와 `VIEWS` 항목 추가
3. `npm run build` → Functions 번들·Hosting·패키지가 함께 생성됩니다.

## 7. 테스트
- 위치: `tests/games/<gameId>/` (기존 샘플 테스트는 이동하지 않고 `tests/` 바로 아래에 둠). 에뮬레이터 공용 도우미 `tests/helpers/emulator-clients.mjs`.
- 다수 동시 접속 테스트는 `node scripts/emulators-exec.mjs "<명령>"`으로 실행합니다(에뮬레이터 작업 프로세스 로딩 제한 연장).
- 규칙 단위 테스트 추가 (점수, 거부 코드, 종료·동점, 입력 불변).
- 온라인·로컬 판정 비교용 행동 순서를 `tests/fixtures/`에 추가하고 `tests/emulator.test.mjs`에서 비교합니다.
- `npm run verify`가 통과해야 등록을 완료한 것으로 봅니다. 실행하지 못한 항목은 `docs/VERIFICATION.md`에 미검증으로 기록합니다.

## 8. 금지
- 생성물(`functions/generated/`, `dist/`) 직접 수정
- 임의 JavaScript 업로드 실행, 범용 플러그인 마켓
- 판매 패키지에 다른 게임·운영 비밀키·구매자 데이터·플랫폼 관리 기능 포함 (빌드가 일부 검사)
- 판매 패키지를 Hosting 공개 디렉터리에 배포
