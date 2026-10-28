# ADR-20261028-0039-MSR: Multi-source sync task into one target
Status: Accepted
Date: 2026-10-28
Tags: sync-task, sync-engine, camera, config-store, safety, watch-mode, macos
TL;DR: Let one sync task carry any number of additional sources (e.g. several memory cards, or both slots of a dual-slot camera) that sync into the task's single target in one run, instead of relaxing the cross-task "targets must not overlap" rule. Identical-content collisions (xxHash) are copied once; differing-content collisions get a per-source letter suffix (`_b`, `_c`, …); unavailable sources are skipped; orphan scan is refused unless every source is available.

## Context

- Several memory cards often belong in one archive directory. A dual-slot camera is the common case: it exposes two volumes, and the slots may hold identical files (backup recording), different media types (photo/video), or different formats (RAW/JPEG/HEIF), while camera makers use the same folder layout on both cards. The general case is N sources and one target.
- ADR-20260211-0003 and ADR-20260326-0018 forbid two tasks from sharing a target (same path or parent/child), because:
  - overwrite: both cards can hold the same relative path (`DCIM/100MSDCF/DSC00001.JPG`), and the per-run `_2` suffixing of ADR-20261022-0037 only works inside one run of one task;
  - cleanup: orphan scan treats every target file missing from *its* source as orphaned, so a shared target lists the other task's files for deletion;
  - concurrency: watch tasks may run in parallel against the same target.
- All three hazards come from tasks that do not know about each other. Putting both sources inside one task removes them without weakening the cross-task rules.

## Decision

1. Data model (additive, backward compatible)
   - `SyncTaskRecord.extraSources: Vec<ExtraSourceRecord>` with `#[serde(default)]`; any number of entries. The existing `source*` fields stay the primary source; stored configs and MCP schemas keep working.
   - `ExtraSourceRecord` holds the same source fields as the primary (`source`, `sourceBookmark`, `sourceType`, `sourceUuid`, `sourceUuidType`, `sourceSubPath`, `sourceIdentity`). SMB auto-mount is not supported for extra sources in this iteration.
   - Each extra source is normalized with the same rules as the primary source.
2. Validation
   - Every source must not overlap the task target (same path or parent/child), as in ADR-0003.
   - Sources of one task must not overlap each other (otherwise files are walked twice).
   - Cross-task target/target overlap remains forbidden (unchanged).
   - Watch-chain edges (ADR-0018) are built when a watch task target overlaps *any* source of another watch task.
3. Engine
   - The engine scans every available source in declared order (primary first), then sorted relative paths.
   - The first source to render a target relative path claims it. A later source rendering the same target relative path:
     - same size and same xxHash64 content hash as the claiming file: skipped (dual-slot "backup" recording writes identical files to both cards);
     - otherwise: the file name gets the letter of its source position before the extension (`DSC00001_b.JPG` for the 2nd source, `_c` for the 3rd, …; the primary source is `a` and keeps the plain name). The letter is tied to the source position, so the same file maps to the same name on every run and shows which card it came from. If the lettered name is itself taken, the existing numeric resolver (`_2`, `_3`, …) applies.
   - `FileDiff`, `SyncFileEntry`, `TargetNewerConflictCandidate` and dry-run artifact candidates gain an optional source root (`#[serde(default)]`; `None` = primary), so copy, cached dry-run validation (ADR-0024) and conflict review locate the right file.
4. Unavailable sources
   - Sync and dry-run run with whichever sources are connected — the first one included — and skip the others, logging each skipped source at info level (a missing card is a normal state, not an error). The first connected source becomes the engine's primary source. The run fails only when no source of the task is connected. Tasks without extra sources keep the old rule (the source is required).
   - The suffix letter comes from the source's position in the task, not from the set of sources connected in that run, so a skipped source never shifts the letters of the others.
   - Orphan scan and orphan deletion are refused unless every source is available, because a missing card would make all of its files look orphaned. The refusal uses the error prefix `Source not connected:`, which the orphan view shows as a notice ("connect every card") instead of an empty "no orphan files" result.
5. Watch mode and auto-unmount
   - Watch mode watches every connected source (the first one included) with one watcher and coalesces their events into the single task run queue (ADR-0004). When an extra source is connected or disconnected, the task's watcher restarts so the newly inserted card is watched and synced.
   - Auto-unmount applies to every UUID source of the task after a successful run.
6. Not in this iteration: source recommendations (matching an inserted card to a task) and MCP task create/update arguments cover the primary source only. Tasks read through MCP include `extraSources`.

## Consequences

- Dual-slot cameras (and any "several cards into one archive" workflow) work with one task, without loosening the overwrite/orphan safety rules.
- A run with one card missing can still copy the other card, but orphan cleanup waits until all cards are present.
- Collision detection happens within one run. When only a later source is present and it holds a file whose target path matches a different file copied earlier from another source, that file is compared against the existing copy as an ordinary update (overwrite if older, conflict review if newer), as for single-source tasks. Dual-slot recording modes (backup, photo/video split, RAW/JPEG split) do not normally produce such pairs.
- Task records, runtime payloads, dry-run artifacts and engine result types grow optional fields; old payloads deserialize unchanged.

## Alternatives Considered

1. Allow several tasks to share a target (option C)
   - Rejected: needs cross-task orphan scans, cross-task collision resolution and target-level serialization; wider change and easier to get wrong.
2. Per-slot sub-folders under one parent (`.../A`, `.../B`)
   - Works today, but does not give one merged folder.
3. Replace `source*` fields with `sources: Vec<...>`
   - Rejected: breaks stored configs, MCP schema and many call sites for no functional gain.
4. Suffix every collision, including identical content
   - Rejected: dual-slot backup recording would double disk usage.
5. Numeric `_2` suffix (as in ADR-0037) for cross-source collisions
   - Rejected: the number depends on how many collisions came first, so it does not tell which card a file came from; a source-position letter is stable and readable.
6. Fail the run when any source is unavailable
   - Rejected: cards are often inserted one at a time; only the destructive orphan flow needs every source.
