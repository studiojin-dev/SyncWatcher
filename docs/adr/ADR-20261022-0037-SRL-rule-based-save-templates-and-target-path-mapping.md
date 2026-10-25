# ADR-20261022-0037-SRL: Rule-based save templates and target path mapping

Tags: sync-task, save-rules, templates, exif, camera, config-store, sync-engine, macos, tauri
Status: Accepted
Date: 2026-10-22
TL;DR: Add user-editable "save rule templates" that map each source file to a target folder and file name by media category, capture date, and EXIF values; keep mirroring as the default; make the engine compare, copy, cache, and orphan-scan by the mapped target path.

## Context

SyncWatcher copied every file to the same relative path under the target. Camera cards (Sony `DCIM/100MSDCF` + `PRIVATE/M4ROOT/CLIP|SUB`, Canon, GoPro, DJI) mix proxies, original clips, RAW, JPEG/HEIF and sidecar metadata in vendor-specific folders, and photographers want backups organised by file type, by capture date, by date then type, and with capture date/time or exposure data in file names.

Constraints that shaped the design:

- AGENTS.md forbids new dependencies unless requested. The repository already had a hand-rolled TIFF/JPEG IFD reader for the camera body serial (`camera_identity.rs`).
- The engine's compare step, cached dry-run artifact, target-newer conflict detection, watch-mode runs, recurring runs, MCP jobs and orphan scan all assume `target = target_root / source_relative_path`. Any mapping must reach all of them, or orphan deletion would wipe a remapped backup.
- QuickTime/MP4 `mvhd` creation times are UTC by spec, but many cameras write local wall-clock time; ExifTool's community guidance is to not convert by default. EXIF `DateTimeOriginal` has no zone at all.
- HEIF/HEIC and CR3 store EXIF inside ISOBMFF item structures; CR3 uses a Canon-specific `uuid` layout.

An ADR is required for this decision.

## Decision

### Data model

- New config file `save_rule_templates.yaml` beside `exclusion_sets.yaml`, holding `SaveRuleTemplateRecord { id, name, description, builtIn, dateSource, videoTimestamp, categoryNames, rules[] }`.
- A rule is `{ categories[], extensions[], folder, fileName }`. Empty `categories`/`extensions` match anything. Rules are evaluated in order; the first match wins; files matching no rule keep their original relative path.
- Media categories are `proxy | video | raw | image | metadata | other`, classified from the extension and vendor layout hints (`SUB`/`PROXY` folders, Sony `…S0n` suffix, `.LRV`/`.LRF`). Users override classification per template through extension-based rules; `categoryNames` controls what `{category}` renders.
- `SyncTaskRecord.saveRuleId: Option<String>`; `None` keeps today's mirroring behaviour byte-for-byte. Update requests distinguish "omit = keep" from "null = clear".
- Four built-in presets (`camera-by-type`, `camera-by-date-type`, `camera-by-date`, `camera-dated-filenames`) are created on first load, editable, and restored by an explicit reset command that keeps user templates.

### Templates and metadata

- Tokens: `{yyyy} {yy} {MM} {dd} {HH} {mm} {ss} {date} {time} {datetime} {name} {ext} {EXT} {ext_lower} {folder} {path} {category} {make} {model} {camera} {serial} {iso} {fnumber} {aperture} {shutter} {focal}`. Unknown tokens, unclosed braces, `..`, backslashes, control characters and `/` in file-name templates are rejected at save time. Token values never create folder levels (`/` becomes `_`), rendered segments are sanitised, and an unsafe result falls back to the original relative path. The original extension is appended when a file-name template drops it, and `{ext}` keeps the original case so `DSC00001.ARW` stays `.ARW`.
- Date tokens are locale-independent by design: `{date}` is always `yyyy-MM-dd`, `{time}` is `HHmmss`, `{datetime}` is `yyyyMMdd_HHmmss`, and the built-in presets use the year-first ISO order. The renderer never consults the system language or region. Reasons: (1) the engine compares, caches and orphan-scans by the mapped target path, so a locale-driven date order would re-map an entire library when the Mac's language changes; (2) folder names act as a sort key, and only year-first names sort chronologically in the Finder. Users who want a regional order compose it explicitly (`{dd}-{MM}-{yyyy}`, `{MM}-{dd}-{yyyy}`); the token help and placeholders document this.
- Built-in preset names and descriptions are stored in English in `save_rule_templates.yaml` (they are editable and reachable through MCP). The front end translates them for display only, and only while the stored text still equals the English default (`src/utils/saveRuleTemplateDisplay.ts`); edited text is shown as saved. Stored data and backend/MCP output stay English.
- Metadata is read by a dependency-free reader in `save_rules::{exif, isobmff, metadata}`: JPEG APP1, TIFF-based RAW (standard magic plus ORF/RW2 magics), Fuji RAF (embedded JPEG), HEIF/HEIC/AVIF (`meta/iinf/iloc` Exif item), MP4/MOV `moov/mvhd` via seek, and the Sony `C0001M01.XML` sidecar `CreationDate` (preferred for video because it carries an offset; `SUB/*S0n.MP4` proxies use the matching `../CLIP/<base>M01.XML`, and `.xml` sidecars take their own `CreationDate` so they land beside their clip). `camera_identity.rs` now delegates to this reader.
- `dateSource = capture` uses EXIF `DateTimeOriginal` (falling back to `DateTime`), the sidecar, or `mvhd`, and otherwise the file's modified time; `modified` uses only the modified time. `videoTimestamp = local` (default) treats `mvhd` as local wall-clock; `utc` converts with the Mac's zone. CR3, MXF, AVI and other formats have no capture metadata and use the modified time; the UI says so.
- Metadata is read only for files whose matched rule actually references a date (with `capture`) or camera token, in a blocking-pool task, with bounded reads (a 64 KiB head for images, re-read up to 512 KiB only when no EXIF was found; header-only seeks for ISOBMFF).

