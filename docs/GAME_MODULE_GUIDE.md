# 게임 모듈 추가 가이드

새 게임은 `src/games/<gameId>/`에 독립 모듈로 만들고, 코드 등록 목록에 한 줄씩 추가합니다. 같은 원본에서 플랫폼판(온라인)과 판매용 파일이 생성되므로 **규칙·화면을 복사해 따로 고치지 않습니다.**

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
  "defaultConfig": {}
}
```
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

- DOM, Firebase SDK, 네트워크, `localStorage`, `Date.now()`, `Math.random()`을 직접 쓰지 않습니다. 시간·난수가 필요하면 `createGame`/`executeAction` 입력으로 받습니다(서버·로컬 연결부가 제공).
- 입력 `state`를 변경하지 않고 새 상태를 돌려줍니다.
- 거부는 예외가 아니라 `{ ok:false, error:{ code, message } }`로 돌려줍니다 (메시지는 한국어).
- 행동에는 현재 단계 식별값(예: `round`)을 넣어 지난 요청·반복 요청이 다시 반영되지 않게 합니다.
- 행동 필드는 서버에서 `type`, `round`, `value`(숫자)만 통과합니다(`src/shared/validation.js`의 `sanitizeAction`). 다른 필드가 필요하면 그 함수를 확장하고 테스트를 추가합니다.
- `getView(state, viewer)`는 viewer별로 **허용된 정보만** 만듭니다. 비밀 정보는 `public` 뷰에 넣지 않습니다(공개 문서에 넣고 CSS로 가리는 방식 금지). 개인 정보는 `player` 뷰에만 넣으면 서버가 `private/{uid}` 문서로 분리 저장합니다.
- 플랫폼 방 상태(lobby/playing/finished)는 플랫폼이 관리합니다. `getResult().finished`가 `true`가 되면 방이 종료됩니다.

## 5. view.js 계약
```js
export function mount(root, { role, send }) {
  // role: 'host' | 'player' | 'display' | 'local'
  // send(action, { playerId }) → Promise<{ ok, error? }>   (display 에서는 없음)
  return { update({ view, result }) {}, destroy() {} };
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
- `tests/`에 규칙 단위 테스트 추가 (점수, 거부 코드, 종료·동점, 입력 불변).
- 온라인·로컬 판정 비교용 행동 순서를 `tests/fixtures/`에 추가하고 `tests/emulator.test.mjs`에서 비교합니다.
- `npm run verify`가 통과해야 등록을 완료한 것으로 봅니다. 실행하지 못한 항목은 `docs/VERIFICATION.md`에 미검증으로 기록합니다.

## 8. 금지
- 생성물(`functions/generated/`, `dist/`) 직접 수정
- 임의 JavaScript 업로드 실행, 범용 플러그인 마켓
- 판매 패키지에 다른 게임·운영 비밀키·구매자 데이터·플랫폼 관리 기능 포함 (빌드가 일부 검사)
- 판매 패키지를 Hosting 공개 디렉터리에 배포
