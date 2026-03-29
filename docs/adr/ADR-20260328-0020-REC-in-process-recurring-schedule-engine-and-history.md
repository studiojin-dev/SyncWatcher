# ADR-20260328-0020-REC: In-process recurring schedule engine and file-backed history
Status: Accepted
Date: 2026-03-28
Tags: recurring-schedules, runtime, cron, timezone, history, config-store, tauri
TL;DR: Store recurring schedules inside each sync task, execute them only while the running app process is alive, and persist per-schedule run history as separate files under app support state.

## Context

- SyncWatcher already owns sync execution, watch runtime, config persistence, conflict review, and lifecycle behavior inside the running Tauri backend.
- Users need multiple recurring schedules per sync task, with per-schedule checksum behavior, explicit timezone selection, enable/disable controls, and recent run history.
- The app already distinguishes between:
  - fully exited
  - running in the foreground
  - running in the background or tray
- We must keep recurring execution aligned with the existing runtime ownership model and avoid introducing hidden system-level launch behavior.
- Existing config is YAML-backed and must stay backward-compatible for users whose `tasks.yaml` has no recurring schedule data yet.

## Decision

1. Store recurring schedules on each `SyncTask`.
   - `SyncTask` and `SyncTaskRecord` gain `recurringSchedules: RecurringSchedule[]`.
   - Each schedule stores:
     - `id`
     - `cronExpression`
     - `timezone`
     - `enabled`
     - `checksumMode`
     - `retentionCount`
   - Missing `recurringSchedules` defaults to `[]` so existing `tasks.yaml` files continue to load without migration.
2. Use canonical POSIX 5-field cron strings for persistence.
   - Stored format is `minute hour day month weekday`.
   - Backend validation normalizes whitespace and rejects non-5-field input.
   - Runtime may adapt the stored string to library-specific parsing requirements internally, but persisted data stays 5-field.
3. Require an explicit timezone per recurring schedule.
   - Timezone is stored as an IANA timezone name.
   - New schedules default to the current system timezone in the UI.
4. Execute recurring schedules only inside the running SyncWatcher process.
   - The scheduler lives in the backend runtime loop.
   - Background and tray modes count as running.
   - A fully exited app process does not run schedules.
   - Missed executions during full exit are skipped and are not backfilled after restart.
5. Reuse the existing sync execution pipeline for scheduled runs.
   - Scheduled runs call the same internal sync execution path as manual runs.
   - Task source, target, exclusion sets, and post-copy verification inherit from the owning sync task.
   - `checksumMode` is overridden by the recurring schedule.
   - Busy-task conditions still fail fast rather than queueing another sync, and that failure is recorded in schedule history.
6. Persist recurring run history outside config files.
   - History is not stored in `tasks.yaml`.
   - Each schedule writes to its own file under app support state:
     - `state/recurring-history/<task-id>/<schedule-id>.yaml`
   - Stored entries include:
     - `scheduledFor`
     - `startedAt`
     - `finishedAt`
     - `status`
     - `checksumMode`
     - `cronExpression`
     - `timezone`
     - `message`
     - `errorDetail`
     - `conflictCount`
   - Writes are atomic and truncated to the schedule’s `retentionCount`.
   - Deleting a schedule deletes its history file.
   - Deleting all recurring schedules for a task deletes that task’s recurring-history directory.
7. Keep recurring history state separate from `settings.stateLocation`.
   - This ADR does not redefine `settings.stateLocation`.
   - Recurring history uses the existing app support directory’s state subtree to stay backend-owned and lifecycle-consistent.

## Consequences

- Recurring execution follows the same trust boundary as watch sync and manual sync: the running backend is the only execution owner.
- The product behavior is predictable:
  - background/tray execution continues
  - fully exited execution does not
  - no surprise replay occurs after restart
- Per-schedule checksum mode allows different integrity/cost trade-offs without duplicating whole sync tasks.
- File-backed per-schedule history keeps config files small and avoids mixing operational logs with canonical task configuration.
- Users can inspect failures with detailed error text and clear history without touching the canonical task config.
- The scheduler remains process-local, which avoids:
  - OS launch agents
  - cron installation
  - separate daemons
  - hidden background services

## Alternatives Considered

1. Use a system scheduler such as `launchd` or cron
   - Rejected: would add OS-managed behavior outside the running app lifecycle, complicate install/update/remove behavior, and violate the product rule that recurring sync only runs while SyncWatcher itself is alive.
2. Backfill missed runs after restart
   - Rejected: makes execution less predictable, can surprise users with delayed bursts of sync activity, and complicates conflict/busy handling.
3. Store recurring history inside `tasks.yaml`
   - Rejected: mixes operational state with canonical task configuration, increases churn in task files, and makes retention/manual-clear behavior noisy.
4. Store recurring schedules as a separate top-level config collection
   - Rejected: users reason about schedules as properties of sync tasks, and schedule inheritance from a sync task is clearer when co-located with that task definition.
5. Extend `settings.stateLocation` to control recurring-history placement
   - Rejected for now: broadens the meaning of that setting and introduces a separate migration/ownership decision not required for the current feature.
