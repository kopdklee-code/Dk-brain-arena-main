# DK BRAIN ARENA — 프로젝트 명세 (1차 구현)

## 1. 사용자 확정 사항
지시문(`DK_BRAIN_ARENA_Claude_Code_01.txt`)과 사용자 요청에서 확정된 내용입니다. 임의로 변경하지 않습니다.

| 항목 | 내용 |
|---|---|
| 플랫폼 이름 | DK BRAIN ARENA |
| 화면 기술 | HTML, CSS(직접 작성), 순수 JavaScript |
| 데이터베이스·호스팅 | Firebase |
| 개발 방식 | 게임을 독립 모듈로 하나씩 추가 |
| 판매 | 각 게임을 개별 파일 상품으로도 판매 가능해야 함 |
| 원본 관리 | 게임 규칙·화면 원본 하나 → 플랫폼판과 판매판을 생성. 복사 후 따로 관리 금지 |
| 금지 기술 | React, Vue, Next.js, TypeScript, Tailwind |
| 허용 도구 | Firebase SDK, Firebase CLI, 검증·패키징용 최소 개발 도구 |
| 첫 상용 게임 | 미선정 (이번에 확정하지 않음) |

## 2. 구현 기본값 (사용자 미확정 → 지시문의 기본값 적용)
| 항목 | 적용값 | 비고 |
|---|---|---|
| 데이터베이스 | Cloud Firestore | Realtime Database 미도입 (함께 도입하지 않음) |
| 사용자 식별 | Firebase Authentication | 진행자: 이메일/비밀번호, 참가자: 익명 인증 |
| 서버 판정 | Cloud Functions (JavaScript, 2세대 callable) | 리전 `asia-northeast3`(서울), 런타임 `nodejs22` (목표 Node 22: functions engines·firebase.json·.nvmrc 일치, Node 22.23.5로 검증) |
| 유료 파일 보관·다운로드 | 후속 단계: Cloud Storage + 구매 권한 검증 | 이번 미구현 |
| 로컬 프로젝트 ID | `demo-dk-brain-arena` | `demo-` 접두어 → 에뮬레이터 전용, 실서비스 접근 불가 |
| 운영 프로젝트 | `dk-brain-arena` (번호 565207270396, `.firebaserc` 별칭 `prod`) | 사용자가 생성. 웹 앱 `Dk brain arena` 설정을 `PRODUCTION_CONFIG`에 연결. 배포 주소에서만 사용 |
| 빌드 도구 | esbuild 0.28.2 | 브라우저 번들·Functions 규칙 번들·standalone 인라인 |
| 브라우저 검증 도구 | playwright-core 1.65.1 + 설치된 Edge | 브라우저 다운로드 없음 |
| ZIP 생성 | 자체 작성(`scripts/lib/zip.mjs`, Node zlib) | 추가 의존성 없음 |
| 입장 코드 | 6자리, 모호 문자(0·O·1·I) 제외 32자 알파벳 | 서버에서 난수 생성, 충돌 시 재시도 |
| 닉네임 | 1~12자, 방 안에서 중복 불가 | 재접속 시 기존 닉네임 유지 |
| 진행자 참가 | 같은 방에 참가자로 입장 불가 | |
| 결과 내보내기(오프라인) | CSV(UTF-8 BOM) | |
| 오프라인 진행 저장 | 저장하지 않음 (새로고침 시 초기화) | QUICKSTART에 명시 |

## 3. 모듈 구조
```
src/
  games/
    registry.js              서버·브라우저 공용 등록 목록 (manifest + rules)
    views.js                 브라우저 전용 화면 모듈 등록
    demo-number-choice/      검증용 샘플 (isDemo: true)
      manifest.json  rules.js  view.js  game.css  assets/  README.md(운영 안내)
  shared/
    contract.js              공통 계약 검사, 플랫폼 방 상태(lobby/playing/finished)
    validation.js            입장 코드·닉네임·requestId·행동 형식 검증
    firebase-env.js          에뮬레이터/운영 모드 결정 (로컬=에뮬레이터 고정)
    server-entry.js          Functions 규칙 번들 빌드 입력
  adapters/
    local-session.js         로컬 실행 연결부 (규칙을 브라우저 안에서 실행)
    firebase-room.js         온라인 연결부 (Functions 호출 + Firestore 구독)
  platform/                  홈·상세·진행자·참가자·공개 화면, 공통 CSS
  standalone/                오프라인 실행형 껍데기 (shell.js, shell.css)
functions/
  src/index.js               createRoom · joinRoom · startGame · gameAction
  generated/games.js         ← 빌드 생성 (src/games 원본 번들, 직접 수정 금지)
scripts/build.mjs            functions | hosting | packages | all
tests/                       단위·통합·E2E·오프라인·산출물 검사
firestore.rules              클라이언트 쓰기 전면 금지, 문서 단위 읽기 권한
```

