# ADR-20260211-0003: Sync task target conflict policy and orphan cleanup workflow

- Status: Accepted
- Date: 2026-02-11
- Tags: sync-task, safety, watch-mode, cleanup, macos
- TL;DR: Remove automatic target-side deletion, enforce target path conflict constraints, and replace deletion with explicit orphan scan and confirmed manual cleanup.

## Context

- `deleteMissing` enabled destructive behavior during sync runs.
- Multiple tasks can point to different sources, but target overlap can cause overwrite and cleanup conflicts.
- Watch mode plus overlapping source/target relationships can introduce sync loops.
- Users need visibility and control over target-only files before deletion.

## Decision

1. Remove `deleteMissing` from SyncTask/runtime/CLI and disable automatic target-side deletion in sync runs.
2. Add runtime task path validation and block conflicting configurations:
   - Different sources are allowed.
   - Targets must be unique across tasks.
   - Targets cannot be parent/child of each other.
   - Within a task, source/target overlap (same path or parent/child) is forbidden.
   - For watch-enabled tasks, every other task target must not overlap that watch source.
3. Introduce orphan workflow:
   - Scan and list entries that exist only in target (respecting exclusion patterns).
   - Show results as a directory tree.
   - Start with no selection.
   - Support parent-to-children selection, toggle selection, and select-all/clear-all.
   - Require explicit confirmation before deletion.

## Consequences

- Backward incompatible for users relying on automatic deletion behavior.
- Safer default behavior with explicit user confirmation for destructive actions.
- Additional runtime validation can reject previously accepted task sets.
- Operational flow adds one manual step for target cleanup.

## Alternatives Considered

1. Keep `deleteMissing` with extra warnings
   - Rejected: warnings do not prevent accidental destructive runs.
2. Keep conflict checks only in frontend
   - Rejected: runtime-only paths and external edits still require backend enforcement.
3. Detect and allow watch-chain configurations with cycle-only checks
   - Rejected: broader overlap block is clearer and safer for initial rollout.
