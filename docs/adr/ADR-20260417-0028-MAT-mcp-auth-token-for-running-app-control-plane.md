# ADR-20260417-0028-MAT: MCP auth token for the running-app control plane
Status: Accepted
Date: 2026-04-17
Tags: mcp, control-plane, auth, config-store, security, tauri, macos
TL;DR: Require every MCP control-plane request to carry a backend-owned auth token, auto-generate and persist that token on app launch when missing, and expose the current token plus regeneration from SyncWatcher UI help/settings surfaces.

## Context

- ADR-20260306-0010 introduced the running-app MCP relay path behind `mcpEnabled`.
- That design limited exposure to an already-running app, but it still left the local control plane effectively unauthenticated for any process that could reach the app-local Unix socket.
- SyncWatcher is a local desktop app, so the trust boundary remains same-user and local-only, but MCP should still require an explicit secret instead of relying only on socket reachability plus the `mcpEnabled` toggle.
- The UX must stay practical for local AI clients:
  - users should not have to mint tokens manually
  - the app should remain the canonical owner of the token
  - the current token must be visible where users configure MCP clients
  - rotating the token must be easy and immediate

## Decision

1. Persist a backend-owned `mcpAuthToken` alongside `mcpEnabled` in `settings.yaml`.
   - The token is not renderer-owned state.
   - The renderer may request a formatted MCP client example, but it does not become the canonical owner of the token.
2. Auto-generate the token whenever SyncWatcher loads settings and finds that the token is missing or blank.
   - This backfills existing installs without a migration step.
   - The generated token is written back to `settings.yaml` immediately.
3. Require every control-plane request to carry the current token.
   - The Unix-socket control plane validates the token before method dispatch.
   - Missing or mismatched tokens fail the request with an actionable auth error.
4. Require the stdio relay mode to be launched with `--mcp-token <token>`.
   - The relay forwards the token with each control-plane request.
   - The relay still performs no sync work and still never auto-launches the app.
5. Expose the current token through user-facing MCP config examples in SyncWatcher Help and Settings.
   - The app shows the exact `command` plus `args` needed for MCP clients.
   - A dedicated regenerate action rotates the token and invalidates old MCP client configs immediately.

## Consequences

- Local MCP access now requires both `mcpEnabled=true` and possession of the current token, which narrows accidental or ambient exposure of the control plane.
- Existing installs migrate lazily and safely because token creation happens during normal settings load.
- Token rotation is operationally simple, but it is intentionally disruptive: any MCP client configured with the old token must be updated before it can talk to SyncWatcher again.
- The token remains stored in the same app-owned settings file as the rest of the control-plane toggle state, so backend ownership stays centralized.
- Help and Settings become the canonical user workflow for MCP client setup and recovery after token rotation.

## Alternatives Considered

1. Keep `mcpEnabled` as the only gate
   - Rejected: the control plane would remain reachable by any local process that can open the socket, which is too weak for a writable AI-facing surface.
2. Authenticate only the stdio relay process and not the socket requests
   - Rejected: direct local socket clients could still bypass the relay entirely.
3. Require users to create and paste their own token manually
   - Rejected: unnecessary friction for a local desktop workflow and too easy to misconfigure.
4. Store the token only in renderer state
   - Rejected: the backend owns MCP execution and must remain the canonical authority for auth validation and rotation.
