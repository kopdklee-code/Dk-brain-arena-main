# DK BRAIN ARENA — 작업 지침

원 지시문: `DK_BRAIN_ARENA_Claude_Code_01.txt` (1차 구현 기준). 상세 설계는 `docs/`.

## 확정된 기준 (사용자 확정 — 임의 변경 금지)
- 화면: HTML · CSS(직접 작성) · 순수 JavaScript. React/Vue/Next.js/TypeScript/Tailwind 도입 금지.
- 데이터베이스·호스팅: Firebase.
- 게임은 독립 모듈로 하나씩 추가 (`src/games/<gameId>/`), 코드 등록 목록(`src/games/registry.js`, `views.js`)에 추가하는 방식. 임의 JS 업로드·플러그인 마켓 금지.
- 같은 게임 원본에서 플랫폼판과 개별 판매용 파일을 생성. 플랫폼판/판매판을 복사해 따로 관리하지 않음.
- 개발 도구(esbuild, playwright-core, Firebase CLI)는 빌드·검증용이며 서비스 기술 스택이 아님.

## 구조 원칙
- `rules.js`는 순수 함수(createGame·executeAction·getView·getResult·normalizeConfig). DOM·Firebase·네트워크·저장소·시간·난수 직접 사용 금지.
- `view.js`는 상태 표시와 입력 전달만. Firebase·로그인을 모름.
- 플랫폼 방 상태(lobby/playing/finished)와 게임 내부 단계는 분리. 게임별 라운드·점수 공식을 공통 코드에 넣지 않음.
- 모든 쓰기는 Cloud Functions가 판정(UID·방 소유자·참가자·단계·입력 검증, requestId + 트랜잭션). Firestore 규칙은 클라이언트 쓰기 전면 금지.
- 문서 분리: `rooms/{id}` 공개 · `players/{uid}` 참가자 · `private/{uid}` 본인만 · `server/*`, `requests/*`, `codes/*` 서버 전용.
- 로컬 주소에서는 에뮬레이터만 사용(프로젝트 ID `demo-dk-brain-arena`). 실서비스로 자동 연결 금지.
- 생성물(`functions/generated/`, `dist/`)은 직접 수정 금지 → 원본 수정 후 재빌드.
- 출력 분리: Hosting `dist/hosting`(firebase.json public), 판매 패키지 `dist/packages`(Hosting 배포 금지).

## 작업 범위 기준
- 1차 범위: 공통 흐름 + 개발 검증용 샘플 `demo-number-choice`(isDemo, 판매 게임 아님) + 오프라인 패키지 + 로컬·에뮬레이터 검증.
- 범위 밖: 원격 배포, Git 원격 푸시, 실서비스 데이터 변경, 클라우드 프로젝트 생성·요금제 변경, 결제·구독·토너먼트·기관 관리·AI 분석·게임 편집기, 구매자 Firebase 설치형 전체 구현.
- 샘플을 상용 게임으로 확정하지 않음. 가상의 게임·구매자 수·성공 사례 표시 금지.
- 실제 실행하지 못한 검증은 통과로 기록하지 않음 (`docs/VERIFICATION.md`).

## 명령
```
npm install && npm --prefix functions install   # 최초 1회
npm run build                  # functions/generated, dist/hosting, dist/packages 생성
npm run emulators              # 빌드 후 Auth·Firestore·Functions·Hosting 에뮬레이터 (http://127.0.0.1:5000)
npm run verify                 # 전체 검증 (아래 개별 명령을 순서대로 실행)
npm run test:rules             # 규칙 단위 테스트
npm run check:functions-bundle # 새 디렉터리에서 Functions 묶음 자립성 확인
npm run check:dist             # Hosting/패키지 분리 확인
npm run test:offline           # ZIP 해제 → standalone.html file:// 오프라인 3라운드 (Edge)
npm run test:emulator          # 에뮬레이터 통합 테스트 (권한·중복·동시성·판정 일치)
npm run test:e2e               # 브라우저 E2E (진행자·참가자 2명·공개 화면, Edge)
```
요구 사항: Node 22+, Java 21(Firestore 에뮬레이터), Firebase CLI, Microsoft Edge(브라우저 검증. `DKBA_BROWSER_CHANNEL=chrome` 으로 변경 가능).

## 관련 문서
- `README.md` — 준비물·실행·샘플 진행·패키지 생성
- `docs/PROJECT_SPEC.md` — 확정 사항·구현 기본값·모듈 구조·범위
- `docs/GAME_MODULE_GUIDE.md` — 새 게임 추가 방법·배포 방식 선언 규칙
- `docs/VERIFICATION.md` — 실제 검증 결과·미검증 항목
