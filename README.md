# SyncWatcher (Source-Available)

macOS-native file synchronization utility with automatic SD card/USB detection and real-time backup capabilities.
[![GitHub release](https://img.shields.io/github/v/release/studiojin-dev/SyncWatcher)](https://github.com/studiojin-dev/SyncWatcher/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/studiojin-dev/SyncWatcher/latest/total)](https://github.com/studiojin-dev/SyncWatcher/releases/latest)

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

This is the currently recommended installation method while the app is usable and before paid Apple Developer Program membership is enabled, because signed/notarized installer distribution is not yet available.

If you still see `curl: (56)` or `404` during download, it usually means the downloaded script is not matching the latest release asset names (common when release asset naming changed across versions). Re-run the same command again; the latest script always resolves the `.dmg` filename from release metadata before download.

The script will:

1. Read the latest release tag from GitHub
2. Pick the matching architecture (`aarch64` / `x86_64`) DMG
3. Download the DMG and same-tag checksum manifest
4. Verify the DMG SHA-256 against the release checksum manifest
5. Install `Sync Watcher.app` into `/Applications`

If you want, use tar format in your release assets and the same flow still works with a small script change.

### macOS 설치(스크립트)

#### 1) curl + sh로 최신 버전 자동 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/studiojin-dev/SyncWatcher/main/scripts/install-macos-latest.sh)"
```

이 스크립트는 최신 stable 태그를 대상으로 checksum manifest만 확인한 뒤 설치를 진행합니다. cryptographic provenance 검증은 별도 helper(`scripts/release/verify-release-asset.sh`)로 수행합니다.

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
