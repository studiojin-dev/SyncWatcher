# ADR-20260326-0018-CHN: Watch chain cycle gating and downstream settle window
Status: Accepted
Date: 2026-03-26
Tags: sync-task, watch-mode, runtime, scheduling, reliability, macos
TL;DR: Allow acyclic watch chains, reject only true watch cycles, and delay downstream watch sync until upstream sync completes plus a short settle window.

## Context

- ADR-20260211-0003 blocked any overlap between another task target and a watch-enabled source.
- That broad rule prevented valid one-way pipelines such as `SD -> local ingest -> NAS`.
- Simply allowing one-way chains is unsafe because downstream watch sync could start from file events while upstream copy is still writing.
- ADR-20260215-0004 already introduced a runtime queue and replay-once semantics for watch mode, but it did not model upstream/downstream dependencies between watch tasks.

## Decision

1. Replace the broad watch overlap rejection with cycle detection over watch-enabled tasks only.
2. Build directed edges only when a watch task target overlaps another watch task source.
3. Reject runtime configs only when those edges form a cycle.
4. Keep existing non-watch safety checks:
   - same-task source/target overlap remains forbidden
   - cross-task target/target overlap remains forbidden
   - UUID normalization and execution-time path validation remain unchanged
5. Extend runtime scheduling so downstream watch tasks do not run while any upstream watch task in the chain is queued or syncing.
6. After an upstream watch sync completes, apply a fixed 500ms settle window to its downstream watch tasks before they can run.
7. Continue to coalesce repeated watch triggers through the existing queue/pending model rather than enqueueing duplicate downstream runs.

## Consequences

- Previously rejected one-way watch chains are now valid.
- True autonomous sync loops are still rejected before runtime config is applied.
- Downstream tasks start slightly later because they wait for upstream completion and settle.
- Initial watch bootstrapping also respects chain order, preventing downstream tasks from racing ahead of upstream ingest.
- The runtime scheduler becomes dependency-aware, which adds internal state and tests but improves correctness for chained watch workflows.

## Alternatives Considered

1. Keep rejecting all watch-source/other-target overlap
   - Rejected: blocks valid one-way workflows without distinguishing cycles from chains.
2. Allow acyclic chains with no downstream delay
   - Rejected: downstream sync can observe partially copied files from upstream.
3. Add per-file stability polling before every downstream sync
   - Rejected: safer in theory, but more complex and slower than task-level completion plus a short settle window for the first iteration.
