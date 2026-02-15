# ADR-20260215-0004: Runtime watch-mode initial sync queue and concurrency limit

- Status: Accepted
- Date: 2026-02-15
- Tags: sync-task, watch-mode, runtime, concurrency, reliability, macos
- TL;DR: On runtime initialization, enqueue watch-mode tasks for initial sync and execute through a bounded queue with max parallelism 2.

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

## Consequences

- Startup now performs initial watch-mode sync, improving consistency.
- Bursty watch events are absorbed by queue, reducing concurrent sync contention.
- Some syncs may start slightly later due to queueing.
- UI can represent `queued` state and improve user visibility.

## Alternatives Considered

1. Unlimited watch-triggered parallel sync
   - Rejected: unstable under event bursts and many tasks.
2. Single global sync worker (concurrency 1)
   - Rejected: too conservative for common multi-volume setups.
3. Frontend-only queue control
   - Rejected: backend runtime can trigger sync independent of view lifecycle; backend enforcement is required.
