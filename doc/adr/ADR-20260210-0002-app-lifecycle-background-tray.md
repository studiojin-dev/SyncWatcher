# ADR-20260210-0002: App lifecycle (quit vs background)

- Status: Accepted
- Date: 2026-02-10
- Tags: lifecycle, tray, background, cmd-quit, macos
- TL;DR: Keep window-close behavior stable under `closeAction`, add source-aware close events, and apply Cmd+Q-only confirmation policies.

## Context

- Previously, closing the window stopped all watch/sync work.
- Users need an explicit choice between background monitoring and full exit.
- Users require stronger guardrails on Cmd+Q than on window-close.
- Exit intent must be source-aware so close button and Cmd+Q can diverge without changing tray semantics.

## Decision

1. Introduce `closeAction`.
   - `quit` (default): confirm if active work exists, then exit
   - `background`: hide Dock/window without confirmation
2. Change `close-requested` payload from unit `()` to `{ source }`.
   - `source: 'window-close' | 'cmd-quit'`
3. Keep window-close behavior unchanged.
   - `closeAction=background` keeps immediate background hide
   - otherwise follow explicit quit path
4. Apply Cmd+Q-only policy.
   - `closeAction=background`: show 3-choice dialog (`background`, `full quit`, `cancel`)
   - `closeAction=quit`: show quit confirmation with 10s timeout; no response means auto-quit
5. Force tray `quit` through explicit exit path (independent of `closeAction`).
6. Detect active work via `watchMode` + `runtime_get_state.syncingTasks`.
   - If runtime state read fails, force confirmation (safety-first).
7. Before lifecycle readiness (`settingsLoaded && tasksLoaded`), queue one close intent in `pendingCloseIntent`.
   - Priority: `tray-quit` > `cmd-quit` > `window-close`
8. Prevent loops/re-entrancy.
   - Rust: call `prevent_exit()` only when `ExitRequested(code.is_none())`
   - Frontend: guard with `isHandlingCloseRef`
9. Force tray open to full restore path.
   - `ActivationPolicy::Regular` -> `show` -> `unminimize` -> `set_focus`

## Consequences

- Default behavior remains `quit` (safe backward compatibility).
- Window-close muscle memory is preserved.
- Cmd+Q becomes explicitly safer with an intentional choice and timeout fallback.
- Exit reliability improves with source-aware branching, at the cost of additional lifecycle state complexity.
- Resident WebView memory cost is accepted for utility-app behavior.

## Alternatives Considered

1. Keep quit-only behavior
   - Rejected: does not satisfy background monitoring need
2. Treat window-close and Cmd+Q identically
   - Rejected: cannot satisfy both convenience (window close) and safety (Cmd+Q intent) simultaneously
3. Apply Cmd+Q confirmation to every close source
   - Rejected: unnecessarily regresses existing window-close background workflow
