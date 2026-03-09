# ADR-20260305-0009: Release SBOMs, checksum manifests, stable cosign attestation, and separate local verification

- Status: Accepted
- Date: 2026-03-05
- Tags: release, security, sbom, attestation, ci, supply-chain
- TL;DR: Generate SBOMs and checksum manifests for every tagged release, force keyless cosign attestations for stable tags, keep prerelease attestation opt-in via a repo variable, and keep local cosign verification separate from the latest installer.

## Context

- SyncWatcher publishes tagged releases through a GitHub Actions workflow that builds macOS artifacts and publishes a draft release.
- There is no machine-readable SBOM attached to current releases, so dependency and supply-chain review is manual.
- The latest installer should stay lightweight and deterministic, while user-facing cryptographic provenance verification remains an explicit local step.
- Stable tags need a stronger provenance policy than prerelease tags, while RC/beta releases still need rollout flexibility.

## Decision

1. Add a dedicated `sbom_and_attest` job after release artifact creation and before draft publication.
2. Generate two SBOM formats with Syft from repository source/lockfile scope:
   - `sbom-<tag>.cdx.json` (CycloneDX JSON)
   - `sbom-<tag>.spdx.json` (SPDX JSON)
3. Upload SBOM files to the GitHub Release as assets.
4. Generate and upload `checksums-<tag>.txt` for shipped release binaries (`.dmg`, `.app.tar.gz`).
5. Force keyless cosign attestation for stable release tags and keep prerelease tags opt-in:
   - Stable tags automatically force `ENABLE_COSIGN_ATTESTATION=true` inside the workflow
   - Beta/RC tags read repo variable `ENABLE_COSIGN_ATTESTATION` (`false` by default) and may still skip attestation during rollout or emergency prerelease work
   - Uses GitHub OIDC (`id-token: write`) and `cosign attest-blob --bundle`
   - Upload attestation bundle JSON files to the same release
6. Block final release publishing when the SBOM/checksum/attestation stage fails by making `publish_release` depend on `sbom_and_attest`.
7. Provide a separate local verification helper for downloaded release artifacts that:
   - Verifies SHA-256 against `checksums-<tag>.txt`
   - Verifies the matching attestation bundle with `cosign verify-blob-attestation`
   - Pins the Fulcio certificate identity to `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/<tag>`
   - Pins the OIDC issuer to `https://token.actions.githubusercontent.com`
8. Keep `scripts/install-macos-latest.sh` checksum-only and do not treat installer execution as cryptographic provenance verification.

## Consequences

- Every tagged release now carries standardized SBOM metadata plus a deterministic checksum manifest for downstream verification.
- Stable release publishing becomes stricter and less error-prone: stable tags always run attestation instead of relying on a manually toggled repo variable.
- User-facing verification guidance becomes clearer: checksum validation may happen inside lightweight install flows, while cosign verification is a separate explicit step for downloaded artifacts.
- Prerelease tags preserve rollout flexibility because attestation remains opt-in outside the stable channel.
- Current SBOM scope is repository source-level, not per-binary image-level; deeper artifact-level SBOM can be added later.

## Alternatives Considered

1. Generate only one SBOM format
   - Rejected: some consumers require CycloneDX while others require SPDX.
2. Keep stable attestation behind a manual repo variable toggle
   - Rejected: stable releases need a fail-closed provenance policy and should not depend on operator configuration drift.
3. Use deprecated wrapper actions for SBOM end-to-end automation
   - Rejected: direct Syft CLI execution is clearer and easier to maintain.
4. Publish release first, then run SBOM/attestation asynchronously
   - Rejected: can publish incomplete security metadata on failure.