### 3.1 게임 계약
| 함수 | 역할 |
|---|---|
| `normalizeConfig(config)` | 설정 검증·정규화 → `{ok, config}` |
| `createGame({players, config})` | 초기 상태 생성 → `{ok, state}` |
| `executeAction(state, actor, action)` | 행동 적합성 확인과 상태 변경 → `{ok, state}` / `{ok:false, error:{code,message}}` (입력 state 불변) |
| `getView(state, viewer)` | 보는 사람(`public`/`host`/`player`/`local`)에게 허용된 정보 |
| `getResult(state)` | 종료 여부와 순위 (동점 공동 순위) |

`actor`는 `{role:'host'}` 또는 `{role:'player', playerId}`이며 서버가 UID로 결정합니다(클라이언트가 보낸 값을 믿지 않음).

화면 모듈은 `mount(root, {role, send}) → {update({view, result}), destroy()}` 계약을 따릅니다.

### 3.2 세션 계약 (연결부)
- 로컬: `createLocalSession(...)` → `subscribe(listener)`, `send(action, {playerId})` — 규칙을 직접 실행.
- 온라인: `createOnlineSession(api, roomId)` → `send(action)` — Functions 판정 결과만 받음. 표시 데이터는 Firestore 공개·개인 문서 구독.

### 3.3 Firestore 문서
| 경로 | 내용 | 읽기 | 쓰기 |
|---|---|---|---|
| `rooms/{roomId}` | 코드, hostUid, gameId·gameVersion·config(고정), 방 상태, `publicView`, `result` | 로그인 사용자 | 금지 |
| `rooms/{roomId}/players/{uid}` | playerId(자리), nickname | 로그인 사용자 | 금지 |
| `rooms/{roomId}/private/{uid}` | 본인용 view | 본인만 | 금지 |
| `rooms/{roomId}/server/state` | 전체 게임 상태, UID→자리 | 금지 | 금지 |
| `rooms/{roomId}/requests/{requestId}` | 처리된 요청과 응답 | 금지 | 금지 |
| `codes/{code}` | 입장 코드 → roomId | 금지 | 금지 |

모든 쓰기는 Functions(관리자 SDK)가 트랜잭션 안에서 수행합니다.

### 3.4 서버 판정 흐름
1. 인증 확인 (방 생성은 익명이 아닌 진행자 계정만).
2. requestId 형식 검사 → 트랜잭션 시작 → `requests/{requestId}`가 있으면 저장된 응답을 반환(`duplicate:true`)하고 점수를 다시 반영하지 않음. 다른 UID가 같은 requestId를 쓰면 거부.
3. 방·서버 상태 읽기 → 진행자/참가자/외부인 판정 → 방 상태(playing) 확인 → 시작 시 고정된 gameVersion과 서버 규칙 버전 일치 확인.
4. `rules.executeAction` 실행 → 서버 상태, 공개 문서, 개인 문서(진행자·각 참가자), 요청 기록을 같은 트랜잭션에서 기록.
5. 트랜잭션이 재시도되어도 외부 부수효과가 없음 (모든 효과가 트랜잭션 쓰기).
6. 라운드 마감·제출은 `round` 번호를 포함 → 지난 라운드·반복 마감은 규칙에서 `stale-round`로 거부.

## 4. 이번 범위
1. 플랫폼 홈·게임 목록·게임 상세 (구현된 샘플만 표시)
2. 진행자 로그인(에뮬레이터 계정)·방 생성·게임 시작·라운드 마감·결과 확인, 새로고침 복구(`?room=`)
3. 참가자 입장 코드·닉네임 입장, 재접속 복구, 나가기(구독 해제)
4. 공개 화면 (빔프로젝터용, 읽기 전용)
5. 검증용 샘플 `demo-number-choice`
6. 같은 원본에서 `standalone.html`과 ZIP 생성
7. 로컬 실행 방법과 검증 결과 문서

## 5. 후속 범위 (이번 미구현)
- 첫 상용 게임 선정과 구현
- 운영 Firebase 배포 (프로젝트 `dk-brain-arena` 연결 완료. 배포 전 Firestore 생성, Auth 제공자 사용 설정, Blaze 요금제 필요)
- 결제·구매 권한 검증, Cloud Storage 유료 파일 보관·다운로드
- 구매자 Firebase 설치형 패키지 (Hosting + Functions + 규칙 + 설정 + 안내)
- 구독, 토너먼트, 기관 관리, AI 분석, 자체 게임 편집기
- 자동 라운드 마감(타이머), 방 정리(TTL), App Check, 레이트 리밋
- 실제 외부 로그인 제공자(Google 등) 설정
