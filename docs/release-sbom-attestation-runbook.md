# Release SBOM + Attestation Rehearsal Runbook

This runbook is for release rehearsal (for example `v1.2.3-rc1`) after enabling SBOM generation and stable-required / prerelease-opt-in cosign attestation in `.github/workflows/release.yml`.

## 1) Pre-flight checklist

1. Confirm release workflow uses:
- `sbom_and_attest` job
- SBOM upload files:
  - `sbom-<tag>.cdx.json`
  - `sbom-<tag>.spdx.json`
- Attestation policy:
  - stable tags force attestation automatically
  - pre-release tags may opt in with repo variable `ENABLE_COSIGN_ATTESTATION` (`false` by default)
2. Confirm repository Actions permissions allow OIDC token for workflows (needed when attestation is enabled).
3. Confirm local verifier tools are installed:
- `gh`
- `jq`
- `cosign` (for attestation verification)
  - Cosign install guide: https://docs.sigstore.dev/cosign/system_config/installation/
4. Confirm target tag format:
- Stable: `vX.Y.Z`
- Pre-release: `vX.Y.Z-beta.N` or `vX.Y.Z-rcN`

## 2) Rehearsal execution checklist

1. Push rehearsal tag:

```bash
git tag vX.Y.Z-rc1
git push origin vX.Y.Z-rc1
```

2. Wait for `Release` workflow completion:
- `tag_gate`: success
- `release` (macOS aarch64 + x86_64 matrix): success
- `sbom_and_attest`: success
- `publish_release`: success

3. Confirm release assets include:
- app bundles (`.dmg` and/or `.app.tar.gz`)
- `sbom-vX.Y.Z-rc1.cdx.json`
- `sbom-vX.Y.Z-rc1.spdx.json`
- `attestation-*.bundle.json` (required for stable tags, optional for prerelease tags when `ENABLE_COSIGN_ATTESTATION=true`)

## 3) SBOM integrity quick checks

```bash
TAG="vX.Y.Z-rc1"
REPO="studiojin-dev/SyncWatcher"

mkdir -p .tmp/release-verify
gh release download "$TAG" --repo "$REPO" --dir .tmp/release-verify

jq -e '.bomFormat == "CycloneDX"' ".tmp/release-verify/sbom-${TAG}.cdx.json" >/dev/null
jq -e '.spdxVersion | startswith("SPDX-")' ".tmp/release-verify/sbom-${TAG}.spdx.json" >/dev/null
```

## 4) Attestation verification command set

Use the maintainer helper script to verify every release artifact:

```bash
scripts/release/verify-release-attestations.sh vX.Y.Z-rc1
```

For a single downloaded DMG or tarball, use the end-user/local helper:

```bash
scripts/release/verify-release-asset.sh vX.Y.Z-rc1 .tmp/release-verify/Sync.Watcher_1.2.3_rc1_aarch64.dmg
```

Or run manually for one artifact:

```bash
TAG="vX.Y.Z-rc1"
REPO="studiojin-dev/SyncWatcher"
ARTIFACT="Sync.Watcher_1.2.3_rc1_aarch64.dmg"
BUNDLE="attestation-${ARTIFACT}.bundle.json"

mkdir -p .tmp/release-verify
gh release download "$TAG" --repo "$REPO" --dir .tmp/release-verify

cosign verify-blob-attestation \
  --bundle ".tmp/release-verify/${BUNDLE}" \
  --type "https://syncwatcher.dev/attestation/release-asset/v1" \
  --certificate-identity "https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ".tmp/release-verify/${ARTIFACT}"
```

## 5) Failure triage checklist

1. `sbom_and_attest` failed before upload:
- check Syft install and output file names
- check tag/env interpolation (`TAG_NAME`)
2. Attestation upload missing:
- for stable tags, confirm the workflow reached `Install Cosign` and `Generate keyless cosign attestations`; no repo variable is required
- for prerelease tags, confirm `ENABLE_COSIGN_ATTESTATION=true`
- confirm release has `.dmg` or `.app.tar.gz` artifacts
3. Verification failed:
- check bundle/artifact filename pairing (`attestation-<artifact>.bundle.json`)
- check certificate identity points to exact workflow/tag
- confirm issuer is `https://token.actions.githubusercontent.com`
