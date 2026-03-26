# ADR-20260211-0003-STG: Sync task target conflict policy, UUID runtime validation, and orphan cleanup workflow
Status: Accepted
Date: 2026-02-11
Tags: sync-task, safety, watch-mode, cleanup, macos
TL;DR: Remove automatic target-side deletion, enforce source/target overlap constraints at runtime (including UUID sources), and replace deletion with explicit orphan scan and confirmed manual cleanup.

## Context

- `deleteMissing` enabled destructive behavior during sync runs.
- Multiple tasks can point to different sources, but target overlap can cause overwrite and cleanup conflicts.
- Watch mode plus overlapping source/target relationships can introduce sync loops.
- Users need visibility and control over target-only files before deletion.
- UUID token sources may be saved while media is unmounted, so execution-time validation is required to prevent ambiguous or escaped paths.

## Decision

1. Remove `deleteMissing` from SyncTask/runtime/CLI and disable automatic target-side deletion in sync runs.
2. Add runtime task path validation and block conflicting configurations:
   - Different sources are allowed.
   - Targets must be unique across tasks.
   - Targets cannot be parent/child of each other.
   - Within a task, source/target overlap (same path or parent/child) is forbidden.
   - For watch-enabled tasks, every other task target must not overlap that watch source.
3. Enforce execution-time path safety for sync/dry-run/orphan flows:
   - Resolve UUID token sources to mounted volume roots at execution time.
   - Reject malformed UUID tokens and UUID subpaths that escape volume root (e.g. parent traversal).
   - Keep save-time behavior permissive for valid-but-currently-unmounted UUID tokens.
   - Block sync/dry-run/orphan execution when resolved source and target overlap (same path or parent/child).
4. Support explicit dry-run cancellation:
   - Track dry-run cancellation tokens separately from sync tokens.
   - Route cancel requests by operation kind (`sync` vs `dryRun`) to avoid cross-cancel mistakes.
5. Introduce orphan workflow:
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
- UUID tasks remain savable while unmounted, but execution now fails fast when runtime safety checks fail.

## Alternatives Considered

1. Keep `deleteMissing` with extra warnings
   - Rejected: warnings do not prevent accidental destructive runs.
2. Keep conflict checks only in frontend
   - Rejected: runtime-only paths and external edits still require backend enforcement.
3. Detect and allow watch-chain configurations with cycle-only checks
   - Rejected: broader overlap block is clearer and safer for initial rollout.
4. Resolve UUID token paths only at save time
   - Rejected: removable volumes can be unmounted at save time, so execution-time enforcement is required.
