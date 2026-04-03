#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
UPLOAD_WITH_TRANSPORTER=0
TRANSPORTER_BIN_DEFAULT="/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter"
TRANSPORTER_BIN="${TRANSPORTER_BIN_DEFAULT}"

usage() {
  cat <<'EOF'
Usage: scripts/release/local-mac-app-store-build.sh [options]

Builds the Mac App Store flavor locally, signs the .app with the App Store
application identity, embeds the provisioning profile, and creates a signed
submission .pkg with the App Store installer identity.

Options:
  --env-file <path>   Path to the env file to source (default: .env)
  --upload            Upload the generated .pkg with Transporter after build
  --transporter-bin   Path to iTMSTransporter binary
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --upload)
      UPLOAD_WITH_TRANSPORTER=1
      shift
      ;;
    --transporter-bin)
      TRANSPORTER_BIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

for bin in pnpm xcrun codesign pkgutil security; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required command: $bin" >&2
    exit 1
  fi
done

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

strip_quotes() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "${value}"
}

normalize_path_var() {
  local name="$1"
  local raw="${!name:-}"
  if [[ -z "${raw}" ]]; then
    return
  fi
  raw="$(strip_quotes "${raw}")"
  if [[ "${raw}" != /* ]]; then
    raw="${REPO_ROOT}/${raw}"
  fi
  export "${name}=${raw}"
}

normalize_path_var "APPLE_APP_STORE_PROVISIONING_PROFILE_PATH"
normalize_path_var "TRANSPORTER_BIN"

for required in \
  APPLE_APP_STORE_SIGNING_IDENTITY \
  APPLE_APP_STORE_INSTALLER_IDENTITY \
  APPLE_APP_STORE_PROVISIONING_PROFILE_PATH; do
  if [[ -z "${!required:-}" ]]; then
    echo "Missing required environment variable: ${required}" >&2
    exit 1
  fi
done

if [[ ! -f "${APPLE_APP_STORE_PROVISIONING_PROFILE_PATH}" ]]; then
  echo "Provisioning profile not found: ${APPLE_APP_STORE_PROVISIONING_PROFILE_PATH}" >&2
  exit 1
fi

if [[ "${UPLOAD_WITH_TRANSPORTER}" -eq 1 ]]; then
  for required in APPLE_API_KEY APPLE_API_ISSUER; do
    if [[ -z "${!required:-}" ]]; then
      echo "Missing required environment variable for upload: ${required}" >&2
      exit 1
    fi
  done

  if [[ ! -x "${TRANSPORTER_BIN}" ]]; then
    echo "Transporter CLI not found or not executable: ${TRANSPORTER_BIN}" >&2
    echo "Install Transporter.app from the Mac App Store or pass --transporter-bin." >&2
    exit 1
  fi
fi

CONFIG_PATH="src-tauri/tauri.appstore.conf.json"
PRODUCT_NAME="$(node -p "require('./${CONFIG_PATH}').productName")"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
APP_BUNDLE="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
OUTPUT_DIR="${REPO_ROOT}/dist-appstore"
OUTPUT_PKG="${OUTPUT_DIR}/SyncWatcher-${VERSION}-mac-app-store.pkg"

echo "Building Mac App Store app bundle for ${PRODUCT_NAME} ${VERSION}"
pnpm tauri build --bundles app --config "${CONFIG_PATH}"

if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "Expected app bundle not found: ${APP_BUNDLE}" >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
rm -f "${OUTPUT_PKG}"

echo "Creating signed Mac App Store installer package"
xcrun productbuild \
  --component "${APP_BUNDLE}" /Applications \
  --sign "${APPLE_APP_STORE_INSTALLER_IDENTITY}" \
  "${OUTPUT_PKG}"

echo "Verifying app signature"
codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"

echo "Verifying installer signature"
pkgutil --check-signature "${OUTPUT_PKG}"

if [[ "${UPLOAD_WITH_TRANSPORTER}" -eq 1 ]]; then
  echo "Uploading package with Transporter"
  "${TRANSPORTER_BIN}" \
    -m upload \
    -assetFile "${OUTPUT_PKG}" \
    -apiKey "${APPLE_API_KEY}" \
    -apiIssuer "${APPLE_API_ISSUER}" \
    -v informational
fi

echo "Mac App Store local build complete"
echo "App bundle: ${APP_BUNDLE}"
echo "Installer package: ${OUTPUT_PKG}"
