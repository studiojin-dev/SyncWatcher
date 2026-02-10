# ADR-20260210-0002: App Lifecycle – Background Mode & System Tray

- **Status:** Accepted
- **Date:** 2026-02-10
- **Tags:** lifecycle, tray, background, macos

## Context

SyncWatcher 종료 시 모든 watch/sync 작업이 중단됩니다.
사용자가 창을 닫아도 백그라운드에서 감시를 유지하거나, 명시적으로 완전 종료하는 선택지가 필요합니다.

## Decision

### 종료 동작 설정 (`closeAction`)

| 값 | 동작 |
|---|---|
| `quit` (기본값) | 활성 작업 있으면 확인 후 종료, 없으면 즉시 종료 |
| `background` | 확인 없이 Dock 숨김 + window hide |

### 이벤트 흐름

| 트리거 | Backend 이벤트 | Frontend 수신 | 동작 |
|---|---|---|---|
| 닫기 버튼 | `CloseRequested` → `close-requested` | `closeAction` 분기 | 설정 따름 |
| Cmd+Q | `ExitRequested(code=None)` → `close-requested` | `closeAction` 분기 | 설정 따름 |
| 트레이 "끝내기" | `tray-quit-requested` | 항상 종료 경로 | 활성 작업 있으면 확인, 없으면 즉시 종료 |
| `quit_app` 호출 | `ExitRequested(code=Some(0))` | — | 통과(종료) |

### 활성 작업 판정 기준

- **watchMode config**: `useSyncTasksContext().tasks.some(t => t.watchMode)` (YAML 설정 기반)
- **syncing**: `invoke('runtime_get_state')` → `syncingTasks.length > 0` (런타임 상태)
- **runtime 상태 조회 실패**: 안전 우선으로 `runtimeStateUnknown=true`로 간주하고 종료 확인 다이얼로그를 강제한다.

### 초기 로딩 중 종료 이벤트 처리

- `isLifecycleReady = settingsLoaded && tasksLoaded`가 false인 동안 `close-requested`/`tray-quit-requested`는 즉시 실행하지 않는다.
- 이벤트는 단일 대기 슬롯(`pendingCloseIntent`)에 큐잉한다.
- 우선순위는 `tray-quit` > `window-close`이며, 준비 완료 시 1회 소비한다.

### ExitRequested 무한루프 방지

`RunEvent::ExitRequested`에서 `code.is_none()`일 때만 `prevent_exit()`.
`code.is_some()`(= `app.exit(0)` 호출)은 통과시켜 정상 종료.

### 중복 이벤트 방지

프론트엔드에 `isHandlingCloseRef` 가드를 두어 재진입 차단.

### 트레이 메뉴 ID

`tray_open` / `tray_quit`으로 고유 접두어 사용하여 글로벌 메뉴와 충돌 방지.

### 트레이 열기 정책

- 트레이 `열기`/좌클릭은 항상 창 복구 경로를 실행한다.
- 순서: `ActivationPolicy::Regular` (macOS) → `show` → `unminimize` → `set_focus`.
- 실패는 무시하지 않고 backend 로그(`eprintln!`)로 남긴다.

## Consequences

- 기존 종료 동작(즉시 종료) 유지 (`closeAction` 기본값 = `quit`)
- 최초 실행 안내 배너로 백그라운드 옵션 소개
- WebView가 메모리에 남아 있으나 유틸리티 앱으로 허용 범위
- `.run()` → `.build()` + `app.run()` 구조 변경 (기능 동일)
