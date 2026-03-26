# ADR-20260215-0004-RTQ: Runtime watch-mode initial sync queue and concurrency limit
Status: Accepted
Date: 2026-02-15
Tags: sync-task, watch-mode, runtime, concurrency, reliability, macos
TL;DR: Runtime watch sync uses a bounded queue (max parallelism 2), coalesces watch events during active sync into one replay, and serializes overlapping runtime config applies.

## Context

- `watchMode` tasks started watching file-system events, but initial startup had no guaranteed first sync.
- Multiple watch events from multiple tasks could trigger many sync attempts at once.
- Without queueing and bounded parallelism, concurrent IO pressure and duplicated starts reduce stability.

## Decision

1. Add runtime-managed sync queue for watch-mode tasks.
2. Enqueue initial sync for all `watchMode` tasks once when runtime config is first applied.
3. Trigger watch-event sync by enqueueing (not direct execution).
4. Enforce runtime sync max concurrency (`2`) for watch-mode runtime sync execution.
5. Emit queue state events to frontend so UI can show queued status.
6. While a task is syncing, coalesce additional watch-triggered sync requests as a pending flag and replay once after completion.
7. Serialize `runtime_set_config` application so overlapping updates resolve with last-write-wins semantics.
8. Always exclude macOS root metadata directories (`.fseventsd`, `.Spotlight-V100`, `.Trashes`, `.TemporaryItems`) from scan/sync candidate generation, regardless of user exclusion-set selection.

## Consequences

- Startup now performs initial watch-mode sync, improving consistency.
- Bursty watch events are absorbed by queue, reducing concurrent sync contention.
- Some syncs may start slightly later due to queueing.
- UI can represent `queued` state and improve user visibility.
- Watch events detected during an active sync are not lost; they are replayed once after the current sync finishes.
- Overlapping runtime config updates no longer race each other during watcher reconciliation.
- System-managed metadata directories are never copied or listed as orphan candidates, reducing noisy watch-driven changes and preventing non-user data replication.

## Alternatives Considered

1. Unlimited watch-triggered parallel sync
   - Rejected: unstable under event bursts and many tasks.
2. Single global sync worker (concurrency 1)
   - Rejected: too conservative for common multi-volume setups.
3. Frontend-only queue control
   - Rejected: backend runtime can trigger sync independent of view lifecycle; backend enforcement is required.
