# ADR-20260327-0019-WAC: Runtime watch activation re-enqueues initial sync
Status: Accepted
Date: 2026-03-27
Tags: runtime, watch-mode, uuid-source, reliability, tauri, macos
TL;DR: After the first runtime bootstrap, any watch task that newly activates or restarts must enqueue one initial sync so existing diffs are not stranded until the next filesystem event.

## Context

- ADR-20260215-0004 introduced a one-time initial queue for all `watchMode` tasks when runtime config is first applied.
- That policy is sufficient only for tasks that already exist and are watch-enabled at runtime bootstrap.
- In real workflows, a watch task may start later because:
  - the user enables `watchMode` after the app is already running,
  - the user edits the source path,
  - or a UUID-backed source becomes watchable again after mount resolution succeeds.
- In those cases the backend previously started the watcher, but it did not enqueue an initial sync.
- Result: `dry-run` could show pending differences while automatic copy stayed idle until a brand new filesystem event occurred.

## Decision

1. Keep the existing one-time runtime bootstrap queue from ADR-20260215-0004.
2. Extend runtime watcher reconciliation so a task also receives one initial sync when:
   - a runtime-managed watcher is newly started, or
   - a runtime-managed watcher is restarted because its source changed.
3. Do not enqueue this reactivation bootstrap when the task is already syncing, queued, or pending replay.
4. Preserve existing UUID resolution behavior:
   - watcher startup still resolves UUID-backed source paths before registering OS watches,
   - sync execution still resolves UUID-backed paths at execution time.
5. Keep public commands, config shape, and runtime/frontend event payloads unchanged.

## Consequences

### Benefits

- UUID-backed removable-media tasks can catch up immediately when the watcher becomes active again.
- Turning on `watchMode` now behaves closer to user expectation: existing differences are copied once without waiting for another edit.
- The runtime keeps a single queue path for both first bootstrap and reactivation bootstrap, so concurrency and coalescing rules stay consistent.

### Trade-offs

- A watcher restart caused by source edits now has an eager sync side effect instead of waiting for a later file event.
- Reconciliation becomes slightly more stateful because it must distinguish newly started or restarted watchers from unchanged watchers.

## Alternatives Considered

1. Keep initial sync only at first runtime bootstrap
   - Rejected: leaves later watch activations with stale existing diffs until a new filesystem event arrives.
2. Trigger reactivation sync only for UUID-backed sources
   - Rejected: the behavior gap exists for any watch task activated after bootstrap, not only UUID sources.
3. Trigger reactivation sync even while queued or syncing
   - Rejected: duplicates existing queue/pending semantics and increases unnecessary replay work.
