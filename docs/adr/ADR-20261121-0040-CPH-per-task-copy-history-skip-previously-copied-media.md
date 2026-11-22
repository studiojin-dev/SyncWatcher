# ADR-20261121-0040-CPH: Per-task copy history to skip previously copied media
Status: Accepted
Date: 2026-11-21
Tags: sync-task, sync-engine, camera, config-store, dry-run
TL;DR: Add an opt-in per-task option (`skipPreviouslyCopied`) that keeps a persistent ledger of photos, RAW files and videos the task has copied (or found already in sync). On later runs, a media file that is missing from the target but whose `file name + size + capture time` key is in the ledger is skipped instead of copied again.

## Context

- Camera workflows copy a memory card into an archive and then cull, rename or move files there. Without memory of past copies, the next run sees deleted or moved files as `New` and copies them back.
- Comparison today is target-state based (ADR-0024, ADR-0037). The target cannot answer "was this copied before?" once the user changes it.
- Card file numbers repeat after a reformat (`DSC00001.JPG`), so the file name alone cannot identify a file.

## Decision

1. Option and scope
   - `SyncTaskRecord.skipPreviouslyCopied: bool` (default `false`). It is exposed in the task editor, the Tauri create/update payloads and MCP create/update inputs.
   - The ledger belongs to one task and lives at `<app support>/copy-history/<task id>.json`, written atomically.
   - The ledger is bound to the target: the file stores the task's configured target path and the identity (inode and creation time) of the folder the run actually copies to, which may be an auto-mounted path that differs from the configured one (ADR-0027). A ledger loads as empty when the path differs, when the folder at that path is a different one (another disk mounted under the same name, or the folder was deleted and recreated), or when the folder is missing. A sync that was still running against the old target when the target changed, a target edited outside the app, or a swapped disk therefore cannot make a target skip files it never received.
   - The identity is taken when the run loads the ledger, or, if the target folder did not exist yet, right before the first file is written (after the sync created the folder). A record is added only while the folder at that path is still the identified one. If the folder at that path changed during the run, the ledger is not saved, so entries copied to the old folder are never attached to the new one. A file is also not skipped if the folder changed between loading the ledger and comparing that file, and a plan that skipped files fails before copying (and again before recording) if the folder changed after the compare.
   - A target folder that exists but whose file system reports no creation time cannot be identified. The ledger is then not loaded for that run, so nothing is skipped or recorded, and a warning is logged.
   - It is deleted together with the task, before other per-task cleanup (a failed delete is logged and does not undo the task delete), and also when the task's target path changes through task update. A target change clears the ledger after the edit has passed validation and right before it is saved, so a rejected edit keeps the ledger; if the ledger cannot be deleted, the edit fails and the target stays as it was, so a stale ledger can never come back when the target is changed back later.
   - Every delete bumps an in-memory per-task generation. A run that loaded the ledger before the delete does not save it, so a target changed A → B → A while a sync to A was running still starts from an empty ledger.
   - There is no reset UI in v1. Changing the source or turning the option off keeps the ledger.
2. Eligible files
   - Only files classified (ADR-0037 `classify`) as `image`, `raw`, `video` or `proxy`. Sidecar metadata (`xml`, `xmp`, `thm`, …) and other files keep the normal behaviour.
3. Identity key: `name + size + capture`
   - `name` is the file name without folders, case preserved.
   - `capture` is `exif:<yyyy-MM-ddTHH:mm:ss>` read only from inside the file: EXIF for photos and RAW, and the MP4/MOV header for videos taken as wall-clock time. Unlike save rules, it ignores a Sony `M01.XML` sidecar, so the same clip gets the same key with or without its sidecar, and the key does not depend on the save rule or the Mac's timezone. If no capture time can be read (CR3, MXF, AVI, …), it is `mtime:<unix seconds>`.
4. When a file is skipped
   - Only in the "target path missing → `New`" branch, and only when the planned target path is really absent on the target file system (on a case-insensitive volume a file renamed only in case is found there and goes through the normal compare). Only after target path planning (save rules, multi-source collision suffixes) has run, so skipping never shifts other files' target names.
   - The ledger is indexed by `(name, size)`; capture time is read only when that pair hits, so a fresh card costs no extra reads.
   - Before the capture time is read, the source's current size and modified time must still match the scan; otherwise the file is not skipped.
   - Files whose target exists keep the existing modified/conflict logic.
   - Every skipped file's source path, size, modified time, capture stamp and planned target path are kept with the plan (not sent to the UI). Before copying, the sync fails if the source changed or disappeared, if its capture stamp is now different, or if a file appeared at the target path. The target-folder check runs after these reads, right before the first write, and both checks run again after the final records, right before the sync reports success. When the plan came from a cached Dry Run, these failures are reported as a stale Dry Run, so the UI asks for a new Dry Run instead of retrying the same plan. A file replaced after the compare is then never left out silently, and a file placed at the target path goes through the normal compare and conflict handling on the next run. Re-reading capture times costs one header read per skipped file.
   - The compare loop checks for cancellation between files and once more after the last file, so cancelling a Dry Run does not keep reading capture times or leave a reusable plan.
