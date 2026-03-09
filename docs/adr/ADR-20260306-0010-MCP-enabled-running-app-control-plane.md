# ADR-20260306-0010-MCP: Enabled-only MCP relay for a running-app control plane
- Status: Accepted
- Date: 2026-03-06
- Tags: mcp, control-plane, config-store, runtime, tauri, macos
- TL;DR: Expose a local stdio MCP relay only when the user explicitly enables MCP in SyncWatcher settings, and route all MCP actions through the running app backend over a Unix socket with backend-owned canonical config.

## Context

- SyncWatcher already has a running Tauri backend that owns sync execution, watch runtime, runtime events, and frontend progress updates.
- The frontend previously owned too much configuration state through `localStorage` and raw YAML access, which makes external control paths hard to keep consistent.
- MCP support must not auto-launch the app. The user must explicitly opt in, and SyncWatcher must remain inert unless the app is already running.
- We need an AI-facing control surface for:
  - settings read/update
  - sync task create/update/delete/read/list
  - dry-run, sync, orphan scan
  - removable-volume listing
  - runtime state and job polling
- Existing safety decisions in prior ADRs must remain in force for MCP-triggered operations:
  - overlap validation
  - one-way sync behavior
  - explicit orphan workflow
  - conflict review flow
  - runtime watch queue and concurrency limits
  - zero-copy auto-unmount confirmation rules

## Decision

1. Keep the running SyncWatcher app backend as the only execution owner.
   - MCP does not run sync logic directly.
   - All sync, dry-run, orphan scan, settings writes, and sync-task writes execute inside the running Tauri backend.
2. Add an explicit persistent setting `mcpEnabled`, default `false`.
   - The local control plane only listens when `mcpEnabled=true`.
   - SyncWatcher never auto-launches for MCP, not in v1 and not in any future mode under this ADR.
   - If the app is not running, MCP requests fail with an actionable error instead of launching anything.
3. Use a local Unix domain socket control plane under the app support directory.
   - The socket path is derived from bundle identifier `dev.studiojin.syncwatcher`.
   - The stdio binary `syncwatcher-mcp` is a thin relay from MCP tool calls to that socket.
   - The relay performs no sync-engine work and holds no canonical state.
4. Move canonical config ownership to the Rust backend.
   - `settings.yaml`, `tasks.yaml`, and `exclusion_sets.yaml` are the canonical stores.
   - The backend validates, persists, reloads, and applies config.
   - The frontend becomes a consumer that reloads from backend commands and `config-store-changed` events.
5. Reuse the existing event pipeline for frontend progress/state sync.
   - Backend sync execution continues to emit `sync-progress`, `runtime-*`, and `conflict-*` events.
   - MCP clients do not subscribe to Tauri events; they poll `syncwatcher_get_job`.
6. Add backend-owned MCP job tracking for long-running operations.
   - `syncwatcher_start_sync`, `syncwatcher_start_dry_run`, and `syncwatcher_start_orphan_scan` return `jobId`.
   - `syncwatcher_get_job` and `syncwatcher_cancel_job` are the only MCP interfaces for long-running job control.
   - MCP job identity is separate from the UI’s existing task-scoped cancel map.
7. Restrict v1 MCP scope.
   - Expose only:
     - `syncwatcher_get_settings`
     - `syncwatcher_update_settings`
     - `syncwatcher_list_sync_tasks`
     - `syncwatcher_get_sync_task`
     - `syncwatcher_create_sync_task`
     - `syncwatcher_update_sync_task`
     - `syncwatcher_delete_sync_task`
     - `syncwatcher_start_dry_run`
     - `syncwatcher_start_sync`
     - `syncwatcher_start_orphan_scan`
     - `syncwatcher_get_job`
     - `syncwatcher_cancel_job`
     - `syncwatcher_get_runtime_state`
     - `syncwatcher_list_removable_volumes`
   - Writable MCP settings are limited to:
     - `language`
     - `theme`
     - `dataUnitSystem`
     - `notifications`
     - `closeAction`
     - `mcpEnabled`
   - `isRegistered` is read-only.
   - `stateLocation` and `maxLogLines` are excluded from MCP v1.
   - Orphan deletion, conflict resolution, direct unmount control, license actions, and app auto-launch are excluded from MCP v1.

## Consequences

- The backend now has a single canonical configuration path that both the UI and MCP use, reducing drift between control surfaces.
- MCP-triggered sync operations reuse the same validation and runtime/event flow as UI-triggered operations, so existing safety behavior remains aligned.
- Frontend runtime progress stays real-time without a separate MCP event bridge because the app backend still emits the same Tauri events.
- MCP can only work when the user explicitly enables it and keeps the app running, which reduces surprise activation and background exposure.
- The relay remains small and replaceable because it only translates stdio MCP calls into local socket RPC.
- Because MCP clients poll jobs instead of receiving push events, external clients get simpler integration at the cost of polling latency.

## Alternatives Considered

1. Run sync logic directly inside the MCP relay
   - Rejected: would duplicate backend execution logic, bypass existing event flow, and create ownership drift.
2. Auto-launch SyncWatcher when the relay is invoked
   - Rejected: violates explicit opt-in and makes local AI control less predictable from a user-consent standpoint.
3. Let the frontend remain the primary config owner
   - Rejected: external control paths need the backend to be authoritative for validation, persistence, and runtime application.
4. Expose the control plane over HTTP
   - Rejected: a local Unix socket is narrower in scope and better matches a manually running desktop app.
