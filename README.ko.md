# soksak-plugin-clipboard

클립(Clip) — 클립보드 복사 이력과 영구 메모를 카테고리로 묶어 관리하는 soksak 플러그인. 우측 사이드바 탭.
내부에 두 종류가 있다: **클립보드**(자동 캡처)와 **메모**(사용자 작성, 영구).

## 항목 종류

| 종류 | 동작 |
|---|---|
| **클립보드**(clip) | 시스템 클립보드 복사를 자동 캡처(코어 `app.clipboard.watch` — OS별 이벤트를 단일 신호로 흡수, 폴링 0). 같은 내용은 합쳐 복사 횟수(copyCount)를 센다. |
| **메모**(memo) | 사용자가 직접 작성. **영구**(보존 자동삭제 대상 아님). |

## 보존 (privacy)

클립보드 이력을 오래 쌓아두는 것 자체가 위험하다(어제 복사한 비밀번호가 검색되는 것이 문제). 그래서:

- **즐겨찾기가 아닌 클립보드 항목은 보존일(기본 3일, 설정에서 1~30일) 후 자동 삭제**한다. 보존 기간 안에서는 검색 가능.
- **즐겨찾기**한 클립과 **메모**는 보존 대상이 아니다(영구).
- 재복사하면 나이가 갱신돼 자주 쓰는 클립은 남고, 방치된 것만 사라진다.
- 보존일은 설정 `retentionDays`(매니페스트 configuration) 로 조정한다.

## 카테고리

모든 항목은 카테고리에 속한다(기본 **"기본"**). `category.add/rename/delete`. 카테고리 삭제 시 그 항목들은
기본으로 옮겨지고(삭제 아님), 기본 카테고리는 변경·삭제할 수 없다. 뷰에서 카테고리로 필터.

## 커맨드 (전 기능 노출 — CLI/MCP/뷰 무관)

- 클립보드 항목(bare 이름) — `capture` · `list` · `search` · `favorite` · `category`(이동) · `delete` · `restore` · `clear` · `count` · `state` · **`purge`**(보존 정리)
- `memo.*` — add · update · delete
- `category.*` — add · rename · delete · list

```
sok plugin.soksak-plugin-clipboard.capture '{"text":"테스트"}'
sok plugin.soksak-plugin-clipboard.memo.add '{"content":"기억할 것","category":"기본"}'
sok plugin.soksak-plugin-clipboard.purge          # 보존 지난 클립 정리
```

## 데이터

코어 `app.data`(SQLite, 이 플러그인 전용 네임스페이스)만 — raw SQL 없음. 컬렉션 `items`(kind/category/
favorite/deleted/copyCount/at, FTS content), `cats`(name/order). CJK 전문검색(FTS5 trigram). 소프트 삭제는
boolean `deleted`. 나이(`at`)는 캡처/메모 작성 시각, 재복사 시 갱신(보존 기준).

## 빌드 / E2E

```
# 번들 없음 — main.js 가 곧 entry(단일 ESM).
SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node e2e/clip.mjs
```

소켓 JSON-RPC 로 앱을 구동해 멱등 시나리오(캡처·dedup·검색·메모 영구·카테고리 이동/이름변경/삭제·보존
purge[즐겨찾기·메모 예외]·휴지통)를 단언한다. 자동 캡처는 코어가 self-write echo 를 억제하므로 헤드리스에선
`capture`(watch 콜백과 같은 단일 유틸)로 검증한다. 멀티윈도우에선 `SOKSAK_WINDOW=<프로젝트 창 label>` 로 대상 창을 지정한다.

## 후속 (이번 범위 제외)

- 항목별 선택 암호화(필요한 경우 사용자가 직접) — 보존(영구화는 즐겨찾기)으로 1차 방어, 암호화는 후속.
- 민감 클립 마커(macOS concealed/transient) skip — 코어 워처 보강 필요(후속).

## 변경 이력

### 0.3.0 — BREAKING: `clip.` 명령 접두사 제거 (R4 반-stutter 법)

`plugin.<id>.<command>` 이름이 이미 도메인을 한 번 말한다. `soksak-plugin-clipboard` 의 `clip.` 네임스페이스는
플러그인 id 의 축약(`clip` ⊂ `clipboard`)을 재진술한 것으로 R4 법이 금지한다. 클립보드 항목 명령 11개를 모두 bare 동사로 개명한다.
`memo.*` 와 `category.*` 는 조작 대상 객체를 이름하므로 그대로 둔다. 옛 이름을 쓰던 호출자는 반드시 갱신해야 한다 — 옛 이름은 더 이상 해석되지 않는다.

| 옛 이름 | 새 이름 |
|---|---|
| `clip.capture` | `capture` |
| `clip.list` | `list` |
| `clip.search` | `search` |
| `clip.favorite` | `favorite` |
| `clip.category` | `category` |
| `clip.delete` | `delete` |
| `clip.restore` | `restore` |
| `clip.clear` | `clear` |
| `clip.count` | `count` |
| `clip.state` | `state` |
| `clip.purge` | `purge` |
