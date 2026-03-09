#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  echo "Usage: $0 <tag> <artifact-path> [repo]"
  echo "Example: $0 v1.1.0 ~/Downloads/Sync.Watcher_1.1.0_aarch64.dmg studiojin-dev/SyncWatcher"
  exit 1
fi

TAG="$1"
ARTIFACT_PATH="$2"
REPO="${3:-studiojin-dev/SyncWatcher}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

for bin in curl shasum cosign; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin"
    if [ "$bin" = "cosign" ]; then
      echo "Install Cosign first: https://docs.sigstore.dev/cosign/system_config/installation/"
    fi
    exit 1
  fi
done

if [ ! -f "$ARTIFACT_PATH" ]; then
  echo "Artifact not found: ${ARTIFACT_PATH}"
  exit 1
fi

artifact_name="$(basename "$ARTIFACT_PATH")"
checksums_name="checksums-${TAG}.txt"
bundle_name="attestation-${artifact_name}.bundle.json"
download_base="https://github.com/${REPO}/releases/download/${TAG}"
checksums_path="${WORKDIR}/${checksums_name}"
bundle_path="${WORKDIR}/${bundle_name}"

echo "Downloading release verification data: repo=${REPO}, tag=${TAG}"
curl -fL "${download_base}/${checksums_name}" -o "$checksums_path"
curl -fL "${download_base}/${bundle_name}" -o "$bundle_path"

expected_sha="$(awk -v file="$artifact_name" '$2 == file { print $1 }' "$checksums_path" | head -n 1)"
if [ -z "$expected_sha" ]; then
  echo "Checksum entry not found for artifact: ${artifact_name}"
  exit 1
fi

actual_sha="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "SHA-256 verification failed: ${artifact_name}"
  echo "expected: ${expected_sha}"
  echo "actual:   ${actual_sha}"
  exit 1
fi

echo "Checksum verified: ${artifact_name}"
echo "Running cosign attestation verification"
cosign verify-blob-attestation \
  --bundle "$bundle_path" \
  --type "https://syncwatcher.dev/attestation/release-asset/v1" \
  --certificate-identity "https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$ARTIFACT_PATH" >/dev/null

echo "Verification complete: ${artifact_name} matches ${TAG} and the expected release workflow identity"
