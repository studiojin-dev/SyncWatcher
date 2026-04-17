# MCP Control Guide

SyncWatcher includes a local MCP control surface for clients that want to inspect or control the running app.

This guide describes what the MCP relay does, what it exposes, and what it intentionally does not expose.

## How MCP Works

SyncWatcher does not run sync logic directly inside the MCP relay.

Instead, the installed `syncwatcher` executable can be launched with:

```bash
syncwatcher --mcp-stdio --mcp-token <token>
```

That stdio process is a thin relay. It forwards MCP tool calls to the already running SyncWatcher app over a local Unix socket.

Important behavior:

- MCP is disabled by default.
- The app must already be running.
- SyncWatcher generates and persists an MCP auth token automatically when the app runs and no token exists yet.
- SyncWatcher never auto-launches itself for MCP.
- The running app backend remains the single owner of sync execution, runtime state, and config persistence.
- Every MCP request must include the current token. If you regenerate the token in SyncWatcher, old client configs stop working immediately.

## Before You Connect

1. Launch SyncWatcher normally.
2. Open `Settings`.
3. Turn on `Enable MCP Control`.
4. Copy the MCP client config example from `Settings` or `Help -> MCP Control`.
5. Point your MCP client at the installed SyncWatcher executable.
6. Pass both `--mcp-stdio` and `--mcp-token <current token>`.

If MCP is disabled, tool calls fail with an actionable error that tells the client to enable MCP Control first.

If MCP is enabled but the app is not running, tool calls fail with an actionable error that tells the client to launch the app manually.

## Exposed Tools

SyncWatcher MCP v1 exposes 14 tools.

### Settings

- `syncwatcher_get_settings`
- `syncwatcher_update_settings`

Writable settings are intentionally limited to:

- `language`
- `theme`
- `dataUnitSystem`
- `notifications`
- `closeAction`
- `mcpEnabled`

Read-only fields such as `isRegistered` may still appear in the returned settings snapshot.

### SyncTask Management

- `syncwatcher_list_sync_tasks`
- `syncwatcher_get_sync_task`
- `syncwatcher_create_sync_task`
- `syncwatcher_update_sync_task`
- `syncwatcher_delete_sync_task`

Task payloads include the fields used by the app backend, including:

- name
- source
- target
- checksumMode
- verifyAfterCopy
- exclusionSets
- watchMode
- autoUnmount
- sourceType
- sourceUuid
- sourceUuidType
- sourceSubPath
- recurringSchedules

Task IDs are assigned by the backend during creation.

### Long-Running Actions

- `syncwatcher_start_dry_run`
- `syncwatcher_start_sync`
- `syncwatcher_start_orphan_scan`

These tools return a `jobId` instead of blocking until completion.

### Job Control

- `syncwatcher_get_job`
- `syncwatcher_cancel_job`

`syncwatcher_get_job` returns:

- `jobId`
- `kind`
- `taskId`
- `status`
- `progress`
- `result`
- `error`
- `createdAtUnixMs`
- `updatedAtUnixMs`

Job status values are:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

### Runtime And Environment

- `syncwatcher_get_runtime_state`
- `syncwatcher_list_removable_volumes`

`syncwatcher_get_runtime_state` reports:

- `watchingTasks`
- `syncingTasks`
- `queuedTasks`

`syncwatcher_list_removable_volumes` returns the removable volumes currently visible to the running app, including identity metadata such as path, capacity, UUID, serial, and bus protocol when available.

## Result Shapes

### Dry Run

Completed dry-run jobs return a result with:

- `diffs`
- `total_files`
- `files_to_copy`
- `files_modified`
- `bytes_to_copy`
- `targetPreflight`

Each diff entry includes:

- `path`
- `kind`
- `source_size`
- `target_size`
- `checksum_source`
- `checksum_target`

### Sync

Completed sync jobs return a result envelope with:

- `conflictCount`
- `conflictSessionId`
- `hasPendingConflicts`
- `syncResult`
- `targetPreflight`

The nested `syncResult` currently includes:

- `files_copied`
- `bytes_copied`
- `errors`

### Orphan Scan

Completed orphan-scan jobs return an array of orphan entries with:

- `path`
- `size`
- `is_dir`

## What MCP Does Not Expose

MCP v1 intentionally does not expose:

- orphan deletion
- conflict resolution actions
- direct unmount control
- license activation or license management actions
- app auto-launch
- writable `stateLocation`
- writable `maxLogLines`

This is intentional. MCP is meant to control the running app within a narrower trust boundary, not bypass the app's existing safety workflow.

## Operational Notes

- Long-running jobs should be polled through `syncwatcher_get_job`.
- The MCP relay is local only and uses stdio plus a local Unix socket.
- SyncWatcher UI and MCP share the same backend-owned config and runtime behavior, so MCP-triggered actions follow the same validation and safety constraints as UI-triggered actions.
