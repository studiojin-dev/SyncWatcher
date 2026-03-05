# ADR-20260305-0009: Release SBOM generation and optional cosign attestation

- Status: Accepted
- Date: 2026-03-05
- Tags: release, security, sbom, attestation, ci, supply-chain
- TL;DR: Generate CycloneDX/SPDX SBOMs on tagged releases, attach them as release assets, and optionally produce keyless cosign attestations for shipped binaries.

## Context

- SyncWatcher publishes tagged releases through a GitHub Actions workflow that builds macOS artifacts and publishes a draft release.
- There is no machine-readable SBOM attached to current releases, so dependency and supply-chain review is manual.
- There is no cryptographically verifiable attestation attached to release binaries.
- We need an incremental approach that preserves existing release behavior and keeps attestation optional.

## Decision

1. Add a dedicated `sbom_and_attest` job after release artifact creation and before draft publication.
2. Generate two SBOM formats with Syft from repository source/lockfile scope:
   - `sbom-<tag>.cdx.json` (CycloneDX JSON)
   - `sbom-<tag>.spdx.json` (SPDX JSON)
3. Upload SBOM files to the GitHub Release as assets.
4. Add optional keyless cosign attestation for release binaries (`.dmg`, `.app.tar.gz`):
   - Controlled by repository variable `ENABLE_COSIGN_ATTESTATION` (default: disabled)
   - Uses GitHub OIDC (`id-token: write`) and `cosign attest-blob --bundle`
   - Upload attestation bundle JSON files to the same release
5. Block final release publishing when SBOM/attestation stage fails by making `publish_release` depend on `sbom_and_attest`.

## Consequences

- Every tagged release now carries standardized SBOM metadata for downstream consumers.
- Release publishing becomes stricter: SBOM stage failures prevent publish, reducing chance of incomplete provenance.
- Optional attestation improves verification capability without forcing all environments to adopt cosign immediately.
- Current SBOM scope is repository source-level, not per-binary image-level; deeper artifact-level SBOM can be added later.

## Alternatives Considered

1. Generate only one SBOM format
   - Rejected: some consumers require CycloneDX while others require SPDX.
2. Always-on attestation with no toggle
   - Rejected: rollout risk is higher for first adoption and could block urgent releases.
3. Use deprecated wrapper actions for SBOM end-to-end automation
   - Rejected: direct Syft CLI execution is clearer and easier to maintain.
4. Publish release first, then run SBOM/attestation asynchronously
   - Rejected: can publish incomplete security metadata on failure.
