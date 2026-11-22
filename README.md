# DK BRAIN ARENA

진행자가 방을 만들고 참가자가 입장 코드로 함께하는 두뇌 게임 플랫폼입니다. **현재는 1차 구현 단계입니다.** 공통 플랫폼의 기본 흐름을 만들었고, 같은 게임 원본으로 온라인판과 오프라인판을 모두 배포할 수 있는지 검증했습니다. 상용 플랫폼이 완성된 상태가 아니며 판매 준비도 끝나지 않았습니다.

포함된 게임은 개발 검증용 샘플 **숫자 선택 샘플(`demo-number-choice`)** 하나뿐입니다. 이 샘플은 판매 게임이 아닙니다.

## 로컬 준비물
| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| Node.js | **22.23.5 (목표 런타임)**, 26.13.1(이전 기록) | 빌드·테스트·Functions 에뮬레이터 |
| Java | 21 | Firestore 에뮬레이터 |
| Firebase CLI | 15.36.0 | 에뮬레이터 (`npm i -g firebase-tools`) |
| Microsoft Edge | 157 | 브라우저 자동 검증 (Chrome은 `DKBA_BROWSER_CHANNEL=chrome`) |

**목표 런타임은 Node 22입니다.** `functions/package.json`의 `engines.node: "22"`와 `firebase.json`의 `runtime: "nodejs22"`가 이를 선언하고, `.nvmrc`도 `22`입니다. Node 22에서 전체 검증을 통과했습니다(`docs/VERIFICATION.md` 기록 2). 루트 개발 도구 중 `firebase` 웹 SDK는 `node >=24.12`를 선언하므로, Node 22에서 `npm ci`를 하면 EBADENGINE 경고가 나옵니다. 이 SDK는 배포 묶음에 포함되지 않고, 테스트는 Node 22에서 통과했습니다.

Firebase 계정 로그인이나 클라우드 프로젝트는 필요 없습니다. 로컬 프로젝트 ID는 `demo-dk-brain-arena`이며, `demo-` 접두어가 붙은 ID는 에뮬레이터 전용이라 실서비스에 연결되지 않습니다.

### Node 22를 이 프로젝트에만 사용하기 (전역 설치 없이)
nvm-windows 같은 버전 관리 도구가 있다면 `nvm use 22`를 쓰면 됩니다. 없다면 공식 zip을 프로젝트의 `.tools/` 폴더(Git 제외)에 풀고, **현재 PowerShell 창에서만** PATH 앞에 추가합니다.
```powershell
New-Item -ItemType Directory -Force .tools | Out-Null
Invoke-WebRequest https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip -OutFile .tools\node22.zip
(Get-FileHash .tools\node22.zip -Algorithm SHA256).Hash   # 4A191082E9706866830379D577D2CC8A50C776FCD9436A8D061B063ED0D9A0E3 와 같아야 함
Expand-Archive .tools\node22.zip -DestinationPath .tools; Remove-Item .tools\node22.zip
```
새 PowerShell 창을 열 때마다 아래 명령을 한 번 실행합니다. 그 창에서만 적용됩니다.
```powershell
$env:Path = "$PWD\.tools\node-v22.23.5-win-x64;" + $env:Path; node -v
```
Firebase CLI도 PATH에 있는 `node`로 실행되므로, 이 창에서 시작한 에뮬레이터의 Functions도 Node 22로 동작합니다. 로그에 `Using node@22 from host.`가 표시되면 정상입니다.

## 설치
잠금 파일 그대로 설치합니다.
```powershell
npm ci
```
```powershell
npm --prefix functions ci
```

## 실행 (로컬 에뮬레이터)
```powershell
npm run emulators
```
빌드한 뒤 Auth(9099), Firestore(8080), Functions(5001), Hosting(5000) 에뮬레이터를 실행합니다. 종료하려면 Ctrl+C를 누르세요. 에뮬레이터 데이터는 종료할 때 사라집니다.

- 홈: http://127.0.0.1:5000/
- 진행자: http://127.0.0.1:5000/host.html
- 참가자: http://127.0.0.1:5000/play.html

로컬 주소(127.0.0.1, localhost)에서는 항상 에뮬레이터에만 연결합니다. 에뮬레이터가 꺼져 있으면 연결 실패를 표시할 뿐, 실서비스로 넘어가지 않습니다.

## 샘플 진행 방법
1. **진행자**: 진행자는 **Google 로그인 + 관리자 승인**으로 정해집니다. 로컬에서는 다음 순서로 진행합니다.
   - 쓸 이메일을 에뮬레이터 승인 목록에 추가합니다. 에뮬레이터 데이터는 종료하면 사라지므로 실행할 때마다 다시 추가합니다.
     ```powershell
     npm run emulator:approve-host -- host@example.test
     ```
   - `host.html`에서 **Google로 로그인**을 누릅니다. 에뮬레이터의 가상 Google 로그인 창이 열리면 **Add new account**를 누르고 같은 이메일을 입력합니다. 실제 Google 계정은 쓰이지 않습니다.
   - 또는 화면 아래의 **에뮬레이터 테스트 계정**(로컬 전용)에서 같은 이메일로 계정을 만들어도 됩니다.
   - **방 만들기**를 누르면 6자리 입장 코드가 표시됩니다. 승인 목록에 없는 계정이면 "진행자 승인이 필요합니다"라는 안내가 나옵니다.
