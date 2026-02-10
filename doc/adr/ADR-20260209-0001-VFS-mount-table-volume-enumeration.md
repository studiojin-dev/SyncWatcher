# ADR-20260209-0001: Dashboard volume source of truth

- Status: Accepted
- Date: 2026-02-09
- Tags: dashboard, storage, macos, volume-discovery, units
- TL;DR: Stop scanning `/Volumes`; use `getmntinfo_r_np` as source of truth, and apply a single app-wide capacity unit policy (default binary/IEC).

## Context

- The previous `/Volumes` scan mixed non-mount entries (symlinks/helper paths), causing incorrect cards.
- Network volumes should appear in the list, but capacity may be unavailable.
- Sync Tasks removable-volume flow must remain stable.
- Capacity strings across Volumes, Sync Tasks, and sync logs diverged because decimal and binary units were mixed.

## Decision

1. Enumerate volumes only from macOS mount table (`getmntinfo_r_np`).
2. Keep user-visible mounts only.
   - Include: `/`, browsable `/Volumes/*`
   - Exclude: `.timemachine`, non-browsable/system-helper paths
3. Model capacity as nullable.
   - Local mounts: set `total_bytes`, `available_bytes`
   - Network mounts: set both to `null`, show N/A in UI
4. Keep command names (`list_volumes`, `get_removable_volumes`) and mark `is_network` explicitly.
5. Apply one app-wide data unit setting (`dataUnitSystem`).
   - Default: `binary`
   - Binary labels: `KiB/MiB/GiB`
   - Decimal labels: `KB/MB/GB`
   - Network capacity remains unavailable (`N/A`)

## Consequences

- Dashboard accuracy improves; duplicate/ghost cards are removed.
- Network mounts are explicit instead of fake zero-capacity values.
- Backend (`Option<u64>`, `is_network`) and frontend types must stay aligned.
- macOS flag dependency (`MNT_LOCAL`, `MNT_DONTBROWSE`) is explicit.
- Capacity values in UI and logs stay consistent under the same unit policy.

## Alternatives Considered

1. Keep `/Volumes` scan and add filters
   - Rejected: still non-canonical and fragile
2. Use `diskutil list`
   - Rejected: includes duplicate/non-user-visible entries; inefficient for periodic refresh
