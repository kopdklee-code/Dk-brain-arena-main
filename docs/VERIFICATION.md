# 검증 결과

실행 환경이 다른 두 검증 기록을 따로 남깁니다. 나중 기록이 앞에 옵니다.

| 기록 | 커밋 | Node | 범위 |
|---|---|---|---|
| [기록 3](#기록-3--운영-firebase-프로젝트-연결-node-22) | 운영 프로젝트 연결 커밋 | 22.23.5 | 운영 설정 추가 후 전체 `npm run verify` 재실행, 연결 대상 검사 |
| [기록 2](#기록-2--node-22-목표-런타임-커밋-bf57ce9) | `bf57ce9` | **22.23.5** (목표 런타임) | 전체 `npm run verify` + 연결 끊김·재연결 + 커밋 파일만으로 재빌드 |
| [기록 1](#기록-1--node-26-v01-기준선-커밋-ccae531) | `ccae531` (v0.1 기준선) | 26.13.1 | 1차 구현 전체 `npm run verify` |

로그와 스크린샷은 `tests/.artifacts/`에 있습니다(Git에는 포함하지 않음).

---

## 기록 3 — 운영 Firebase 프로젝트 연결 (Node 22)

- 실행일: 2026-11-22. 환경은 기록 2와 같습니다(Node 22.23.5). 로그: `tests/.artifacts/verify-prodconfig.log`
- 운영 프로젝트: `dk-brain-arena` (번호 565207270396), `.firebaserc` 별칭 `prod`

### 운영 프로젝트 조회 (Firebase CLI, 읽기 전용)
| 확인 | 결과 |
|---|---|
| CLI 로그인과 프로젝트 접근 | `projects:list`에서 `dk-brain-arena` / `565207270396` 확인. 기본 리소스 위치는 미지정 |
| 웹 앱 | 기존 웹 앱 `Dk brain arena` (`1:565207270396:web:be7dcdbb220423ec38a879`)의 SDK 설정을 `apps:sdkconfig`로 받아 `PRODUCTION_CONFIG`에 넣음. 새 앱은 만들지 않음 |
| Hosting 사이트 | `dk-brain-arena` → https://dk-brain-arena.web.app 존재 |
| Cloud Firestore | 처음 조회 때는 없음(403). 사용자가 콘솔에서 만든 뒤 다시 조회: `(default)` 데이터베이스, FIRESTORE_NATIVE, STANDARD 버전, 위치 `asia-northeast3`, 생성 2026-11-22 03:17 UTC (`firestore:databases:get`). 삭제 보호·PITR은 꺼져 있음. 현재 적용된 보안 규칙 내용과 `firestore.rules` 배포는 확인하지 않음 |
| Authentication 제공자, 요금제(Blaze) | CLI로 확인하지 않음(**미확인**). 콘솔에서 확인 필요 |

### 로컬 검증 (운영 설정 추가 후) — `npm run verify` 종료 코드 0
| 단계 | 결과 |
|---|---|
| 단위 테스트 (규칙 11 + 연결 대상 3) | 14/14 통과 |
| 연결 대상 검사 (`tests/firebase-env.test.mjs`) | 로컬 주소 5종은 운영 설정이 있어도 `emulator`, `dk-brain-arena.web.app`·`.firebaseapp.com`은 `production`. `.firebaserc` 기본값은 `demo-` 프로젝트, 에뮬레이터 스크립트는 모두 `--project demo-dk-brain-arena` 명시, npm 스크립트에 배포 명령 없음 |
| Functions 묶음, 산출물 분리, 오프라인 | 통과 |
| 에뮬레이터 통합 7/7, 브라우저 E2E, 연결 끊김·재연결 19/19 | 통과. Functions 에뮬레이터는 `Using node@22 from host.` |

### 기록 3의 미검증 (통과로 보지 않음)
- **운영 프로젝트에서는 아무것도 실행하지 않았습니다**: 배포, 운영 Auth·Firestore 접속, 운영 데이터 쓰기 모두 하지 않음. 운영 환경에서 실제로 동작하는지는 배포 후 확인해야 합니다.
- **로컬 E2E가 운영에 접속하지 않았다는 근거**: 다음 세 가지로 판단했습니다. ① 연결 대상 단위 테스트, ② 로컬 E2E가 `127.0.0.1`에서 실행됨, ③ 운영 프로젝트에 Auth 제공자와 Firestore가 아직 없는데도 E2E의 계정 생성과 방 진행이 성공함. 운영 Auth 사용자 목록은 실제 사용자 데이터라 직접 조회하지 않았습니다.
- **콘솔에서만 확인 가능한 항목**: Auth 제공자 사용 설정, Blaze 요금제, API 키 제한.

---

## 기록 2 — Node 22 (목표 런타임), 커밋 bf57ce9

- 실행일: 2026-11-22
- 환경: Windows 10 Home 10.0.19045, **Node 22.23.5 / npm 10.9.9**, Firebase CLI 15.36.0, Java 21.0.13(Temurin), Microsoft Edge 157(헤드리스, playwright-core 1.65.1)
- 로그: `tests/.artifacts/verify-node22.log`(전체), `tests/.artifacts/reconnect.log`, 스크린샷 `tests/.artifacts/reconnect-*.png`

### 목표 런타임 확인
| 확인 | 결과 |
|---|---|
| 선언 | `functions/package.json` `engines.node: "22"`, `firebase.json` `runtime: "nodejs22"`. 두 선언이 일치하므로 목표 런타임을 **Node 22**로 확정. 루트 `package.json`에는 engines가 없음(개발 도구용). `.nvmrc`에 `22`를 추가 |
| Node 22 준비 | 이 PC에는 Node 26만 있었고 nvm·fnm·volta도 없었음. 공식 `node-v22.23.5-win-x64.zip`을 SHA-256 체크섬(`4a191082…a0e3`)으로 확인한 뒤 프로젝트의 `.tools/`(Git 제외)에 풀고, 명령마다 PATH 앞에만 추가해 사용. 전역 설치와 시스템 PATH 변경은 하지 않음 |
| 의존성 설치 | Node 22의 `npm ci`로 기존 잠금 파일 그대로 설치. 잠금 파일 변경과 패키지 업그레이드 없음 |
| Firebase CLI 실행 Node | v22.23.5 (CLI 실행기는 PATH의 `node` 사용) |
| Functions 에뮬레이터 실제 런타임 | 로그 `functions: Using node@22 from host.` 확인. 실행 중 Functions 작업 프로세스(`firebase-tools/lib/emulator/…`)의 실행 파일이 `.tools\node-v22.23.5-win-x64\node.exe`임을 프로세스 목록으로 확인 |
| 호환성 문제 1건 발견·수정 | `firebase-admin` 14.5.1의 하위 의존성 `@firebase/database`·`@firebase/database-compat`은 `engines >=24.12.0`을 선언. `functions/src/index.js`가 `firebase-functions/v2` 묶음 모듈을 import하는 바람에 사용하지 않는 Realtime Database 제공자와 `@firebase/database-compat`까지 실제로 로드되고 있었음. `firebase-functions/v2/options` 하위 경로 import로 바꾼 뒤, 새 폴더 설치본에서 해당 모듈이 **로드되지 않음**을 확인(로드된 CommonJS 패키지 64개 중 0개). 이 검사는 `check:functions-bundle`에 추가함 |

### `npm run verify` (Node 22) — 종료 코드 0
| 단계 | 결과 |
|---|---|
| 빌드 (functions / hosting / packages) | 통과 |
| 규칙 단위 테스트 | 11/11 통과 |
| Functions 묶음 자립성 (새 폴더 `npm install --omit=dev` → import·판정, Node 22 범위 밖 모듈 미로드) | 통과 |
| Hosting / 판매 패키지 분리 | 통과 |
| 오프라인 실행형 (ZIP 해제 → file:// → 오프라인 3라운드·CSV·초기화, 외부 요청 0) | 통과 |
| 에뮬레이터 통합 테스트 (권한·중복·동시성·비공개 읽기·온라인=로컬 판정, 고정 순서 4종) | 7/7 통과 |
| 브라우저 E2E (진행자·참가자 2명·공개 화면, 진행자·참가자 새로고침, 늦은 입장 거부) | 통과 |
| 연결 끊김·재연결 E2E | 19/19 통과 (아래) |

### 연결 끊김·재연결 시나리오 (`tests/e2e-reconnect.mjs`)
조건: 진행자(이메일 계정)와 참가자 2명(서로 다른 익명 UID, 독립 브라우저 컨텍스트)이 참여. 참가자2의 통신을 Playwright `context.setOffline()`으로 차단했다가 복원함. 이 방식은 Chromium 네트워크 에뮬레이션으로, 물리적 차단은 아님.

| # | 확인 | 결과 | 관찰 내용 |
|---|---|---|---|
| A1 | 끊김 시 상태 안내 | 통과 | 라벨 "× 오프라인 — 연결 대기"와 본문 안내 "연결이 끊겼습니다…" |
| A2 | 4초 뒤에도 안내 유지 | 통과 | 수정 전에는 약 1.5초 뒤 Firestore 캐시 이벤트가 "↻ 재연결 중"으로 덮어썼음 |
| B1 | 오프라인 선택의 실패 안내 | 통과 | "서버 응답을 받지 못했습니다. 접수되지 않았을 수 있습니다…". 수정 전에는 "실패: internal"이었음 |
| B2 | 미접수 선택을 제출 완료로 표시하지 않음 (본인 화면) | 통과 | 본인 행이 "미제출"로 유지. 수정 전에도 올바르게 동작했음 |
| B3 | 서버(진행자 화면)에도 미제출 | 통과 | — |
| C1 | 복원 후 "연결됨" 표시, 끊김 안내 사라짐 | 통과 | — |
| C2 | 끊긴 동안 진행자가 마감한 뒤 현재 라운드(2) 복구 | 통과 | — |
| C3 | 자리 유지 (p2) | 통과 | — |
| C4 | 본인 제출 상태가 서버 기준으로 복구 (2라운드 미제출, 1라운드 0점) | 통과 | — |
| C5 | 이전 실패 안내 제거 | 통과 | 새 확정 상태를 받으면 실패 안내를 지우도록 수정함 |
| D1 | 서버는 접수했지만 응답 유실 (요청을 서버에 전달하고 응답만 차단) | 통과 | 서버 응답 `{"ok":true}` 확인 |
| D2 | 화면은 서버 기준 "제출 완료: 3"을 표시하고 실패로 단정하지 않음 | 통과 | 이번 실행에서는 서버 상태 반영이 먼저 오고 응답 실패 안내가 나중에 와서, "제출 완료: 3"과 "서버 기준 상태를 확인하라"는 안내가 함께 표시됨. 순서는 실행마다 달라질 수 있으며, 테스트는 두 경우 모두 서버 기준 제출 완료가 표시되는지 확인함 |
| D3 | 같은 라운드 재선택 불가 | 통과 | 버튼 비활성 |
| E1 | 새로고침(재접속) 후 자리·제출 상태 복구 | 통과 | — |
| E2 | 참가자 중복 등록 없음 | 통과 | 진행자 목록 2명, "2 / 2명 입장" |
| F | 최종 점수 = 로컬 판정 (중복 반영 없음), 진행자·참가자1·참가자2 화면 | 통과 | 1위 한결 6점, 2위 두빛 5점 (2라운드 p2의 3점은 1회만 반영) |

참가자 2명의 UID가 서로 다름도 확인했습니다. 제출 성공은 서버 응답과 서버 기준 문서(Firestore 개인·공개 문서)로만 표시합니다. 브라우저의 온라인·오프라인 신호는 안내 문구에만 사용합니다.

### 커밋 파일만으로 재생성
`git clone`으로 커밋 `bf57ce9`를 OS 임시 폴더에 복제했습니다. 이 시점에는 `dist/`와 `functions/generated/`가 없었습니다. Node 22에서 `npm ci`(루트, functions) → `node scripts/build.mjs all` → `test:rules`(11/11) → `check:functions-bundle` → `check:dist` 순서로 모두 통과했습니다. 생성된 `functions/generated/games.js`, `dist/packages/demo-number-choice/standalone.html`, `dist/hosting/js/play.page.js`는 작업 폴더 빌드와 **바이트 단위로 동일**했고, 복제본의 Git 상태에도 변경이 없었습니다. 저장소가 추적하는 생성물은 0개입니다.

### 기록 2의 미검증·제약 (통과로 보지 않음)
- **보완 점검으로 남긴 항목**: 탐색기 더블클릭 실행, 물리적 네트워크 차단, Chrome·Firefox·Safari, 실제 모바일 기기.
- **연결 끊김 범위**: 참가자 한 명이 수십 초 정도 끊긴 경우만 확인했습니다. 다음은 확인하지 않았습니다.
  - 진행자의 연결 끊김
  - 인증 토큰 만료(1시간)를 넘기는 장시간 끊김
  - 오프라인 상태에서의 새로고침
  - 공개 화면의 끊김 안내 (공개 화면은 상태 라벨만 있고 본문 안내는 추가하지 않음)
- **'↻ 재연결 중' 중간 상태**: 복원 직후 바로 "연결됨"이 되어, 이 중간 상태가 화면에 나타나는지는 자동으로 확인하지 않았습니다.
- **개발 도구의 engines 경고**: 루트 개발 의존성 `firebase` 웹 SDK 13.4.0(`@firebase/*`)은 `node >=24.12.0`을 선언합니다. 그래서 Node 22에서 `npm ci`를 하면 EBADENGINE 경고가 납니다. 이 SDK는 브라우저 번들과 Node 테스트 클라이언트에만 쓰이고 Functions 배포 묶음에는 들어가지 않습니다. Node 22에서 모든 테스트가 통과했지만, 공식 지원 범위 밖이라는 점은 남겨 둡니다. 패키지는 바꾸지 않았습니다.
- **운영 런타임**: Google Cloud의 실제 `nodejs22` Functions 런타임 배포는 범위 밖이라 실행하지 않았습니다.

---

## 기록 1 — Node 26, v0.1 기준선 (커밋 ccae531)

- 실행일: 2026-11-22
- 환경: Windows 10 Home 10.0.19045, Node 26.13.1, npm 11.20.0, Firebase CLI 15.36.0, Java 21.0.13(Temurin), Microsoft Edge 157(헤드리스, playwright-core 1.65.1로 구동)
- 에뮬레이터: Auth 9099, Firestore 8080, Functions 5001, Hosting 5000 (`firebase emulators:exec`, 프로젝트 `demo-dk-brain-arena`). Functions 에뮬레이터는 호스트의 Node 26으로 실행됨(목표 런타임 아님)
- 로그: `tests/.artifacts/verify.log`(전체 실행), `tests/.artifacts/e2e.log`(마지막 E2E 실행)
- 스크린샷: `tests/.artifacts/online-*.png`, `tests/.artifacts/offline-*.png`

모든 코드를 변경한 뒤 `npm run verify` 전체를 다시 실행해 종료 코드 0을 확인했습니다. 이후 E2E에 '진행자 새로고침 복구' 단계를 추가했고, 이 단계를 포함해 `npm run test:e2e`를 한 번 더 실행해 통과했습니다.

### 필수 확인 항목

| # | 항목 | 결과 | 방법·근거 |
|---|---|---|---|
| 1 | 서로 다른 인증 상태의 진행자 + 참가자 2명으로 방 생성 → 참가 → 3라운드 → 결과 | **통과** | 통합 테스트 `1)`: 진행자(이메일 계정)와 참가자 2명(각각 별도 익명 UID)으로 진행해 최종 순위 6점/3점을 확인. 브라우저 E2E: 독립 브라우저 컨텍스트 4개(진행자, 참가자 2명, 공개 화면)로 UI에서 3라운드를 진행하고, 네 화면 모두에서 같은 결과(하나 6점 1위, 두리 4점 2위)를 확인 |
| 2 | 참가자 새로고침·재접속 후 자리와 현재 상태 복구 | **통과** | E2E: 2라운드 중 참가자2 페이지를 새로고침한 뒤 '재접속되었습니다' 메시지, 자리 `p2`, 현재 라운드, 상대 제출 내역 복구를 확인. 진행자 페이지 새로고침 후 같은 방과 진행 상태 복구도 확인. 통합 테스트 `2)`: 시작 이후 같은 UID는 기존 자리와 닉네임을 되찾고, 새 UID는 `failed-precondition`으로 거부됨 |
| 3 | 중복 제출, 반복 마감, 지난 라운드 제출 | **통과** | 통합 테스트 `3)`. 같은 requestId를 재전송하면 `duplicate:true`가 반환되고 점수는 한 번만 반영됨. 새 requestId로 재제출하면 `already-submitted`. 서로 다른 requestId 3개로 **동시** 제출하면 1건만 성공. 마감 3건을 **동시** 요청(같은 requestId 2건 포함)해도 실제 반영은 1건. 지난 라운드의 마감·제출은 `stale-round`로 거부되고 점수 변동 없음. 다른 UID의 requestId를 재사용하면 `already-exists` |
| 4 | 다른 참가자 데이터 변경, 진행자 전용 명령 거부 | **통과** | 통합 테스트 `4)`. 익명 사용자의 방 생성, 참가자·다른 진행자의 시작 명령, 참가자의 마감(`not-host`), 진행자의 대리 제출(`not-player`), 외부인의 행동이 모두 거부됨. Firestore 직접 쓰기 10종(방 상태, 공개 뷰, 남의 참가자 문서, 자기 자리 변경, 개인 문서, 서버 상태, 방 삭제, 진행자의 직접 수정, 코드 문서, 방 위조)이 모두 `permission-denied` |
| 5 | 비공개·서버 전용 문서의 권한 없는 읽기 거부 | **통과** | 통합 테스트 `5)`. 본인 개인 문서만 읽기 가능. 남의 개인 문서, 진행자 개인 문서, private 컬렉션 조회, `server/state`(진행자 포함), `requests`, `codes`(단건·목록), 비로그인 사용자의 공개 문서 읽기가 모두 거부됨. 공개 문서에 `gameState`·`seats` 필드가 없음을 확인 |
| 6 | 동일 초기 상태·행동 순서에서 온라인 판정 = 로컬 판정 | **통과** | 통합 테스트 `6)`: 고정 순서 3종(미제출 포함, 동점, E2E 공용)에서 서버 결과(`rooms.result`)와 로컬 규칙 결과가 `deepEqual`로 일치. 단위 테스트에서 생성된 Functions 번들과 원본 규칙의 결과 일치도 확인. 온라인 E2E와 오프라인 standalone에서 같은 순서를 입력해 같은 결과(6점/4점)를 얻음 |
| 7 | standalone.html을 file:// + 네트워크 차단 조건에서 실행해 3라운드 완료 | **통과(조건 있음)** | `tests/offline-standalone.mjs`: ZIP을 OS 임시 폴더에 풀고(`Expand-Archive`) `file://`로 엶. 브라우저 컨텍스트를 `offline:true`로 두고(`navigator.onLine === false` 확인) file/data/blob 이외의 요청은 모두 차단·기록함. 3라운드 완료, 결과, CSV 내보내기, 진행 초기화를 확인했고 외부 요청은 0건, 페이지 오류도 0건. 조건은 아래 '미검증·제약' 참고 |
| 8 | 새 작업 디렉터리에서 Functions 묶음의 규칙 모듈 누락 없음 | **통과** | `tests/check-functions-bundle.mjs`: `firebase.json` ignore 규칙대로 `functions/`를 OS 임시 폴더에 복사함. 모든 상대 import가 묶음 안에서 해석되고 외부 패키지가 dependencies에 있음을 정적으로 확인. 새 폴더에서 `npm install --omit=dev`를 한 뒤 `generated/games.js`로 판정을 실행하고, `src/index.js`의 4개 함수 export를 확인. 에뮬레이터도 같은 `functions/` 묶음(`generated/` 포함)을 로드함 |
| 9 | Hosting 산출물과 판매 패키지 분리 | **통과** | `tests/check-dist.mjs`: `firebase.json`의 `hosting.public`이 `dist/hosting`임을 확인. Hosting 파일 17개에 ZIP, standalone, 안내문, 서버 코드, 패키지 경로 참조, 비밀키 흔적이 없음. 패키지는 해당 게임 파일만 포함하며, `standalone.html`에 외부 URL(SVG 네임스페이스 제외), Firebase, module 스크립트, 외부 링크가 없음 |

### 추가로 실행한 확인
| 항목 | 결과 |
|---|---|
| 규칙 단위 테스트 11건 (점수, 미제출 0점, 입력 불변, 권한·형식, 종료·동점 공동 순위, 역할별 view, 로컬 연결부 계약, 입력 정리) | 통과 |
| 대기실: 정원 초과, 진행자 본인 입장, 닉네임 중복, 없는 코드 거부 (통합 테스트 `2-1)`) | 통과 |
| 홈 목록에 구현된 샘플 1개만 표시되고 '개발 검증용' 배지가 있음 (E2E) | 통과 |
| 키보드 조작: 참가 폼·오프라인 시작 폼 Enter 제출, 게임 시작 버튼 포커스 + Enter (E2E·오프라인) | 통과 |
| 참가자 나가기 → 입장 화면 복귀 (E2E) | 통과 |
| E2E 브라우저 콘솔·HTTP 오류 | 의도된 거부(늦은 입장 `joinRoom` 400) 외 0건. 첫 실행에서 favicon 404가 발견되어 수정한 뒤 재확인 |
| 빌드 안전장치: 서버 번들에 view·Firebase 코드 유입 차단, 패키지에 다른 게임·플랫폼·Firebase 코드 유입 차단, 비데모 게임 패키지에 LICENSE.txt 필수 | 빌드 스크립트에 구현함. 위반 상황을 일부러 만들어 실패하는지는 **실행하지 않음** |

### 기록 1의 미검증·제약 (기록 당시 기준, 통과로 보지 않음)
- **실제 더블클릭 실행**: 헤드리스 Edge가 `file://` URL로 연 방식으로만 확인했습니다. 탐색기에서 더블클릭하는 동작이나 기본 브라우저 연결은 확인하지 않았습니다.
- **네트워크 차단 방식**: 브라우저의 오프라인 모드와 요청 차단으로 재현했습니다. PC의 네트워크를 물리적으로 끊은 상태에서는 실행하지 않았습니다.
- **브라우저 범위**: Edge 157만 확인했습니다. Chrome, Firefox, Safari와 실제 모바일 기기는 확인하지 않았습니다. 참가자 화면은 390×844 뷰포트로만 확인했습니다.
- **연결 상태 표시**: '재연결 중', '오프라인', '오류' 상태가 표시되는 화면은 자동 검증하지 않았습니다. 확인한 것은 '연결됨' 상태와 연결 실패 메시지 코드 경로뿐입니다. → 기록 2에서 "오프라인" 표시, 끊김 안내, 실패 안내를 확인함 (일부 미확인 항목은 기록 2 참고)
- **Functions 런타임 버전**: 배포 설정은 `nodejs22`이지만 에뮬레이터는 호스트의 Node 26으로 실행했습니다(CLI 경고: `Using node@26 from host`). Node 22 환경에서는 실행하지 않았습니다. → 기록 2에서 Node 22.23.5로 확인함
- **운영 환경**: 실제 Firebase 배포, 운영 Firestore 트랜잭션 경합, 콜드 스타트, 요금은 범위 밖이라 확인하지 않았습니다.
- **접근성**: 스크린리더 검증과 색 대비 측정은 하지 않았습니다. 상태 표시에는 텍스트와 기호를 함께 썼습니다.
- **오프라인 진행 저장**: 구현하지 않았습니다. 새로고침하면 처음부터 다시 시작합니다(QUICKSTART에 안내).
- `npm install` 과정에서 npm 11이 `protobufjs` postinstall 스크립트를 기본 차단했다는 경고가 나왔습니다. 빌드와 테스트에는 영향이 없었습니다.
