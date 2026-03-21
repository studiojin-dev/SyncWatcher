# ADR-20260321-0014-DRY: Live dry-run session reentry and terminal immutability
Tags: dry-run, runtime, mcp, ux, tauri, reliability
Status: Accepted
Date: 2026-03-21
TL;DR: Treat live dry-run sessions as task-scoped UI state, keep terminal sessions immutable against late events, and expose MCP-origin dry-run sessions through task-button reentry instead of auto-navigation.

## Context

- SyncWatcher now emits live dry-run progress and diff batches through the same Tauri event path for both manual UI runs and MCP-origin runs.
- The frontend needs one consistent rule for how those live sessions affect task-card status, how terminal results behave when late events arrive, and how externally started sessions become visible to the user.
- Review feedback identified three risks in the initial implementation:
  - watch-state events could demote an active dry-run task back to `watching` or `idle`
  - late progress or diff-batch events could mutate a completed/cancelled/failed session
  - MCP-origin dry-run sessions could accumulate in renderer state without a user-visible reentry path

## Decision

1. Treat `dryRunning` as a protected task status alongside `syncing` and `queued`.
   - Runtime watch-state events must not demote an active dry-run task.
   - The task card may still show watcher state through other UI, but the primary task status remains `dryRunning` until the dry-run finishes.
2. Make terminal dry-run sessions immutable.
   - Once a session becomes `completed`, `cancelled`, or `failed`, later progress or diff-batch events are ignored.
   - Terminal state wins over late event delivery so finished results remain stable.
3. Keep dry-run sessions task-scoped and user-reenterable.
   - Keep at most one dry-run session per task.
   - Starting a new dry-run replaces the previous session for that task.
   - Deleting a task clears its session.
4. Keep MCP-origin dry-run live events visible in the app, but do not auto-open the result view.
   - External dry-runs reuse the same session model as manual dry-runs.
   - When a task already has a dry-run session, the task-card dry-run button reopens that live/result view instead of starting a new run immediately.
   - Starting a fresh dry-run from a terminal session happens from the result view via an explicit retry action.

## Consequences

- Manual and MCP-origin dry-runs now share one consistent UI/session model.
- Late Tauri event delivery can no longer re-mark a finished dry-run as active or append duplicate result rows.
- Users can inspect externally started dry-run sessions without unexpected screen transitions.
- The task-card dry-run button becomes an "open existing session first" affordance whenever a session is present.

## Alternatives Considered

1. Hide MCP-origin dry-run live events from the renderer entirely
   - Rejected because the chosen UX is to keep MCP-origin dry-runs visible in the running app.
2. Auto-open the dry-run result view when any external dry-run event arrives
   - Rejected because background control-plane activity should not forcibly change the user’s current screen.
3. Allow terminal sessions to keep accepting late batches and rely on backend event ordering
   - Rejected because the UI must remain correct even when event delivery order is delayed or interleaved.
