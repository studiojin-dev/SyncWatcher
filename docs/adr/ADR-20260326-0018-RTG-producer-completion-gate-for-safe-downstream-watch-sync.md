# ADR-20260326-0018-RTG: Producer completion gate for safe downstream watch sync
Tags: runtime, watch-mode, sync-task, reliability, tauri, macos
Status: Accepted
Date: 2026-03-26
TL;DR: Allow acyclic watch chains, but delay downstream watch sync until every overlapping writer succeeds and a short settle window has elapsed.

## Context

Watch-mode validation previously rejected any configuration where another task target overlapped a watched source.
That broad rule prevented real sync loops, but it also blocked safe one-way chains such as removable media ingest into an intermediate directory followed by a second watch-based sync into NAS storage.

Allowing one-way chains without extra runtime coordination is unsafe.
If a preceding write operation emits file-system events while it is still copying data, a downstream watch task can start too early and read partial files.
This race exists for watch-origin syncs, manual syncs triggered from UI or MCP, and conflict-resolution actions that overwrite target files.

## Decision

We will split the solution into validation-time topology checks and runtime producer gating.

### Validation

- Keep rejecting source/target overlap inside a single task.
- Keep rejecting overlapping task targets across tasks.
- Replace the blanket watch-source/other-target overlap rejection with watch-only cycle detection.
- A runtime config is rejected only when watch-enabled tasks form an actual cycle.

### Runtime gating

- Treat every target-writing operation as a producer, regardless of watch mode.
- Producers include watch sync, manual sync, force-copy conflict resolution, and rename-then-copy conflict resolution.
- A queued watch task may run only when:
  - no upstream watch task that feeds its source is still queued or syncing,
  - no active producer writes into an overlapping path,
  - and the downstream settle deadline has elapsed.

### Completion rule

- A producer releases downstream watch tasks only after successful completion.
- Failure or cancellation clears queued downstream watch runs caused by that producer's writes instead of auto-releasing them.
- Successful completion sets a 500ms settle window for overlapping watched sources so late file-system events are absorbed before downstream dispatch.

## Consequences

### Benefits

- One-way watch chains are allowed without reopening partial-file races.
- Manual sync and conflict-resolution writes now follow the same downstream safety rule as watch-origin sync.
- The runtime keeps the existing global concurrency limit while preserving chain ordering.

### Trade-offs

- Dispatch logic becomes path-aware and more stateful because it must track active writers and settle deadlines.
- Failed producers do not automatically replay downstream watch work; users need a later successful write or a fresh watch event to trigger downstream sync.

### Follow-up constraints

- Any future code path that writes into a task target must register as a producer before it performs filesystem mutations.
- Any future feature or refactor that adds target-side writes MUST be reviewed together with producer-helper coverage so the new write path cannot bypass downstream watch gating.
- If future evidence shows 500ms settle is insufficient on some filesystems, a later ADR may add file-level stability checks.
