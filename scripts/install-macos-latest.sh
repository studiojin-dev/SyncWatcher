#!/usr/bin/env bash
set -euo pipefail

# SyncWatcher macOS latest installer (GitHub Releases, no browser download)
# - Supports Apple Silicon (aarch64) and Intel (x86_64) Mac

REPO="studiojin-dev/SyncWatcher"
APP_NAME="Sync Watcher.app"

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  SUFFIX="aarch64"
elif [ "$ARCH" = "x86_64" ]; then
  SUFFIX="x86_64"
else
  echo "Unsupported architecture: ${ARCH}"
  exit 1
fi

tmp_dir="$(mktemp -d)"
mount_point="${tmp_dir}/dmg"
trap 'hdiutil detach "$mount_point" >/dev/null 2>&1 || true; rm -rf "$tmp_dir"' EXIT

echo "SyncWatcher latest release 정보를 조회합니다..."
release_json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

if [ -z "$tag" ]; then
  echo "릴리스 태그를 확인하지 못했습니다."
  exit 1
fi

version="${tag#v}"
dmg_name="Sync.Watcher_${version}_${SUFFIX}.dmg"
checksums_name="checksums-${tag}.txt"
download_url="https://github.com/${REPO}/releases/download/${tag}/${dmg_name}"
checksums_url="https://github.com/${REPO}/releases/download/${tag}/${checksums_name}"
dmg_path="${tmp_dir}/${dmg_name}"
checksums_path="${tmp_dir}/${checksums_name}"

echo "아키텍처: ${SUFFIX}"
echo "다운로드: ${dmg_name}"
curl -fL "$download_url" -o "$dmg_path"
curl -fL "$checksums_url" -o "$checksums_path"

expected_sha="$(awk -v file="$dmg_name" '$2 == file { print $1 }' "$checksums_path" | head -n 1)"
if [ -z "$expected_sha" ]; then
  echo "체크섬 파일에서 ${dmg_name} 항목을 찾지 못했습니다."
  exit 1
fi

actual_sha="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "SHA-256 검증 실패: ${dmg_name}"
  echo "expected: ${expected_sha}"
  echo "actual:   ${actual_sha}"
  exit 1
fi

echo "검증 완료: SHA-256 checksum 확인"

mkdir -p "$mount_point"
hdiutil attach "$dmg_path" -nobrowse -mountpoint "$mount_point" -quiet

if [ ! -d "${mount_point}/${APP_NAME}" ]; then
  echo "DMG 안에서 앱 번들이 보이지 않습니다: ${APP_NAME}"
  exit 1
fi

cp -R "${mount_point}/${APP_NAME}" "/Applications/${APP_NAME}"
hdiutil detach "$mount_point" -quiet
trap - EXIT

echo "설치 완료: /Applications/${APP_NAME}"
open "/Applications/${APP_NAME}"
echo "완료되었습니다."
