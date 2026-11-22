# DK BRAIN ARENA

진행자가 방을 만들고 참가자가 입장 코드로 함께하는 두뇌 게임 플랫폼입니다. **현재는 1차 구현 단계입니다.** 공통 플랫폼의 기본 흐름을 만들었고, 같은 게임 원본으로 온라인판과 오프라인판을 모두 배포할 수 있는지 검증했습니다. 상용 플랫폼이 완성된 상태가 아니며 판매 준비도 끝나지 않았습니다.

포함된 게임은 개발 검증용 샘플 **숫자 선택 샘플(`demo-number-choice`)** 하나뿐입니다. 이 샘플은 판매 게임이 아닙니다.

## 로컬 준비물
| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| Node.js | 26.13.1 (22 이상 필요) | 빌드·테스트·Functions 에뮬레이터 |
| Java | 21 | Firestore 에뮬레이터 |
| Firebase CLI | 15.36.0 | 에뮬레이터 (`npm i -g firebase-tools`) |
| Microsoft Edge | 157 | 브라우저 자동 검증 (Chrome은 `DKBA_BROWSER_CHANNEL=chrome`) |

Firebase 계정 로그인이나 클라우드 프로젝트는 필요 없습니다. 로컬 프로젝트 ID는 `demo-dk-brain-arena`이며, `demo-` 접두어가 붙은 ID는 에뮬레이터 전용이라 실서비스에 연결되지 않습니다.

## 설치
```powershell
npm install
npm --prefix functions install
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
1. **진행자**: `host.html`에서 이메일과 6자 이상 비밀번호를 입력하고 **계정 만들기**를 누릅니다. 이 계정은 에뮬레이터 안에만 있는 테스트 계정이며, 외부 로그인 설정 없이 쓸 수 있습니다. 이어서 **방 만들기**를 누르면 6자리 입장 코드가 표시됩니다.
2. **공개 화면**(선택): 진행자 화면의 **공개 화면 열기** 링크를 빔프로젝터 화면에 띄웁니다.
3. **참가자 2명**: 각자 `play.html`에서 입장 코드와 닉네임을 입력합니다. 참가자는 익명 인증을 쓰며, 같은 브라우저 프로필은 같은 참가자로 인식됩니다. 한 PC에서 두 명을 시험하려면 시크릿 창이나 다른 브라우저를 사용하세요. 진행자 탭과 참가자 탭은 인증이 분리되어 있어 한 브라우저에서 함께 열어도 됩니다.
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
규칙 단위 테스트부터 Functions 묶음 자립성, 산출물 분리, 오프라인 실행, 에뮬레이터 통합, 브라우저 E2E까지 순서대로 실행합니다. 개별 명령은 `CLAUDE.md`에 정리되어 있고, 결과는 `docs/VERIFICATION.md`에 기록되어 있습니다. 스크린샷과 로그는 `tests/.artifacts/`에 저장됩니다.

## 운영 배포 시 필요한 외부 설정 (이번 작업에서는 수행하지 않음)
- Firebase 프로젝트를 만들고 `.firebaserc`의 프로젝트 ID를 바꿉니다.
- `src/shared/firebase-env.js`의 `PRODUCTION_CONFIG`에 웹 앱 설정을 넣습니다.
- **Cloud Functions 배포에는 Blaze(종량제) 요금제가 필요합니다.** Functions 리전은 `asia-northeast3`, 런타임은 `nodejs22`입니다.
- Authentication에서 이메일/비밀번호와 익명 로그인 제공자를 활성화합니다.
- `firebase deploy`를 실행하면 predeploy 단계에서 `scripts/build.mjs`가 Functions 규칙 번들과 Hosting 파일을 다시 생성합니다.
- 운영 전에 App Check, 레이트 리밋, 오래된 방 정리 정책을 별도로 검토해야 합니다.

## 문서
- `CLAUDE.md`: 확정 기준, 구조 원칙, 명령
- `docs/PROJECT_SPEC.md`: 확정 사항, 구현 기본값, 모듈 구조, 범위
- `docs/GAME_MODULE_GUIDE.md`: 새 게임 추가 방법
- `docs/VERIFICATION.md`: 실제 검증 결과
