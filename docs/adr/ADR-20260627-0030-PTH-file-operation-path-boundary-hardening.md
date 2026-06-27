# ADR-20260627-0030-PTH: File operation path boundary hardening
Status: Accepted
Date: 2026-06-27
Tags: security, path-validation, symlink, network-mount, tauri, macos
TL;DR: File operations that act on user-selected roots or app-owned config files must reject traversal and symlink escapes before reading, writing, or launching editors.

## Context

- SyncWatcher copies files between user-selected roots, resolves conflict overwrite actions, remounts SMB paths, and exposes a few Tauri commands for config-file recovery.
- Existing path validation covered many root-level checks, but some sinks still accepted already-joined filesystem paths and then relied on normal OS file semantics.
- Normal macOS file APIs follow symlinks by default. That is convenient for user workflows, but it is unsafe for write sinks whose security boundary is the selected target root or the app-owned config directory.
- ADR-20260414-0027 keeps SMB remount metadata as persisted task state. That state must not be allowed to reconstruct paths outside the mounted share root.
- ADR-20260417-0028 keeps MCP/token validation as the control-plane boundary, but renderer or local command reachability must still be constrained at filesystem sinks.

## Decision

1. Treat selected sync target roots, conflict target paths, and app config-store files as explicit filesystem boundaries.
2. Reject parent-directory components in persisted SMB relative subpaths and re-check the same invariant when reconstructing remounted paths.
3. Reject existing symlink components before writing sync or conflict target files.
4. Open target files with no-follow semantics where the platform exposes them, so a destination symlink cannot be used as the final write target.
5. Keep legacy path-based YAML Tauri commands for compatibility, but allow them only for the managed config directory and the three managed config-store files.
6. Use exact `Path` comparisons for config-file authorization instead of string-prefix containment checks.

## Consequences

- Positive
  - A target tree can no longer redirect sync or conflict-copy writes through preexisting symlinks.
  - Crafted network mount records cannot remount a share and resolve a subpath outside the share root.
  - Renderer-exposed YAML repair helpers no longer operate on arbitrary local filesystem paths.
- Trade-offs
  - Users cannot use symlink placeholders as overwrite destinations inside sync targets.
  - Existing malformed network mount records with parent-directory relative subpaths fail validation instead of being repaired silently.
  - The path-based YAML commands remain as a compatibility layer, but new UI should prefer scope-based config-store commands.

## Alternatives Considered

1. Keep broad path commands and rely on renderer trust
   - Rejected: renderer compromise or confused frontend paths would retain unnecessary filesystem reach.
2. Canonicalize every target path and allow symlink destinations that resolve inside the root
   - Rejected: it preserves ambiguous overwrite behavior and leaves a larger race window at the final write target.
3. Replace all copy sinks with an `openat`-based component-by-component writer immediately
   - Deferred: it would reduce race windows further, but it is a larger implementation change than needed to close the validated symlink overwrite findings.
