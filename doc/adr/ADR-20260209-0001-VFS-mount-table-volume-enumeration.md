# ADR-20260209-0001-VFS: Dashboard volume enumeration uses macOS mount table

Tags: dashboard, storage, macos, volume-discovery
Status: Accepted
Date: 2026-02-09
TL;DR: Replace /Volumes directory scanning with getmntinfo_r_np mount-table enumeration and treat network mounts as capacity-unavailable.

## Context

Dashboard volume cards showed incorrect total and free space values.

Two root causes were identified:

1. Space values were previously vulnerable to stat field misuse (`f_bsize` vs allocation unit).
2. Enumerating `/Volumes` directly mixed actual mounts with non-mount entries (for example symlinks and Time Machine helper paths), causing misleading cards.

The product requirement is:

- show user-visible mounts on Dashboard,
- include network mounts in the list,
- do not calculate network capacity,
- keep removable-volume flow for Sync Tasks stable.

## Decision

1. Use macOS mount table enumeration via `getmntinfo_r_np` as the source of truth for mounted filesystems.
2. Keep only user-visible mounts:
   - include `/` and browsable `/Volumes/*` mounts,
   - exclude hidden/snapshot/system-helper paths such as `.timemachine` and non-browsable mounts.
3. Represent capacity as nullable fields:
   - local mounts: `total_bytes` and `available_bytes` are populated,
   - network mounts: both are `null` and UI shows a localized N/A label.
4. Keep Tauri command names unchanged (`list_volumes`, `get_removable_volumes`) and mark network mounts explicitly with `is_network`.

## Consequences

### Positive

- Dashboard data aligns with real mounted filesystems.
- False/duplicate cards from `/Volumes` directory artifacts are removed.
- UI can explicitly represent network mounts without fake zero capacity values.
- Sync task volume selection remains compatible with removable/local media workflows.

### Trade-offs

- Backend model changes (`Option<u64>` for capacity and `is_network` flag) require coordinated frontend type updates.
- The logic depends on macOS mount flags (`MNT_LOCAL`, `MNT_DONTBROWSE`), so platform specificity is explicit.
- Network shares now appear in Dashboard but cannot provide capacity-based progress metrics.

## Alternatives considered

1. Keep `/Volumes` scan and add ad-hoc filtering.
   - Rejected: still not a canonical mount source and fragile against future edge cases.
2. Use `diskutil list` as primary source.
   - Rejected: includes duplicate/non-user-facing entries and is less suitable for fast periodic refresh.
