# ADR-20260414-0027-NMT: SyncTask SMB auto-mount and Keychain credentials

Status: Accepted
Date: 2026-04-14
Tags: sync-task, smb, network-mount, keychain, macos, tauri, sandbox
TL;DR: Persist SMB remount metadata on SyncTasks, store passwords only in macOS Keychain, and attempt SMB auto-mount before sync and dry-run when a configured network path is not currently mounted.

## Context

- SyncWatcher already fails fast for unmounted target volumes and unresolved UUID sources at execution time.
- That behavior is correct for safety, but it still leaves a bad workflow for SMB shares that users intentionally configured as SyncTask source or target.
- The Mac App Store build already relies on security-scoped bookmarks, but bookmarks alone do not provide a complete SMB remount contract or password lifecycle.
- Storing passwords in `syncTasks.yml` would violate the project security model and create cross-channel risk.
- The sync, dry-run, and watch/runtime flows need one shared policy so network shares do not behave differently depending on the entrypoint.

## Decision

1. Add optional `sourceNetworkMount` and `targetNetworkMount` metadata to SyncTasks.
   - Fields: `scheme`, `remountUrl`, `username`, `mountRootPath`, `relativePathFromMountRoot`, `enabled`
   - v1 supports `scheme=smb` only.
2. Capture SMB remount metadata only from currently mounted user-selected paths.
   - Use `NSURLVolumeURLForRemountingKey` to extract the remount URL.
   - Derive the mounted share root and store the relative subpath beneath that root.
3. Store SMB passwords only in macOS Keychain.
   - Key: `taskId + role(source|target)`
   - Service namespace is app-owned and not written to config files.
4. Attempt SMB auto-mount before sync and dry-run path resolution.
   - Sequence: activate sandbox/bookmark access -> if requested path is missing and matching SMB metadata exists -> mount via `NetFSMountURLSync` -> reconstruct final path from mount root + relative subpath -> continue with existing validation/preflight.
5. Keep existing fail-fast behavior when auto-mount is not configured or the mount attempt fails.
   - Error categories should distinguish authentication, share-not-found, unsupported scheme, user-cancelled, and generic mount failure.
6. Apply the same SMB auto-mount policy to both GitHub DMG and Mac App Store channels.
7. Allow system authentication UI during manual, dry-run, watch, and background runtime execution when Keychain does not already satisfy the mount request.

## Consequences

- Positive
  - Users can save SMB-backed SyncTasks once and run them again without manually remounting the share first.
  - Passwords stay out of SyncWatcher config files and remain in platform-managed secure storage.
  - Sync and dry-run now share the same network-mount recovery behavior.
- Trade-offs
  - SyncTask persistence now includes network mount metadata in addition to plain path/bookmark fields.
  - Background/watch execution may trigger system authentication UI because unattended remounts are explicitly allowed in v1.
  - App Store and direct-download builds now depend on both sandbox/bookmark access and Keychain/network mount state for SMB tasks.

## Alternatives Considered

1. Keep fail-fast only and require users to remount SMB shares manually every time
   - Rejected: safe but too repetitive for the intended recurring SyncTask workflow.
2. Store SMB passwords in `syncTasks.yml`
   - Rejected: unacceptable secret handling and unnecessary config exposure.
3. Limit SMB auto-mount to the GitHub DMG channel
   - Rejected: channel-specific behavior would make SyncTasks inconsistent and complicate support/documentation.
4. Allow only manual sync to show auth UI
   - Rejected: runtime/watch flows would still fail unexpectedly for otherwise valid SMB tasks.
