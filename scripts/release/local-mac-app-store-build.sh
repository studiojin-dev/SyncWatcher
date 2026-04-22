#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
BUILD_NUMBER_FILE="${REPO_ROOT}/src-tauri/appstore-build-number.txt"
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
  --build-number-file Repo-tracked integer file to use for CFBundleVersion
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
    --build-number-file)
      BUILD_NUMBER_FILE="$2"
      shift 2
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

for bin in pnpm xcrun codesign pkgutil security node plutil; do
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
normalize_path_var "APPLE_API_KEY_PATH"
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

if [[ ! -f "${BUILD_NUMBER_FILE}" ]]; then
  echo "Build number file not found: ${BUILD_NUMBER_FILE}" >&2
  exit 1
fi

APP_STORE_BUILD_NUMBER="$(tr -d '[:space:]' < "${BUILD_NUMBER_FILE}")"
if [[ ! "${APP_STORE_BUILD_NUMBER}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Build number must be a positive integer: ${APP_STORE_BUILD_NUMBER}" >&2
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

  if [[ -z "${APPLE_API_KEY_PATH:-}" || ! -f "${APPLE_API_KEY_PATH}" ]]; then
    echo "Missing required App Store Connect API private key file: APPLE_API_KEY_PATH" >&2
    exit 1
  fi
fi

CONFIG_PATH="src-tauri/tauri.appstore.conf.json"
PRODUCT_NAME="$(node -p "require('./${CONFIG_PATH}').productName")"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
APP_BUNDLE="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
OUTPUT_DIR="${REPO_ROOT}/dist-appstore"
OUTPUT_PKG="${OUTPUT_DIR}/SyncWatcher-${VERSION}-b${APP_STORE_BUILD_NUMBER}-mac-app-store.pkg"
INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
MACOS_BIN_DIR="${APP_BUNDLE}/Contents/MacOS"
ENTITLEMENTS_PATH="${REPO_ROOT}/src-tauri/Entitlements.plist"

echo "Building Mac App Store app bundle for ${PRODUCT_NAME} ${VERSION} (build ${APP_STORE_BUILD_NUMBER})"
ORIGINAL_APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
ORIGINAL_APPLE_API_KEY="${APPLE_API_KEY:-}"
ORIGINAL_APPLE_API_ISSUER="${APPLE_API_ISSUER:-}"
ORIGINAL_APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH:-}"
ORIGINAL_APPLE_ID="${APPLE_ID:-}"
ORIGINAL_APPLE_PASSWORD="${APPLE_PASSWORD:-}"
ORIGINAL_APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

export APPLE_SIGNING_IDENTITY="${APPLE_APP_STORE_SIGNING_IDENTITY}"
unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID

pnpm tauri build --bundles app --config "${CONFIG_PATH}"

if [[ -n "${ORIGINAL_APPLE_SIGNING_IDENTITY}" ]]; then
  export APPLE_SIGNING_IDENTITY="${ORIGINAL_APPLE_SIGNING_IDENTITY}"
else
  unset APPLE_SIGNING_IDENTITY
fi

if [[ -n "${ORIGINAL_APPLE_API_KEY}" ]]; then
  export APPLE_API_KEY="${ORIGINAL_APPLE_API_KEY}"
fi
if [[ -n "${ORIGINAL_APPLE_API_ISSUER}" ]]; then
  export APPLE_API_ISSUER="${ORIGINAL_APPLE_API_ISSUER}"
fi
if [[ -n "${ORIGINAL_APPLE_API_KEY_PATH}" ]]; then
  export APPLE_API_KEY_PATH="${ORIGINAL_APPLE_API_KEY_PATH}"
fi
if [[ -n "${ORIGINAL_APPLE_ID}" ]]; then
  export APPLE_ID="${ORIGINAL_APPLE_ID}"
fi
if [[ -n "${ORIGINAL_APPLE_PASSWORD}" ]]; then
  export APPLE_PASSWORD="${ORIGINAL_APPLE_PASSWORD}"
fi
if [[ -n "${ORIGINAL_APPLE_TEAM_ID}" ]]; then
  export APPLE_TEAM_ID="${ORIGINAL_APPLE_TEAM_ID}"
fi

if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "Expected app bundle not found: ${APP_BUNDLE}" >&2
  exit 1
fi

if [[ ! -f "${INFO_PLIST}" ]]; then
  echo "Expected Info.plist not found: ${INFO_PLIST}" >&2
  exit 1
fi

echo "Setting CFBundleVersion=${APP_STORE_BUILD_NUMBER}"
plutil -replace CFBundleVersion -string "${APP_STORE_BUILD_NUMBER}" "${INFO_PLIST}"
plutil -remove LSRequiresCarbon "${INFO_PLIST}" 2>/dev/null || true

MAIN_EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${INFO_PLIST}")"
if [[ -z "${MAIN_EXECUTABLE_NAME}" ]]; then
  echo "Unable to determine CFBundleExecutable from ${INFO_PLIST}" >&2
  exit 1
fi

echo "Removing nested executables from App Store bundle"
for executable_path in "${MACOS_BIN_DIR}"/*; do
  executable_name="$(basename "${executable_path}")"
  if [[ "${executable_name}" == "${MAIN_EXECUTABLE_NAME}" ]]; then
    continue
  fi
  rm -f "${executable_path}"
done

echo "Re-signing Mac App Store app bundle"
codesign \
  --force \
  --deep \
  --sign "${APPLE_APP_STORE_SIGNING_IDENTITY}" \
  --entitlements "${ENTITLEMENTS_PATH}" \
  "${APP_BUNDLE}"

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
  PRIVATE_KEYS_DIR="${HOME}/.appstoreconnect/private_keys"
  mkdir -p "${PRIVATE_KEYS_DIR}"
  chmod 700 "${PRIVATE_KEYS_DIR}"
  ln -sf "${APPLE_API_KEY_PATH}" "${PRIVATE_KEYS_DIR}/AuthKey_${APPLE_API_KEY}.p8"

  "${TRANSPORTER_BIN}" \
    -m upload \
    -assetFile "${OUTPUT_PKG}" \
    -apiKey "${APPLE_API_KEY}" \
    -apiIssuer "${APPLE_API_ISSUER}" \
    -v informational

  NEXT_BUILD_NUMBER="$((APP_STORE_BUILD_NUMBER + 1))"
  printf '%s\n' "${NEXT_BUILD_NUMBER}" > "${BUILD_NUMBER_FILE}"
  echo "Incremented App Store build number to ${NEXT_BUILD_NUMBER}"
fi

echo "Mac App Store local build complete"
echo "App bundle: ${APP_BUNDLE}"
echo "Installer package: ${OUTPUT_PKG}"
