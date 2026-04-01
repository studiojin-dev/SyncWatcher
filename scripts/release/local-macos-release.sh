#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
ALLOW_FINDER_SCRIPT=0
DISK_IMAGE_SIZE_MB=""

usage() {
  cat <<'EOF'
Usage: scripts/release/local-macos-release.sh [options]

Builds a local signed + notarized macOS app bundle, then creates/signs/notarizes
a DMG using a clean staging directory so local release packaging is reproducible.

Options:
  --env-file <path>          Path to the env file to source (default: .env)
  --disk-image-size <mb>     Override DMG size in megabytes
  --allow-finder-script      Allow Finder AppleScript DMG layout customization
  -h, --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --disk-image-size)
      DISK_IMAGE_SIZE_MB="$2"
      shift 2
      ;;
    --allow-finder-script)
      ALLOW_FINDER_SCRIPT=1
      shift
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

for bin in pnpm python3 hdiutil xcrun codesign; do
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

normalize_path_var "APPLE_API_KEY_PATH"
normalize_path_var "APPLE_CERTIFICATE_PATH"

for required in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH; do
  if [[ -z "${!required:-}" ]]; then
    echo "Missing required environment variable: ${required}" >&2
    exit 1
  fi
done

if [[ ! -f "${APPLE_API_KEY_PATH}" ]]; then
  echo "APPLE_API_KEY_PATH does not exist: ${APPLE_API_KEY_PATH}" >&2
  exit 1
fi

CONFIG_JSON="$(python3 - <<'PY'
import json
from pathlib import Path

config = json.loads(Path("src-tauri/tauri.conf.json").read_text())
dmg = config["bundle"]["macOS"]["dmg"]
out = {
    "productName": config["productName"],
    "version": config["version"],
    "background": dmg["background"],
    "windowWidth": dmg["windowSize"]["width"],
    "windowHeight": dmg["windowSize"]["height"],
    "appX": dmg["appPosition"]["x"],
    "appY": dmg["appPosition"]["y"],
    "applicationsX": dmg["applicationFolderPosition"]["x"],
    "applicationsY": dmg["applicationFolderPosition"]["y"],
}
print(json.dumps(out))
PY
)"

read_config() {
  local key="$1"
  python3 - "$key" "${CONFIG_JSON}" <<'PY'
import json
import sys
key = sys.argv[1]
data = json.loads(sys.argv[2])
print(data[key])
PY
}

PRODUCT_NAME="$(read_config productName)"
VERSION="$(read_config version)"
BACKGROUND_RELATIVE="$(read_config background)"
WINDOW_WIDTH="$(read_config windowWidth)"
WINDOW_HEIGHT="$(read_config windowHeight)"
APP_X="$(read_config appX)"
APP_Y="$(read_config appY)"
APPLICATIONS_X="$(read_config applicationsX)"
APPLICATIONS_Y="$(read_config applicationsY)"
BACKGROUND_PATH="${REPO_ROOT}/src-tauri/${BACKGROUND_RELATIVE}"

ARCH_SUFFIX="$(uname -m)"
case "${ARCH_SUFFIX}" in
  arm64) ARCH_SUFFIX="aarch64" ;;
  x86_64) ARCH_SUFFIX="x64" ;;
esac

echo "Building signed/stapled app bundle for ${PRODUCT_NAME} ${VERSION} (${ARCH_SUFFIX})"
pnpm tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'

APP_BUNDLE="${REPO_ROOT}/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
DMG_SCRIPT="${REPO_ROOT}/src-tauri/target/release/bundle/dmg/bundle_dmg.sh"
DMG_ICON="${REPO_ROOT}/src-tauri/target/release/bundle/dmg/icon.icns"
STAGE_DIR="${REPO_ROOT}/src-tauri/target/release/bundle/dmg/stage-app"
OUTPUT_DMG="${REPO_ROOT}/src-tauri/target/release/bundle/dmg/${PRODUCT_NAME}_${VERSION}_${ARCH_SUFFIX}.dmg"

for path in "${APP_BUNDLE}" "${DMG_SCRIPT}" "${DMG_ICON}" "${BACKGROUND_PATH}"; do
  if [[ ! -e "${path}" ]]; then
    echo "Expected build artifact not found: ${path}" >&2
    exit 1
  fi
done

if [[ -z "${DISK_IMAGE_SIZE_MB}" ]]; then
  app_kb="$(du -sk "${APP_BUNDLE}" | awk '{print $1}')"
  app_mb="$(( (app_kb + 1023) / 1024 ))"
  DISK_IMAGE_SIZE_MB="$(( app_mb + 180 ))"
  if (( DISK_IMAGE_SIZE_MB < 220 )); then
    DISK_IMAGE_SIZE_MB=220
  fi
fi

echo "Using DMG size: ${DISK_IMAGE_SIZE_MB} MB"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
cp -R "${APP_BUNDLE}" "${STAGE_DIR}/${PRODUCT_NAME}.app"
find "${REPO_ROOT}/src-tauri/target/release/bundle/dmg" -maxdepth 1 -name "rw.*.${PRODUCT_NAME}_${VERSION}_${ARCH_SUFFIX}.dmg" -delete
rm -f "${OUTPUT_DMG}"

DMG_ARGS=(
  --disk-image-size "${DISK_IMAGE_SIZE_MB}"
  --volname "${PRODUCT_NAME}"
  --volicon "${DMG_ICON}"
  --background "${BACKGROUND_PATH}"
  --window-size "${WINDOW_WIDTH}" "${WINDOW_HEIGHT}"
  --icon "${PRODUCT_NAME}.app" "${APP_X}" "${APP_Y}"
  --app-drop-link "${APPLICATIONS_X}" "${APPLICATIONS_Y}"
  "${OUTPUT_DMG}"
  "${STAGE_DIR}"
)

if [[ "${ALLOW_FINDER_SCRIPT}" -eq 0 ]]; then
  DMG_ARGS=(--skip-jenkins "${DMG_ARGS[@]}")
fi

echo "Creating local release DMG"
bash "${DMG_SCRIPT}" "${DMG_ARGS[@]}"

echo "Codesigning DMG"
codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${OUTPUT_DMG}"
codesign --verify --verbose=2 "${OUTPUT_DMG}"

echo "Submitting DMG for notarization"
xcrun notarytool submit "${OUTPUT_DMG}" \
  --key "${APPLE_API_KEY_PATH}" \
  --key-id "${APPLE_API_KEY}" \
  --issuer "${APPLE_API_ISSUER}" \
  --wait

echo "Stapling DMG notarization ticket"
xcrun stapler staple "${OUTPUT_DMG}"

echo "Validating app and DMG notarization"
xcrun stapler validate "${APP_BUNDLE}"
xcrun stapler validate "${OUTPUT_DMG}"
codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
spctl -a -vv --type exec "${APP_BUNDLE}"
if ! spctl -a -vv --type open "${OUTPUT_DMG}"; then
  echo "Warning: spctl could not evaluate the DMG open context locally; codesign and stapler validation already passed." >&2
fi

echo "Local macOS release build complete"
echo "App bundle: ${APP_BUNDLE}"
echo "DMG: ${OUTPUT_DMG}"
