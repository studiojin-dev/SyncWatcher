# ADR-20260210-0002: App lifecycle (quit vs background)

- Status: Accepted
- Date: 2026-02-10
- Tags: lifecycle, tray, background, macos
- TL;DR: Separate window close from app exit via `quit`/`background` policy, and keep tray quit as explicit exit.

## Context

- Previously, closing the window stopped all watch/sync work.
- Users need an explicit choice between background monitoring and full exit.
- Exit behavior must be consistent across close button, Cmd+Q, and tray actions.

## Decision

1. Introduce `closeAction`.
   - `quit` (default): confirm if active work exists, then exit
   - `background`: hide Dock/window without confirmation
2. Force tray `quit` through explicit exit path (independent of `closeAction`).
3. Detect active work via `watchMode` + `runtime_get_state.syncingTasks`.
   - If runtime state read fails, force confirmation (safety-first).
4. Before lifecycle readiness (`settingsLoaded && tasksLoaded`), queue one close intent in `pendingCloseIntent`.
   - Priority: `tray-quit` > `window-close`
5. Prevent loops/re-entrancy.
   - Rust: call `prevent_exit()` only when `ExitRequested(code.is_none())`
   - Frontend: guard with `isHandlingCloseRef`
6. Force tray open to full restore path.
   - `ActivationPolicy::Regular` -> `show` -> `unminimize` -> `set_focus`

## Consequences

- Default behavior remains `quit` (safe backward compatibility).
- Users gain background-monitoring option.
- Exit reliability improves, with added state/event branching complexity.
- Resident WebView memory cost is accepted for utility-app behavior.

## Alternatives Considered

1. Allow quit-only behavior
   - Rejected: does not satisfy background monitoring need
2. Treat all exit paths identically
   - Rejected: weakens explicit meaning of tray "Quit"
