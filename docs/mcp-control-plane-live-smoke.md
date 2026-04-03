# MCP Control Plane Live Smoke

This document records the enabled-only MCP control-plane change set and the live smoke procedure that verifies the running-app path end to end.

Related ADR: [ADR-20260306-0010](./adr/ADR-20260306-0010-MCP-enabled-running-app-control-plane.md)

## 1) Purpose

- Record the operational shape of the enabled-only MCP control plane.
- Document the live smoke workflow for the running-app MCP path.
- Capture the latest successful end-to-end verification result in one place.

## 2) What changed

- SyncWatcher now exposes MCP only through a running app backend.
- MCP is disabled by default and only listens when `settings.mcpEnabled=true`.
- SyncWatcher never auto-launches for MCP.
- The Rust backend is the canonical owner of:
  - `settings.yaml`
  - `tasks.yaml`
  - `exclusion_sets.yaml`
- The main executable `syncwatcher --mcp-stdio` is a thin relay to the app-local Unix socket control plane.
- Long-running MCP operations now return `jobId` and are observed through `syncwatcher_get_job`.
- The frontend continues to receive progress and runtime state through the existing Tauri event pipeline.

## 3) Scope

The live smoke covers the running-app MCP path only.

- disabled MCP rejection
- enabled listener startup
- MCP tool discovery
- sync task create, list, get, delete
- `dry-run`
- orphan scan
- real sync
- job polling
- runtime state cleanup after sync
- `mcpEnabled` disable cleanup

Out of scope for this smoke:

- `syncwatcher_update_sync_task`
- `syncwatcher_cancel_job`
- orphan deletion
- conflict resolution UI actions
- auto-launch behavior, which is intentionally unsupported

## 4) Prerequisites

- macOS
- a working local dev environment for `pnpm tauri dev`
- `node`, `pnpm`, `cargo`, and `mkfile`
- a user session that can launch the SyncWatcher app window

Operational constraints:

- SyncWatcher must already be running before MCP requests can succeed.
- MCP only works when `mcpEnabled=true`.
- SyncWatcher never auto-launches for MCP.

## 5) Smoke command

Use:

```bash
node scripts/live-mcp-smoke.mjs
```

Optional flags:

```bash
node scripts/live-mcp-smoke.mjs --payload-mib=512
node scripts/live-mcp-smoke.mjs --protocol-version=2025-06-18
node scripts/live-mcp-smoke.mjs --cleanup-artifacts
```

## 6) What the script verifies

The script:

- builds `syncwatcher`
- creates an isolated app-support directory under `/tmp`
- writes an isolated `settings.yaml`
- verifies the disabled error before app startup
- launches `pnpm tauri dev`
- enables MCP and waits for the Unix socket listener
- creates temp source and target fixtures
- executes `dry-run`, orphan scan, and real sync through MCP stdio mode
- validates copied file size and SHA-256 hash
- deletes the temp task
- disables MCP again and confirms the disabled error
- removes the isolated fixture and app-support directories

The script uses `/tmp` on purpose so the Unix socket path stays below macOS `sun_path` limits.

## 7) Artifacts

Each run writes a temporary artifact directory like:

```text
/tmp/syncwatcher-live-mcp-smoke-XXXXXX
```

Expected files:

- `report.json`
- `sync-running.png` if screenshot capture succeeds

The report records:

- phase-by-phase outcomes
- created task payload
- runtime state snapshots
- orphan scan and dry-run results
- sync result payload
- cleanup result

## 8) Last verified result

Verified on 2026-03-07 on macOS with:

```bash
node scripts/live-mcp-smoke.mjs
```

Observed result:

- disabled MCP returned the expected actionable `disabled` error
- enabled MCP created the Unix socket listener successfully
- `tools/list` exposed 14 expected tools
- temp task create, list, get, and delete succeeded
- `dry-run` reported `notes.txt` and `payload.bin` while excluding `.DS_Store`
- orphan scan reported `orphan.txt`
- real sync completed with:
  - `hasPendingConflicts=false`
  - `conflictSessionId=null`
  - `files_copied=2`
  - `bytes_copied=536870964`
- copied payload hash matched source hash
- post-sync runtime state had empty `syncingTasks` and `queuedTasks`
- cleanup removed the isolated fixture and isolated app-support directory

Artifacts from the verified run:

- report: `/tmp/syncwatcher-live-mcp-smoke-bDLrLs/report.json`
- screenshot: `/tmp/syncwatcher-live-mcp-smoke-bDLrLs/sync-running.png`

## 9) Known constraints

- The MCP stdio transport used by `rmcp` `transport-io` is newline-delimited JSON, not LSP-style `Content-Length` framing.
- macOS screenshot capture may fail in restricted display/session environments. That does not invalidate the backend MCP smoke if the report phases succeed.
- The sync result currently uses backend field names as returned by the app backend. Consumers should not assume camelCase for nested sync-engine counters without checking the actual payload.

## 10) Troubleshooting

- `reason=disabled`
  - `mcpEnabled` is still `false` in the active app-support `settings.yaml`, or the app has already been shut down after cleanup.
- `reason=app_not_running`
  - MCP is enabled in settings, but the running SyncWatcher app listener is not up yet.
- `path must be shorter than SUN_LEN`
  - The Unix socket path is too long for macOS. Use a shorter app-support root such as `/tmp/...`.
- `Port 1420 is already in use`
  - A stale Vite dev server is still running. Stop it before restarting `pnpm tauri dev`.
- screenshot capture fails
  - Check macOS screen recording/display permissions. Report success still counts if all MCP phases complete and `report.json` is clean.
