# 숫자 선택 샘플 (demo-number-choice) — 운영·실행 안내

> 개발 검증용 샘플입니다. 판매 게임이 아니며 상용 게임으로 확정된 것이 아닙니다.

## 규칙
- 플레이어 2명, 총 3라운드 (이 샘플만의 값이며 플랫폼 전체 제한이 아님)
- 각 플레이어는 라운드마다 1·2·3 중 하나를 한 번 제출합니다. 제출된 선택은 공개 정보입니다.
- 진행자가 라운드를 마감하면 각자 선택한 숫자만큼 점수를 받습니다. 미제출자는 0점입니다.
- 같은 제출·마감이 반복되어도 점수는 한 번만 반영됩니다 (라운드 번호가 맞지 않는 요청은 거부).
- 마지막 라운드 이후 누적 점수로 순위를 정하고, 동점은 공동 순위입니다.

## 행동 (executeAction)
| type | 주체 | 필드 | 거부 코드 |
|---|---|---|---|
| `choose` | player | `round`, `value`(1~3) | `not-player`, `stale-round`, `invalid-choice`, `already-submitted`, `game-finished` |
| `closeRound` | host | `round` | `not-host`, `stale-round`, `game-finished` |

## 진행 방식
- 플랫폼판: 진행자(PC) 방 생성 → 참가자 2명(모바일)이 입장 코드로 입장 → 진행자 시작 → 참가자 제출 → 진행자 마감 ×3 → 결과.
- 오프라인판(standalone.html): 한 PC에서 진행자가 두 플레이어의 선택을 대신 입력하고 마감합니다. 다기기 접속 기능은 없습니다.

## 파일
- `manifest.json` 게임 정보 · `rules.js` 규칙 원본 · `view.js` 화면 원본 · `game.css` 전용 스타일 · `assets/` 자료
