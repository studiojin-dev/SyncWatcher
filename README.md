# SyncWatcher

macOS-native file synchronization utility with automatic SD card/USB detection and real-time backup capabilities.

## Overview

SyncWatcher is a high-performance, native-feeling macOS file synchronization application that:

- **Detects SD cards and USB drives** automatically when inserted
- **Performs real-time directory watching** for instant backup
- **Supports one-way sync** (Source → Target) with rsync-like efficiency
- **Offers CLI for testing** - verify sync logic independently of GUI
- **Plans SMB protocol support** for network shares

## Tech Stack

### Core (Rust)
- **Tauri v2** - macOS app bundle
- **Tokio** - Async runtime for high-performance I/O
- **notify** - File system event monitoring
- **xxHash** - Fast checksum-based comparison
- **walkdir** - Efficient directory traversal
- **nix** - System calls for disk space detection

### Frontend (Planned for Phase 3-4)
- **React + TypeScript** - Functional components
- **Mantine** - UI component library
- **Tailwind CSS** - Styling & layout
- **Framer Motion** - Animations for file transfer visualization
- **tauri-plugin-window-vibrancy** - macOS Mica/Acrylic effects
- **i18next** - Multi-language support (en, ko, ja, zh, es)

## Features

### ✅ Completed (Phase 1-2)

#### Core Sync Engine
- **One-way sync** (Source → Target)
- **Dry-run mode** - Preview changes before executing
- **Delete missing files** - Optional toggle
- **Checksum comparison** - xxHash64 for accuracy
- **Progress tracking** - Callback-based for UI integration
- **File metadata preservation** - Permissions and modification times

#### CLI Tool
- `--source/-s` - Source directory
- `--target/-t` - Target directory
- `--dry-run/-n` - Preview mode
- `--delete-missing/-d` - Delete files missing in source
- `--no-checksum/-c` - Faster comparison (size/time only)
- **Progress bars** - Visual feedback during sync
- **Detailed output** - Statistics and diff listing

#### System Integration
- **Disk monitoring** - Detects mounted volumes on macOS
- **Volume detection** - Identifies removable media (USB, SD cards)
- **Space calculation** - Total and available disk space
- **Folder watching** - Real-time file system events via notify

### 🚧 Planned (Phase 3-4)

#### UI/UX
- **Dashboard** - Bento grid layout with stats
- **Task management** - Sync task configuration
- **Activity log** - History of sync operations
- **Settings** - Preferences and configuration
- **Window vibrancy** - Translucent sidebar
- **Dark mode** - Sync with system theme

#### Advanced Features
- **SMB protocol support** - Network share integration
- **Real-time progress** - Live file transfer visualization
- **Error handling** - Graceful failure recovery
- **Multi-language** - i18n support

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

# Full sync with progress
./src-tauri/target/release/sync-cli \
  --source /Volumes/SD_Card \
  --target ~/Backups/SD \
  --delete-missing

# Fast sync (no checksums)
./src-tauri/target/release/sync-cli \
  --source /Volumes/SD_Card \
  --target ~/Backups/SD \
  --no-checksum
```

### Running Tests

```bash
# Run all tests
cd src-tauri && cargo test

# Run verification script
./verify.sh
```

## Project Structure

```
SyncWatcher/
├── src/                    # React frontend (Phase 3)
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs           # Tauri commands
│   │   ├── main.rs          # Tauri entry point
│   │   ├── sync_engine/     # Core sync logic
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs    # SyncEngine implementation
│   │   │   └── types.rs     # Type definitions
│   │   └── system_integration.rs  # Disk & folder monitoring
│   ├── src/bin/
│   │   └── sync-cli.rs     # CLI binary
│   ├── Cargo.toml           # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
├── package.json             # Node dependencies
├── tsconfig.json           # TypeScript config
├── vite.config.ts          # Vite config
└── verify.sh              # Verification script
```

## Architecture

### Sync Engine Flow

```
User Request
    ↓
compare_dirs()
    ↓
Walk Source & Target Directories
    ↓
Build HashMaps: {Path → Metadata}
    ↓
Compare:
    - New in source → Copy
    - Modified (checksum/size/time) → Update
    - Missing in source → Delete (optional)
    ↓
Return DryRunResult (diffs + stats)
```

### Disk Monitoring Flow

```
Mount/Unmount Events
    ↓
Read /Volumes Directory
    ↓
Filter System Volumes
    ↓
Calculate Disk Space (statvfs)
    ↓
Return Vec<VolumeInfo>
    ↓
Filter Removable Media for User
```

## Performance

### Benchmarks

- **xxHash64**: ~10 GB/s on M1/M2 chips
- **Directory Walking**: O(n) where n = total files
- **Memory Usage**: O(1) - Streams file data
- **Network**: Zero (local filesystem only, SMB planned)

### Optimization Strategies

1. **Hashing over full content**: Fast checksum vs byte-by-byte
2. **HashMap lookups**: O(1) file comparisons
3. **Async I/O**: Non-blocking file operations
4. **Streaming copies**: Don't load entire files into RAM
5. **Parallel processing**: Tokio async runtime

## Development Guidelines

### Rust Coding Standards

- Use `anyhow::Result` for error handling in CLI
- Use custom `thiserror` types for Tauri commands
- Prefer async I/O (`tokio::fs`) over synchronous
- Document complex sync logic clearly
- Use type-safe serde serialization for Tauri

### Frontend Guidelines (Planned)

- Functional components with hooks
- Separate logic (hooks) from view (components)
- TypeScript strict mode (mirrors Rust structs)
- Use `ts-rs` for auto-generating types from Rust

### Testing

- Unit tests for critical sync paths
- Manual testing with real directories
- CLI verification via `verify.sh`
- Tauri command testing (planned)

## Known Limitations

1. **macOS Only**: DiskMonitor uses `/Volumes` API
2. **No SMB Yet**: Planned for Phase 4
3. **No Real-time UI Progress**: Callback exists but not integrated
4. **FolderWatcher**: Callback-based, not yet connected to Tauri events

## Roadmap

### Phase 1 ✅ - Rust Core & CLI
- [x] SyncEngine implementation
- [x] Dry-run functionality
- [x] CLI binary with clap
- [x] xxHash checksum comparison
- [x] Testing & verification

### Phase 2 ✅ - System Integration
- [x] DiskMonitor for volume detection
- [x] FolderWatcher with notify
- [x] Tauri commands exposure
- [x] macOS-specific optimizations

### Phase 3 🚧 - UI Skeleton
- [ ] React + Mantine + Tailwind setup
- [ ] Window vibrancy (Mica effect)
- [ ] Dashboard layout
- [ ] Task list view
- [ ] Settings page

### Phase 4 🚧 - Wiring & Polish
- [ ] Real-time progress events
- [ ] Framer Motion animations
- [ ] i18n support (en, ko, ja, zh, es)
- [ ] SMB protocol integration
- [ ] Error handling UI
- [ ] Testing & refinement

## Contributing

This project is in active development. See `AGENTS.md` for development guidelines.

## License

[To be determined]

## Acknowledgments

- Tauri - Cross-platform desktop app framework
- notify - File system event monitoring
- xxHash - Fast hashing algorithm
- Mantine - React component library