2. **공개 화면**(선택): 진행자 화면의 **공개 화면 열기** 링크를 빔프로젝터 화면에 띄웁니다.
3. **참가자 2명**: 진행자 화면이나 공개 화면의 **QR 코드**를 휴대폰 카메라로 찍으면 입장 코드가 채워진 입장 화면이 열리므로 닉네임만 입력하면 됩니다. QR 없이 `play.html`에서 입장 코드와 닉네임을 직접 입력해도 됩니다. QR은 대기실에서만 보이고 게임이 시작되면 사라집니다. 로컬 주소(`127.0.0.1`)의 QR은 같은 PC에서만 열리므로 휴대폰 확인은 운영 주소에서 하세요. 참가자는 익명 인증을 쓰며, 같은 브라우저 프로필은 같은 참가자로 인식됩니다. 한 PC에서 두 명을 시험하려면 시크릿 창이나 다른 브라우저를 사용하세요. 진행자 탭과 참가자 탭은 인증이 분리되어 있어 한 브라우저에서 함께 열어도 됩니다.
4. 진행자가 **게임 시작**을 누릅니다. 시작 이후에는 새 참가자가 입장할 수 없고, 기존 참가자의 재접속만 허용됩니다.
5. 참가자는 1·2·3 중 하나를 제출하고, 진행자가 **N라운드 마감**을 누릅니다. 이 과정을 3라운드 반복합니다.
6. 마지막 마감이 끝나면 모든 화면에 최종 순위가 표시됩니다. 동점이면 공동 순위입니다.

## 오프라인 패키지 생성
```powershell
npm run build:packages
```
- `dist/packages/demo-number-choice/standalone.html`: 단일 HTML 파일입니다. CDN, Firebase, 외부 폰트를 쓰지 않으며, 더블클릭하면 인터넷 없이 열립니다.
- `dist/packages/demo-number-choice-0.1.0-dev-sample.zip`: `standalone.html`, `QUICKSTART.txt`, `VERSION.txt`, `NOTICE_DEV_SAMPLE.txt`를 담고 있습니다.
- 오프라인판은 한 PC에서 진행자가 두 플레이어의 선택을 대신 입력하는 방식입니다. 여러 기기 접속 기능은 없습니다. 진행 초기화와 CSV 결과 내보내기를 지원합니다.
- `dist/packages`는 Hosting 공개 경로(`dist/hosting`)와 분리되어 있어 웹사이트에 배포되지 않습니다.
- 생성된 파일을 직접 고치지 마세요. 원본(`src/games/…`, `src/standalone/…`)을 수정한 뒤 다시 생성합니다.

## 검증
```powershell
npm run verify
```
Node 22를 적용한 창에서 실행하세요. 다음 순서로 진행됩니다.
1. 규칙 단위 테스트
2. Functions 묶음 자립성 확인 (Node 22 범위 밖 모듈이 로드되지 않는지 포함)
3. 산출물 분리 확인
4. 오프라인 실행
5. 에뮬레이터 통합 테스트
6. 브라우저 E2E
7. 연결 끊김·재연결 E2E

연결 끊김·재연결만 따로 실행하려면 아래 명령을 씁니다. 참가자 한 명의 통신을 차단·복원하면서 끊김 안내, 미접수 선택 표시, 자리·라운드·제출 상태 복구, 중복 등록·중복 점수 방지를 확인합니다.
```powershell
npm run test:reconnect
```
개별 명령은 `CLAUDE.md`에 정리되어 있고, 결과는 `docs/VERIFICATION.md`에 Node 22 기록과 Node 26 기록으로 나뉘어 있습니다. 스크린샷과 로그는 `tests/.artifacts/`에 저장되며 Git에는 포함되지 않습니다.

생성물(`dist/`, `functions/generated/`)은 Git에 포함하지 않습니다. 저장소를 새로 받았다면 `npm ci` 두 번과 `npm run build`로 다시 만듭니다.

## 연결 끊김 시 동작
- 연결이 끊기면 상태 라벨이 "× 오프라인"으로 바뀌고, 진행자·참가자 화면 본문에 안내가 나타납니다.
- 제출 성공 여부는 **서버의 처리 결과와 서버 기준 문서**로만 표시합니다. 서버 응답을 받지 못하면 접수 여부를 단정하지 않고, 화면의 서버 기준 상태를 확인하도록 안내합니다.
- 연결이 복원되면 기존 자리, 현재 라운드, 본인 제출 상태가 서버 기준으로 다시 표시됩니다. 오프라인 제출 대기열은 없으므로, 접수되지 않은 선택은 다시 해야 합니다.

