# SyncWatcher (Source-Available)

macOS-native file synchronization utility with automatic SD card/USB detection and real-time backup capabilities.

**v1.0 is in active development.**

## Overview

SyncWatcher is a high-performance, native-feeling macOS file synchronization application that:

- **Detects SD cards and USB drives** automatically when inserted
- **Performs real-time directory watching** for instant backup
- **Supports one-way sync** (Source → Target) with rsync-like efficiency
- **Features a modern Neo-Brutalism UI** for a bold, high-contrast user experience to verify sync logic independently of GUI

## Features

### 🎨 Modern User Interface

- **Neo-Brutalism Design**: Bold borders, high contrast, and hard shadows for a distinct look.
- **Responsive Dashboard**: Bento grid layout displaying real-time stats and storage info.
- **Dark Mode**: Fully supported with system theme synchronization.
- **Custom Components**: Styled Volume Cards, Activity Logs, and Settings controls.

### 🌍 Localization

- **Multi-language Support**: Fully translated into English, Korean (한국어), Spanish (Español), Chinese (中文), and Japanese (日本語).
- **Instant Switching**: Change languages on the fly via Settings.

### ⚡ Core Sync Engine

- **One-way sync** (Source → Target)
- **Dry-run mode** - Preview changes before executing
- **Checksum comparison** - xxHash64 for accuracy
- **Orphan inspector** - Review/delete target-only files with explicit confirmation
- **Progress tracking** - Real-time feedback

### 🖥️ System Integration

- **Disk monitoring** - Detects mounted volumes on macOS
- **Volume detection** - Identifies removable media (USB, SD cards)
- **Space calculation** - Total and available disk space
- **Folder watching** - Real-time file system events via notify

### � Compliance & Metadata

- **About/License UI**: Built-in viewer for licenses and registration status.
- **Build-time Collection**: Automated generation of `oss-licenses.json` for compliance.

## Tech Stack

### Core (Rust)

- **Tauri v2** - macOS app bundle
- **Tokio** - Async runtime for high-performance I/O
- **notify** - File system event monitoring
- **xxHash** - Fast checksum-based comparison

### Frontend (React + TypeScript)

- **Vite** - Build tool and dev server
- **Tailwind CSS v4** - Styling & layout (configured via CSS variables)
- **Mantine** - UI component library structure
- **i18next** - Internationalization framework

## Getting Started

### Prerequisites

- **Rust** 1.70+ - For CLI and backend
- **Node.js** 18+ - For frontend development
- **macOS** 11+ - Target platform

### Development

```bash
# Install dependencies
npm install

# Run development server (Tauri + Vite)
npm run dev

# Build for production
npm run build

# Build Tauri bundle
npm run tauri build
```

### macOS Installation

1. Download the macOS installer package from GitHub Releases.
2. Open the downloaded file (`.dmg`) and move `SyncWatcher.app` to `Applications`.
   - The DMG may show a Gatekeeper message depending on your macOS settings.
3. Run `SyncWatcher`.

### macOS Latest Installer (curl script)

Use this one-liner to install the latest build directly from GitHub Releases:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/studiojin-dev/SyncWatcher/main/scripts/install-macos-latest.sh)"
```

The script will:

1. Read the latest release tag from GitHub
2. Pick the matching architecture (`aarch64` / `x86_64`) DMG
3. Download the DMG and same-tag checksum manifest
4. Verify the DMG SHA-256 against the release checksum manifest
5. Install `Sync Watcher.app` into `/Applications`

If you want, use tar format in your release assets and the same flow still works with a small script change.

### Verify With Cosign Before Opening The DMG

For cryptographic provenance verification, install Cosign first by following the official instructions:

- https://docs.sigstore.dev/cosign/system_config/installation/

Then verify the downloaded DMG against the same-tag checksum and attestation bundle before mounting it:

```bash
scripts/release/verify-release-asset.sh v1.1.0 ~/Downloads/Sync.Watcher_1.1.0_aarch64.dmg
```

Only after the helper succeeds should you open the DMG or clear quarantine metadata for local testing.

Stable tags are published only when an attestation bundle is present for the shipped artifacts. The latest installer remains checksum-only; local cryptographic verification is provided by `scripts/release/verify-release-asset.sh`.

### macOS 설치 안내 (한국어)

1. 먼저 Cosign을 설치합니다.
   - 공식 안내: https://docs.sigstore.dev/cosign/system_config/installation/
2. GitHub Releases에서 `.dmg` 파일을 다운로드합니다.
3. 아래 helper로 같은 태그의 checksum과 attestation을 함께 검증합니다.
   ```bash
   scripts/release/verify-release-asset.sh v1.1.0 ~/Downloads/Sync.Watcher_1.1.0_aarch64.dmg
   ```
4. 검증이 끝난 뒤 `.dmg`를 열어 `SyncWatcher.app`을 `Applications` 폴더로 이동합니다.
5. 실행이 차단되면 아래 중 하나로 진행하세요.
   - 앱 우클릭(또는 Control 클릭) → **열기** → **열기**
   - 또는 아래 `Security & Permissions` 절차에서 보안 허용 처리
6. `손상됨` 경고가 보이면, 테스트 목적으로만 아래 명령으로 격리 속성을 제거할 수 있습니다:
   ```bash
   xattr -dr com.apple.quarantine ~/Downloads/Sync.Watcher_1.1.0_aarch64.dmg
   ```
   파일 경로는 다운로드한 파일명에 맞게 변경하세요.

> `xattr`은 로컬 테스트용 우회 방법입니다. 공식 배포 품질 확보용 해결책이 아닙니다.

## Security & Permissions (Important)

This app is currently distributed via GitHub Releases and is **not notarized** with Apple Developer Program.

On first launch, macOS may show a security warning (Gatekeeper) such as "cannot be opened because the developer cannot be verified."

If you do not have an Apple Developer membership (paid), this is expected.
The app is not distributed as a fully signed & notarized Developer ID build, so Gatekeeper may show:
`damaged and cannot be opened` or `developer cannot be verified`.
These warnings usually mean “unverified distribution context,” not necessarily a broken DMG.

For local testing, you may clear quarantine metadata with:
`xattr -dr com.apple.quarantine <downloaded-dmg>`.
If **System Settings > Privacy & Security** shows `Open Anyway`, it is a user-approval exception, not a full trusted distribution state.

Once we join the Apple Developer Program (paid), we will distribute a signed and notarized package so these manual steps are no longer required.

### macOS 설치(스크립트) / Homebrew Cask (선택)

#### 1) curl + sh로 최신 버전 자동 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/studiojin-dev/SyncWatcher/main/scripts/install-macos-latest.sh)"
```

