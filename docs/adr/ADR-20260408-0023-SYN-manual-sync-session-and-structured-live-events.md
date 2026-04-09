# ADR-20260408-0023-SYN: Manual sync session UI and structured live sync events
Tags: sync, runtime, ux, tauri, events, dry-run
Status: Accepted
Date: 2026-04-08
TL;DR: Add task-scoped manual sync sessions in the renderer, emit structured sync live events with origin metadata, and keep background/watch sync from hijacking the manual result view.

## Context

- Dry-run already has a task-scoped live/result view with stable terminal state and explicit reentry.
- Manual copy previously relied on card-level status plus toasts, which made active work harder to inspect and gave no persistent result view.
- The backend already emits sync progress, but it does not distinguish manual vs watch/scheduled execution in the renderer and it does not expose structured per-file sync results.
- The dry-run tree also needs directory-level aggregate display, and the same tree behavior is desirable for manual sync results.

## Decision

1. Add a renderer-side manual sync session model parallel to the existing dry-run session model.
   - Keep at most one sync session per task.
   - Starting a new manual sync replaces the previous session for that task.
   - Terminal sync sessions remain stable against late manual events.
2. Open a dedicated in-app sync result screen immediately after manual sync confirmation.
   - The screen shows live progress while running.
   - Terminal results remain visible until the user leaves.
   - Run Again is explicit and reuses the same confirmation path as a fresh manual sync.
3. Keep watch/background sync card-driven.
   - Background/watch/scheduled sync must not auto-open or overwrite the manual sync result screen.
   - Renderer session updates apply only to manual sync runs that already have an active task-scoped session.
4. Extend live sync events with structured metadata.
   - `runtime-sync-state` includes sync origin.
   - `sync-progress` includes sync origin.
   - Add a structured `sync-file-batch` event carrying per-file copied/failed results.
   - `sync-file-batch` is a real batch event: entries are coalesced by time/size before emission.
5. Treat a dedicated Tauri terminal event as the authoritative manual sync completion signal.
   - `start_sync` and MCP sync responses stay summary-only.
   - Add `sync-session-finished` with terminal status, counts, errors, conflict summary, target preflight, and optional reason.
   - Live batches improve the running view, but terminal manual sync state is finalized only after the final batch flush and `sync-session-finished`.
6. Reuse one aggregate-capable tree model for dry-run and sync result tables.
   - Directory rows display descendant changed-item count and summed source/target sizes.
7. Treat same-size mtime-only drift as content-check territory in dry-run.
   - If source is newer but size is equal, compare content before classifying the file as `Modified`, even when checksum mode is off.

## Consequences

- Manual sync now has the same inspectable, task-scoped UX shape as dry-run.
- Background/watch sync still updates runtime status, but no longer risks taking over the manual result view.
- The renderer can build sync result tables from structured data instead of parsing log strings.
- Dry-run becomes less noisy for workflows that preserve content but rewrite mtimes.

## Alternatives Considered

1. Reuse task logs as the sync result source
   - Rejected because parsing human-readable log lines is brittle and cannot safely distinguish row status or sizes.
2. Auto-open the sync result view for every sync origin
   - Rejected because watch/background work should stay non-disruptive.
3. Keep mtime-based `Modified` detection unless checksum mode is enabled
   - Rejected because it produces misleading dry-run noise for same-content metadata drift.
