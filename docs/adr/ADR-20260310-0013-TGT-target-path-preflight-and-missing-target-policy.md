# ADR-20260310-0013-TGT: Target path preflight and missing-target policy

Status: Accepted
Date: 2026-03-10
Tags: sync-task, target-path, dry-run, reliability, ux, macos, tauri
TL;DR: Classify missing target paths before dry-run and sync, fail fast for unmounted target volumes, and treat missing mounted subdirectories as create-on-sync with explicit user-facing warnings.

## Context

- SyncWatcher currently treats a missing target path as an empty target during directory comparison.
- That behavior makes `dry-run` show every source file as `New` with no target size even when the configured target volume is simply not mounted.
- In real usage this is misleading because a typo or stale mount path looks like a valid preview instead of a configuration/runtime error.
- Users still need a safe path for legitimate cases where the volume is mounted but the target subdirectory has not been created yet.
- The backend and frontend need one shared interpretation so manual sync, watch sync, MCP sync, and dry-run report the same state.

## Decision

1. Add a backend target-path preflight step before dry-run and sync execution.
2. Interpret target paths with these rules:
   - If the target path exists and is a directory, continue normally.
   - If the target path is under `/Volumes/<name>/...` and the mount root `/Volumes/<name>` is not currently mounted, fail immediately.
   - If the mount root exists but the target subdirectory does not, classify it as creatable.
   - If the target path is outside `/Volumes` and does not exist, classify it as creatable.
3. Dry-run behavior for creatable targets:
   - Do not create the directory.
   - Return structured preflight metadata so the UI can explain that the preview is treating the target as empty.
4. Sync behavior for creatable targets:
   - Create the missing directory before comparison/copy.
   - Return structured preflight metadata indicating that the directory was created.
5. Expose structured response metadata in both dry-run and sync results:
   - `targetPreflight.kind = ready | willCreateDirectory | createdDirectory`
   - `targetPreflight.path = <resolved target path>`
6. Keep diff classification logic unchanged. The change is only in how missing targets are interpreted before comparison begins.

## Consequences

- Positive
  - Misconfigured or unmounted target volumes fail fast instead of producing misleading all-`New` dry-run output.
  - Valid "directory does not exist yet" workflows still work without forcing users to pre-create folders manually.
  - Frontend can explain why `New` and blank target size appear in dry-run results.
  - Manual sync, watch sync, and MCP sync now share the same target-path policy.
- Trade-offs
  - Sync now depends on a target preflight stage before work starts.
  - API payloads for dry-run and sync gain one additional structured field.

## Alternatives Considered

1. Keep treating every missing target as empty
   - Rejected: hides unmounted-volume mistakes and misleads dry-run output.
2. Fail for every missing target path, including normal directories outside `/Volumes`
   - Rejected: makes legitimate first-run backup workflows unnecessarily strict.
3. Auto-create missing target directories during dry-run
   - Rejected: dry-run should remain non-mutating for repo-tracked and user data paths.
