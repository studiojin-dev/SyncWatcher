# ADR-20260219-0005: Target-newer conflict deferred review in dedicated window

- Status: Accepted
- Date: 2026-02-19
- Tags: sync-task, safety, conflict-review, watch-mode, ux, macos, tauri
- TL;DR: When target files are newer than source, skip auto-copy and defer handling to an explicit review session in a separate conflict-review window.

## Context

- Existing sync flow could overwrite target files even when target had newer edits.
- Users need side-by-side verification for text/media before deciding overwrite behavior.
- Watch-mode conflicts can happen in background and should not force disruptive popups.
- Auto unmount after sync can hide/remount-sensitive state before conflict resolution.

## Decision

1. Treat `target.modified > source.modified` as `target-newer conflict`.
   - Do not copy automatically.
   - Add item to in-memory conflict review session.
2. Return sync result as `SyncExecutionResult` including:
   - `syncResult`
   - `conflictSessionId`
   - `conflictCount`
   - `hasPendingConflicts`
3. Add backend commands for queue/session lifecycle:
   - `list_conflict_review_sessions`
   - `get_conflict_review_session`
   - `open_conflict_review_window`
   - `resolve_conflict_items`
   - `close_conflict_review_session`
4. Add conflict events for frontend synchronization:
   - `conflict-review-queue-changed`
   - `conflict-review-session-updated`
5. Use dedicated Tauri window label `conflict-review` (large, resizable).
   - Top: source/target preview (text diff, image, video, document fallback via OS opener).
   - Bottom: pending list and resolution actions.
6. Support three explicit actions for selected items:
   - Force copy (irreversible warning + user confirmation).
   - Rename target then copy source (recommended safer path).
   - Skip for this run (warning that conflict may recur).
7. Safe-copy rename format:
   - `{stem}_{YYYYMMDD_HHmmss}_{A-Z0-9 3자리}.{ext}`
   - Retry up to 20 times on name collision.
8. Closing behavior:
   - No pending items: close directly.
   - Pending items exist: ask confirmation.
   - Force close marks pending as `Skipped` for this run.
9. Auto unmount exception:
   - If `hasPendingConflicts = true`, skip auto unmount in manual/runtime paths.
10. Session persistence:
    - Memory-only (lost on app restart).

## Consequences

- Prevents accidental overwrite of newer target files and makes data-preservation path explicit.
- Introduces additional review step and delayed completion for conflict cases.
- Keeps watch-mode non-blocking while still surfacing conflicts in queue + notification path.
- Memory-only sessions are simpler but unresolved sessions do not survive restart.

## Alternatives Considered

1. Always overwrite target when source differs
   - Rejected: high data-loss risk when target contains newer edits.
2. Show conflict UI inside main window only
   - Rejected: side-by-side preview needs larger space and independent workflow.
3. Persist sessions to disk
   - Rejected (current scope): adds state migration/recovery complexity; deferred.