이 스크립트는 최신 stable 태그를 대상으로 checksum manifest만 확인한 뒤 설치를 진행합니다. cryptographic provenance 검증은 별도 helper(`scripts/release/verify-release-asset.sh`)로 수행합니다.

#### 2) Homebrew (개인 Tap) 배포

개인 Tap을 만들면 `brew install`로도 바로 설치 가능하게 할 수 있습니다.

```bash
brew install --cask studiojin-dev/syncwatcher/syncwatcher
```

동작 방식:
- `brew`는 사용자가 직접 GitHub 릴리즈 페이지를 거치지 않으므로, 브라우저 quarantine이 붙지 않아
  `"손상됨"` 유입 경로를 줄일 수 있습니다.
- 그러나 macOS 코드사인/공증이 없는 상태면, 완전 무경고 상태가 보장되진 않습니다.
- 사용자 입장에서 discoverability는 보장되지 않기 때문에, README/릴리즈 페이지에 설치 명령을 반드시 함께 노출해야 합니다.

현재 상태에서 `손상됨` 경고를 근본적으로 없애려면 아래가 필요합니다.
1. Apple Developer Program 가입(유료)
2. Developer ID 인증서로 앱 코드사인
3. Notarization(공증) 적용

`TAURI_SIGNING_PRIVATE_KEY`는 앱 업데이트 서명(Updater)용 키이고, macOS 앱 실행 신뢰(코드사인/공증)와는 별개입니다.

- To run the app for the first time:
  1. Open the app with right-click (Control-click) → **Open**.
  2. In the dialog, click **Open** again.
- If still blocked:
  1. Open **System Settings** → **Privacy & Security**.
  2. In the **Security** section, click **Allow** for `SyncWatcher` when available.
  3. Launch `SyncWatcher` again.

### macOS 보안 동작 (한국어 요약)

- 지금처럼 `Apple Developer Program` 미가입 상태라면, macOS는 앱을 `신뢰되지 않은 배포`로 처리할 수 있고, 이 때문에 `손상됨` 또는 `개발자 신원 확인 불가` 메시지가 보일 수 있습니다.
- 이 메시지는 앱이 고장난 것이 아니라 보안 정책 판단입니다.
- 이 메시지를 “우회 실행”하는 방법은 존재하지만, 정식 사용자 배포의 완전한 해결책이 아닙니다.
- 유료 회원제로 전환 후 `Developer ID 서명 + 공증`을 적용하면 일반 사용자에게는 수동 허용 없이 설치/실행이 가능해집니다.

If you operate in a corporate environment, you may need administrator approval to allow this app once at the OS policy level.

### CLI Usage

The CLI can be run independently of the GUI for testing and verification:

```bash
# Build CLI
cd src-tauri && cargo build --release --bin sync-cli

# Preview sync (dry-run)
./src-tauri/target/release/sync-cli \
  --source /Volumes/SD_Card \
  --target ~/Backups/SD \
  --dry-run
```

## License

This project is **Source-Available** software:

| Component            | License                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| [Source Code](./LICENSE) | [Polyform Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) |
| Binary Distribution  | Proprietary EULA (Free Use, Optional Support License)                                   |

### Free Use Policy

The official SyncWatcher app is free to use, including commercial/internal company use.

Buying a license is optional for everyone. It is a support purchase to help ongoing development.

### Why Polyform Noncommercial?

The source code is published under Polyform Noncommercial 1.0.0 mainly to prevent third-party fork-and-resell monetization of this project.

### Optional Support Links

- License support purchase: [studiojin.dev](https://studiojin.dev)
- Additional tip after purchase: [Buy Me a Coffee](https://buymeacoffee.com/studiojin_dev)

## Acknowledgments

- Tauri Team for the amazing framework
- Studio Jin for design and development
