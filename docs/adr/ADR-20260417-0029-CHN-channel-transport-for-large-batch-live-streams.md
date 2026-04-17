# ADR-20260417-0029-CHN: Channel transport for large batch live streams
Tags: tauri, runtime, events, channels, sync, dry-run, logs
Status: Accepted
Date: 2026-04-17
TL;DR: Keep small runtime/status notifications on Tauri events, but move large live batch payloads to invoke-scoped or subscription-scoped Tauri channels with event fallback only when no channel is attached.

## Context

- SyncWatcher already emits live dry-run diffs, manual sync file results, and task log batches through Tauri events.
- The app's larger payloads are `dry-run-diff-batch`, `sync-file-batch`, and `new-logs-batch`.
- Tauri v2 recommends channels for higher-volume streaming, while plain events remain simpler for small notifications and global state changes.
- Existing ADRs already define the UI/session semantics for live dry-run and manual sync results:
  - `ADR-20260321-0014-DRY` keeps dry-run sessions task-scoped and terminal-state-safe.
  - `ADR-20260408-0023-SYN` treats `sync-file-batch` as the structured manual sync result feed and `sync-session-finished` as the terminal completion signal.
- We want transport improvement without reopening those UX and state decisions.

## Decision

1. Move only the large batch streams to Tauri channel transport.
   - `dry-run-diff-batch`
   - `sync-file-batch`
   - `new-logs-batch`
2. Keep small and state-oriented notifications on the existing event path.
   - `dry-run-progress`
   - `sync-progress`
   - `runtime-*`
   - `sync-session-finished`
   - `config-store-changed`
   - `new-log-task`
3. Use command-scoped channels for manual dry-run and manual sync batch payloads.
   - `sync_dry_run` accepts an optional diff batch channel.
   - `start_sync` and `start_sync_from_dry_run` accept an optional sync file batch channel.
4. Use a task-scoped subscription channel for task log batches.
   - The renderer opens a batch subscription only while the task log modal is active.
   - The backend tracks task log batch subscribers and removes failed subscriptions automatically.
5. Channel transport is channel-first with event fallback only when no channel is attached.
   - If a batch channel is present, the backend does not also emit the same batch on the legacy event name.
   - If no batch channel or subscription is present, the backend preserves the prior event behavior.
6. Preserve current session/result semantics.
   - `sync-file-batch` remains the structured per-file manual sync result feed.
   - `new-logs-batch` remains a live log batch stream and is not promoted to the sync result source of truth.
   - Progress and terminal events still define running and completion state transitions.

## Consequences

- Large batch payloads no longer depend on global event fanout when a direct channel is available.
- Existing renderer state shape and UX behavior remain unchanged because only the transport layer moves.
- Background/watch/scheduled sync behavior stays on the current event-driven runtime path.
- Task log modal lifetime now owns a backend subscription that must be cleaned up on close or unmount.

## Alternatives Considered

1. Move every runtime event to channels
   - Rejected because status and global notifications are small, already stable, and simpler on events.
2. Keep all live payloads on events and only tune batch size/intervals
   - Rejected because it does not address the transport mismatch for large payloads in Tauri v2.
3. Reuse task logs as the manual sync result source
   - Rejected because `sync-file-batch` is already the structured per-file result feed and logs remain human-oriented.
