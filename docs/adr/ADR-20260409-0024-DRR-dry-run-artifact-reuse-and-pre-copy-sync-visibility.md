# ADR-20260409-0024-DRR: Dry-run artifact reuse and pre-copy sync visibility
Tags: dry-run, sync, ux, runtime, tauri, reliability
Status: Accepted
Date: 2026-04-09
TL;DR: Store one backend-owned dry-run artifact per task, allow `Sync Now` to reuse that artifact after a light freshness check, and expose scan/compare progress in manual sync before copying starts.

## Context

- Dry Run already has a task-scoped live/result view, but users cannot tell whether manual sync is still planning work before copying begins because the screen stays visually static during scan/compare.
- Users also want to move directly from a successful Dry Run result into a real sync without recomputing the entire UI-side session state.
- Reusing large dry-run manifests through frontend state or Tauri event payloads is undesirable because those events are not the right transport for large ordered data streams.
- A full manifest revalidation would reduce stale-result risk further, but the chosen default is a lighter check to keep the feature responsive and implementation scope bounded.

## Decision

1. Store one ephemeral dry-run artifact per task inside the running backend.
   - The artifact contains the dry-run result, target-newer conflict candidates, the task config snapshot used for the run, root snapshots, and per-candidate metadata snapshots.
   - Starting a new dry-run clears the previous artifact for that task.
   - Updating or deleting a task clears its artifact.
   - Artifacts are memory-only and reset when the app restarts.
2. Add `start_sync_from_dry_run(taskId)` for manual UI reuse.
   - The command loads the current task from config, looks up the latest artifact for that task, and reuses the stored diff/conflict plan instead of rebuilding it from scratch.
3. Apply a light freshness check before reusing a dry-run artifact.
   - Require the current task source, target, checksum mode, and resolved exclusion patterns to match the dry-run snapshot.
   - Require the current canonical source root and current target root snapshot to match the dry-run snapshot.
   - Re-check only the dry-run diff candidates and target-newer conflict candidate paths for metadata changes (existence, size, modified time).
   - If any check fails, abort with a stale-result error and require a new Dry Run.
   - Changes that happen after Dry Run outside those previously identified diff/conflict candidate paths are intentionally out of scope for this v1 freshness check and may be missed until the next full Dry Run.
4. Expose pre-copy manual sync progress through the existing sync progress channel.
   - Manual sync emits `scanningSource`, `scanningTarget`, and `comparing` before copy begins.
   - Dry-run reuse emits `validatingDryRun` before copy begins.
   - Copy execution emits `copying`.

## Consequences

- Users can see that manual sync is actively scanning or comparing even when no file has started copying yet.
- The Dry Run result view can offer `Sync Now` without trusting renderer-only state.
- Fresh manual sync no longer performs a hidden pre-copy planning phase; that work is visible in the UI.
- The light freshness check can still miss new filesystem changes that were not part of the original dry-run diff or conflict candidate set. This is an accepted accuracy trade-off for v1 of reuse, and users must run Dry Run again when they need full recomputation after unrelated filesystem activity.

## Alternatives Considered

1. Always recompute manual sync after Dry Run
   - Rejected because it does not provide the requested “reuse Dry Run result” workflow.
2. Store reusable dry-run state only in the frontend
   - Rejected because renderer state is not a reliable execution owner and should not carry the backend trust boundary for copy decisions.
3. Full manifest revalidation before `Sync Now`
   - Rejected for now because it increases implementation and runtime cost beyond the chosen scope. The lighter candidate-only validation is accepted with an explicit limitation.