### Engine integration

- `SyncOptions.save_rule: Option<SaveRuleTemplateRecord>` (serialisable, so no trait objects). `FileDiff`, `SyncFileEntry` and `TargetNewerConflictCandidate` gain an optional target relative path with `#[serde(default)]`, so stored payloads and UI consumers stay compatible.
- `compare_dirs_internal` maps every source file once (sorted order) before comparing, looks the target up at the mapped path, and emits diffs/conflicts carrying the mapped path. `sync_files_from_dry_run` copies to the mapped path. Within one run, two sources that render to the same target get deterministic `_2`, `_3` suffixes.
- The cached dry-run artifact snapshots the resolved template and validates candidates at their mapped target paths, so editing a template invalidates `Sync Now from Dry Run`.
- `find_orphan_files` subtracts the mapped target set (plus its ancestor directories) when a rule is active; without a rule the old behaviour is unchanged.
- Runtime config carries the templates; watch, recurring, MCP and manual runs all resolve the task's template server-side. Front-end commands pass `saveRuleId` and the backend rejects unknown ids.

### UI

- Settings gains a "Save Rule Templates" manager with a rule editor and a server-rendered preview of fixed sample files, so the preview cannot drift from the real renderer.
- The task editor gets a "Save rule" selector (default: mirror). Task cards show the template name; dry-run and sync result trees show `→ target path` when it differs from the source path.

## Consequences

### Positive

- Camera backups can be organised by type, date, or both, with date/EXIF-based file names, without external tools.
- Mirroring tasks behave exactly as before; the new field defaults to none and all new payload fields are optional.
- Orphan scan, conflicts, cached dry-run reuse, watch and scheduled runs all honour the mapping, so no path can be silently treated as deleted.

### Negative / trade-offs

- Dry-run and sync read file heads for metadata-dependent rules, adding I/O proportional to the number of matched media files.
- Collision suffixes depend on the sorted set of colliding sources; adding a file that sorts earlier can renumber later ones and re-copy them. Presets keep `{name}` in file names to make collisions rare.
- Capture metadata coverage is narrower than "all cameras": HEIF via `iloc` construction method 0 only, no CR3, no RW2 embedded-JPEG fallback, no MXF. Those fall back to the modified time.
- The edit form of an untouched built-in template shows the stored English name and description, not the translation, so that saving never writes a localized string into the YAML.
- Deleting a template that a task references is refused, and creating or updating a task with an unknown `saveRuleId` is rejected (UI and MCP). A template id can therefore only go missing through a manual YAML edit; in that state manual dry-run/sync fail with "Save rule template not found" while watch and scheduled runs fall back to mirroring.

## Alternatives considered

### Add an EXIF/ISOBMFF crate

Rejected: AGENTS.md forbids new dependencies unless explicitly requested, and the needed subset (a dozen tags, `mvhd`, HEIF `iloc`) is small enough to keep in-tree with bounded parsing.

### Resolve rules in the front end and send target paths per file

Rejected: the engine compares and copies thousands of files; the backend already owns exclusion resolution and the dry-run artifact, and watch/recurring/MCP runs have no front end.

### Treat `mvhd` as UTC by default

Rejected: many cameras store local time there, and the Sony sidecar carries an explicit offset, so the default is "as recorded" with an opt-in UTC conversion.

### Disable orphan scan for rule-based tasks

Rejected in favour of a mapping-aware scan, because users will want to find leftovers in reorganised backups too.
