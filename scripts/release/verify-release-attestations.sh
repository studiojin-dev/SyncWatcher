#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <tag> [repo]"
  echo "Example: $0 v1.0.0-rc1 studiojin-dev/SyncWatcher"
  exit 1
fi

TAG="$1"
REPO="${2:-studiojin-dev/SyncWatcher}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

for bin in gh jq cosign; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin"
    exit 1
  fi
done

echo "Downloading release assets: repo=${REPO}, tag=${TAG}"
gh release download "$TAG" --repo "$REPO" --dir "$WORKDIR"

cdx_file="$WORKDIR/sbom-${TAG}.cdx.json"
spdx_file="$WORKDIR/sbom-${TAG}.spdx.json"

if [ ! -f "$cdx_file" ] || [ ! -f "$spdx_file" ]; then
  echo "SBOM files not found for tag ${TAG}"
  exit 1
fi

echo "Validating SBOM format markers"
jq -e '.bomFormat == "CycloneDX"' "$cdx_file" >/dev/null
jq -e '.spdxVersion | startswith("SPDX-")' "$spdx_file" >/dev/null

mapfile -t artifacts < <(find "$WORKDIR" -maxdepth 1 -type f \( -name "*.dmg" -o -name "*.app.tar.gz" \) | sort)
if [ "${#artifacts[@]}" -eq 0 ]; then
  echo "No release artifacts (.dmg / .app.tar.gz) found"
  exit 1
fi

mapfile -t bundles < <(find "$WORKDIR" -maxdepth 1 -type f -name 'attestation-*.bundle.json' | sort)
if [ "${#bundles[@]}" -eq 0 ]; then
  echo "No attestation bundle files found. Either attestation is disabled or upload failed."
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  artifact_name="$(basename "$artifact")"
  bundle="$WORKDIR/attestation-${artifact_name}.bundle.json"

  if [ ! -f "$bundle" ]; then
    echo "Missing bundle for artifact: ${artifact_name}"
    exit 1
  fi

  echo "Verifying attestation: ${artifact_name}"
  cosign verify-blob-attestation \
    --bundle "$bundle" \
    --type "https://syncwatcher.dev/attestation/release-asset/v1" \
    --certificate-identity-regexp "^https://github.com/${REPO}/\\.github/workflows/release\\.yml@refs/tags/${TAG}$" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "$artifact" >/dev/null
done

echo "Verification complete: SBOM files and all attestation bundles are valid for ${TAG}"