5. When the ledger grows
   - Only during a real sync, never during a Dry Run.
   - Each successfully copied eligible file is recorded right after its copy (the copy flushes its last write before it returns), so a cancelled sync keeps what it copied. Failed copies are not recorded.
   - Eligible files that compared as already in sync are recorded after the copy loop, so turning the option on for an existing task also protects files that are already in the target. They are recorded only when their `(name, size)` is not in the ledger yet, which avoids re-reading every file on every run.
   - Before a file is recorded, the source must still have the size and modified time seen at compare time (for in-sync files) or just before the copy (for copied files), and the target must hold a file of that size (for in-sync files, also with the modified time seen at compare time). The capture time is read from the target copy. For a file this run just copied, the target's capture stamp must also equal the source's, so a target that another tool replaced right after the copy is not recorded.
   - In-sync files may have been judged equal by size and modified time only. Before such a file is first recorded, the capture times of source and target must match, and for files keyed by modified time the contents are compared byte by byte. This is a one-time cost per file when the option is turned on for a task that is already synced. When the compare already found equal hashes (checksum mode, or a same-size file whose modified time drifted), the contents are not read again. While these files are recorded, the sync reports a separate `recordingCopyHistory` progress phase with an `n/total` count, so a long first run does not look stuck. It is not the `copying` phase, so these updates are not logged as copied files. This keeps a cached Dry Run, or a source replaced during the copy, from recording a file the target never received.
   - The ledger is saved after the copy step, whatever its outcome.
6. Failure policy: when in doubt, copy
   - An unreadable or unparsable ledger, or a task that cannot be loaded, disables the option for that run and logs a warning. Warnings about the task list carry only the error message, never the raw `tasks.yaml` content.
   - A failed capture-time lookup treats the file as not copied. The modified-time fallback is used only for a readable file that has no capture time; a file that cannot be read is treated as not copied and is not recorded.
   - A failed record or save is logged and does not fail the sync.
   - When the run ends or is cancelled, the ledger is closed before it is saved: pending record work, including byte comparisons, stops reading files, and nothing is added after the save.
   - Saving checks that the task still exists with a read-only task lookup (it never rewrites `tasks.yaml`); a deleted task is skipped quietly, while a task list that cannot be read is logged as a failed save, and the check plus save run under the same lock as the ledger delete. A task deleted while a run was going therefore never gets its ledger back.
   - A cached Dry Run remembers a fingerprint of the ledger it used: target, target folder identity and all entries (or that it used none). If the real sync loads a ledger with a different fingerprint, for example after another disk was mounted at the same path, or cannot load it, the cached plan is stale and a new Dry Run is required.
   - A cached Dry Run that skipped files is reused like any other cached plan, so the real sync copies and overwrites exactly what the preview showed. Skipped files are not cached-plan candidates; they are covered by the skipped-source check and the target-folder check above.
7. Visibility
   - `DryRunResult` gains `skipped_previously_copied` (count) and `previously_copied_paths` (source-relative paths, capped at 1000; files from an extra source (ADR-0039) carry that source's root so cards with the same layout can be told apart). Skipped files are not diffs, so `files_to_copy` and the copy loop are unchanged.
   - The Dry Run result view shows a collapsible "skipped, already copied" list. A real sync logs the skipped count.
   - An all-skipped run copies zero files, so a watch-mode task with auto-unmount takes ADR-0008's zero-copy path (notification and deferred confirmation) like any other no-op run.
8. Dry Run reuse (ADR-0024)
   - Changing the option goes through task update, which already clears the task's dry-run artifact, so a cached plan never mixes option states.

## Consequences

- Deleting or moving copied media in the target no longer brings it back on the next card insert or watch run.
- The key can produce false "not copied" results, which cause a copy rather than a wrongful skip:
  - the in-sync shortcut records only the first file seen for a `(name, size)` pair;
  - FAT/exFAT cards store local modified times, so the `mtime:` fallback can change with the Mac's timezone or DST.
- Two different files with the same name, size and capture second would be treated as the same file. This is accepted as very unlikely for camera output.
- Sidecars of skipped media (e.g. Sony `C0001M01.XML`) are still copied. Linking sidecars to their media files is left for a later change.
- The ledger grows without bound (about 100 bytes per file). There is no pruning in v1.
- An in-sync file keyed by modified time whose bytes differ from the target (same size and modified time) is never recorded, so it is read in full again on every run. This needs an unusual target and only costs time.
- The skipped-file checks read one header per skipped file before the first copy and again before success. With a fresh plan these headers were read seconds earlier and are usually still cached; making these checks cheaper is left for a later change.
- Media copied through conflict review ("force copy" or "rename then copy") is not recorded there. The next sync records it as in sync if it is still in the target; if it was moved first, it is copied again.
- The modified-time fallback can still be used for a file whose first byte is readable but whose metadata area fails to read with an I/O error. A wrongful skip then also needs a ledger entry with the same name, size and modified second, so this is accepted in v1.
- The target identity is the folder's inode and creation time. A block-level clone of the target volume keeps both, so mounting such a clone at the same path in place of the original is not detected, and media copied to the original after the clone was made would be skipped. Volume IDs were not added because removable disks can get a different device number on every mount, which would empty the ledger far more often. This is accepted as rare in v1.
- On a case-insensitive target, a file renamed only in case is not skipped, but the engine's target lookup is case-sensitive, so it is then planned as `New` and overwritten without conflict review. This is existing engine behaviour with the option off as well and is left for a separate change.
- If the task edit fails after the ledger was cleared (saving `tasks.yaml` or the keychain step), the target stays as it was with an empty ledger. This only causes extra copies.
- If a sync is cancelled in the instant between finishing a file and recording it, that file is not recorded. It is in the target, so the next sync records it as in sync.

## Alternatives Considered

1. Content hash as the key
   - Rejected: every run would read every card file in full.
2. Source path + size + modified time
   - Rejected: the same photo on another card or folder would look new, and the key would depend on the card layout.
3. Global ledger shared by all tasks
   - Rejected: a backup task to a second drive must still copy files that another task already imported.
4. Record only files this feature copied
   - Rejected: enabling the option on an existing task would not protect anything already in the target.
