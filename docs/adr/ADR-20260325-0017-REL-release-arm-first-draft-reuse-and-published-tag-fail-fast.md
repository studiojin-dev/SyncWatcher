# ADR-20260325-0017-REL: ARM-first release orchestration with draft reuse and published-tag fail-fast

- Status: Accepted
- Date: 2026-03-25
- Tags: release, ci, github-actions, tauri, updater, macos
- TL;DR: Create or reuse one draft release per tag, let the ARM build author the canonical updater metadata first, append x64 assets afterward, and fail fast when a tag already has a published release.

## Context

- `v1.3.1` exposed a race in the release workflow: both macOS matrix jobs could decide no draft release existed yet, create one concurrently, and upload overlapping assets.
- The result was inconsistent published state:
  - only one architecture's DMG and updater tarball survived
  - `latest.json` reflected whichever job uploaded last
- The existing release pipeline intentionally publishes GitHub Releases as the authoritative source of updater metadata and install artifacts.
- A manual retry for an already-published tag should not silently mutate the released artifact set without an explicit maintainer decision.

## Decision

1. Introduce a dedicated `prepare_release` job that is solely responsible for ensuring a single draft release exists for the requested tag.
2. If the tag already has a published release, fail the workflow immediately with operator guidance to cut and push a new patch version instead of mutating the published release in place.
3. Run the macOS release jobs sequentially:
   - `release_aarch64` first
   - `release_x64` second
4. Make the ARM build the first canonical build for the tag:
   - it establishes the release draft and ARM updater artifacts first
   - it prevents x64 from racing to define the initial release state
5. Keep the x64 build from publishing updater metadata on its own:
   - upload x64 assets to the existing draft release
   - disable x64-side `latest.json` publication
6. Rebuild `latest.json` after both architecture jobs succeed so the final updater metadata contains both `darwin-aarch64` and `darwin-x86_64` entries.
7. Preserve the existing post-build SBOM, checksum, attestation, and release-publication stages after both architecture jobs complete.

## Consequences

- The release tag now has one deterministic draft release owner before any macOS build starts.
- ARM assets cannot be overwritten by a concurrent x64 release action, and the final `latest.json` is assembled deterministically after both builds finish.
- Re-running the workflow for a published tag becomes an explicit operator error with a clear next step: publish a new patch tag.
- The workflow now owns one small metadata-merge step so updater JSON stays complete across both macOS architectures.

## Alternatives Considered

1. Keep the matrix build and rely on release upload ordering
   - Rejected: nondeterministic and already shown to lose assets.
2. Let both jobs keep using `tauri-action` release creation with the same tag
   - Rejected: both jobs can still race on draft creation and `latest.json`.
3. Allow retries to overwrite already-published release assets in place
   - Rejected: increases release mutability and hides when a new patch version should be cut.