## 운영 Firebase 프로젝트 연결
| 항목 | 값 |
|---|---|
| 프로젝트 ID / 번호 | `dk-brain-arena` / `565207270396` |
| `.firebaserc` 별칭 | `prod` → `dk-brain-arena` (기본값 `default`는 에뮬레이터 전용 `demo-dk-brain-arena` 그대로) |
| 웹 앱 | `Dk brain arena` (`1:565207270396:web:be7dcdbb220423ec38a879`), 설정은 `src/shared/firebase-env.js`의 `PRODUCTION_CONFIG` |
| Hosting 기본 주소 | https://dk-brain-arena.web.app |

연결 대상은 접속 주소로 정합니다. `127.0.0.1`과 `localhost`에서는 **항상 에뮬레이터**에 연결하고, `dk-brain-arena.web.app`처럼 배포된 주소에서만 운영 프로젝트를 씁니다(`tests/firebase-env.test.mjs`로 검사). npm 스크립트에는 배포 명령이 없으며, 기본 프로젝트가 `demo-`라서 `--project prod`를 붙이지 않으면 운영 프로젝트에 배포되지 않습니다.

웹 앱 설정의 `apiKey`는 브라우저 코드에 공개되는 식별값입니다. 비밀키가 아니며, 접근 통제는 Firestore 보안 규칙과 Functions 검증이 맡습니다. 저장소가 공개되어 있으므로 Google Cloud 콘솔에서 키를 제한해 두는 것을 권장합니다: API 및 서비스 → 사용자 인증 정보 → Browser key → 웹사이트 제한에 `dk-brain-arena.web.app/*`, `dk-brain-arena.firebaseapp.com/*` 추가.

### 배포 전에 Firebase 콘솔에서 할 일 (아직 하지 않음)
1. ~~**Firestore 데이터베이스 만들기**~~ — 완료(2026-11-22). `(default)`, 네이티브 모드, Standard, `asia-northeast3`. 보안 규칙 `firestore.rules`는 2026-11-22에 배포함(`firebase deploy --only firestore:rules --project prod`). 규칙을 바꾸면 같은 명령으로 다시 배포합니다.
2. **Authentication → 로그인 방법**: `Google`(진행자, 사용 설정함)과 **`익명`(참가자, 반드시 사용 설정)**을 켭니다. 운영에서 이메일/비밀번호 로그인은 쓰지 않습니다.
3. **Blaze(종량제) 요금제로 전환합니다.** Cloud Functions 배포에 필요합니다. Functions 리전은 `asia-northeast3`, 런타임은 `nodejs22`입니다.
4. ~~진행자 정책~~ — 결정됨: Google 로그인 + 관리자 승인. 관리자 계정 1개가 운영 승인 목록에 등록되어 있습니다(이메일은 공개 저장소에 기록하지 않음). 아래 "진행자 승인 관리"를 참고하세요.
5. App Check, 레이트 리밋, 오래된 방 정리 정책을 검토합니다.

### 진행자 승인 관리 (관리자)
진행자는 Google 계정으로 로그인하고, 관리자가 승인한 계정만 방을 만들 수 있습니다. 승인 여부는 서버(Functions)가 방을 만들 때 확인합니다.
- **추가:** Firebase 콘솔 → Firestore Database → 컬렉션 `hostAccounts` → 문서 추가.
  - 문서 ID: 진행자의 Google 이메일(**소문자**).
  - 필드: `enabled`(boolean) `true`. 필요하면 `note`(string)에 메모를 남깁니다.
- **해제:** `enabled`를 `false`로 바꾸거나 문서를 삭제합니다. 해제 후에는 새 방을 만들 수 없습니다. 이미 만든 방의 진행은 막지 않습니다.
- 이 컬렉션은 보안 규칙으로 브라우저에서 읽기·쓰기가 모두 막혀 있어, 스스로 진행자로 등록할 수 없습니다.
- 진행자 권한은 자기가 만든 방에만 적용됩니다. 승인 목록은 "방을 만들 수 있는 사람"만 정하며, 플랫폼 전체 관리자 화면은 없습니다.

### 배포 현황
- 2026-11-22: Firestore 보안 규칙, **Hosting**(https://dk-brain-arena.web.app) 배포함.
- **Functions는 미배포**(Blaze 요금제 필요). 그 전까지 운영 사이트에서 방 만들기·입장·진행은 동작하지 않습니다.

### 배포 명령 (위 준비 후, Node 22를 적용한 창에서)
```powershell
firebase deploy --project prod
```
predeploy 단계에서 `scripts/build.mjs`가 Functions 규칙 번들과 Hosting 파일을 다시 만듭니다. 나눠서 배포하려면 `--only firestore:rules`, `--only functions`, `--only hosting`을 씁니다. 판매 패키지(`dist/packages`)는 Hosting에 배포되지 않습니다.

## 문서
- `CLAUDE.md`: 확정 기준, 구조 원칙, 명령
- `docs/PROJECT_SPEC.md`: 확정 사항, 구현 기본값, 모듈 구조, 범위
- `docs/GAME_MODULE_GUIDE.md`: 새 게임 추가 방법
- `docs/VERIFICATION.md`: 실제 검증 결과
