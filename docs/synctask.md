# SyncTask Guide

SyncTask is the reusable backup unit inside SyncWatcher. It stores a Source, a Target, and the options that define how the copy job should behave.

## Dashboard

The dashboard is the first screen users see. It shows task state, progress, and quick controls in one view.

## Add Or Edit A Task

![SyncTask editor](../manual/SCR-20260324-synctask-0.png)

Create a new SyncTask or edit an existing one by choosing the Source, Target, and task options.

The task editor keeps the main controls close together so a recurring workflow can be adjusted quickly.

## Removable Storage Targets

You can choose removable storage such as an SD card as the Target. Combined with `watchmode`, this can also fit workflows that copy automatically and unmount after sync.

## Checksum Mode

![Checksum mode](../manual/SCR-20260324-synctask-3-checksum.png)

Use checksum mode when post-copy verification matters more than speed. After the copy completes, SyncWatcher validates the copied files again.

## Watch Mode

![Watch mode](../manual/SCR-20260324-synctask-4-watchmode.png)

When `watchmode` is enabled, SyncWatcher watches the Source folder and starts a new copy run when files change.

## Excluded File Types

![Exclude file types](../manual/SCR-20260324-synctask-5-excluset.png)

Choose file types that should be excluded from copying. Additional patterns can be added in `Settings`.

## Save Rules

Choose a **Save rule** in the task editor to sort copied files into folders and rename them instead of mirroring the source layout. The default, *Mirror source folder structure*, behaves exactly as before.

Built-in templates:

- **Camera: by file type** - `Proxy/`, `Video/`, `RAW/`, `Photo/`, `Metadata/`, `Other/` folders, original file names.
- **Camera: by capture date, then type** - `2026-10-22/RAW/DSC00001.ARW`.
- **Camera: by capture date** - `2026/2026-10-22/DSC00001.ARW`, all types together.
- **Camera: dated folders and file names** - `2026-10-22/RAW/20261022_140355_DSC00001.ARW`.

Built-in template names and descriptions are shown in the app language. If you edit a name or description, your text is shown as saved.

Templates are edited in `Settings` > `Save Rule Templates`. A template is an ordered list of rules; each rule matches file types (proxy, video, RAW, photo, metadata, other) and/or extensions and defines a folder template and a file name template. The first matching rule wins and unmatched files keep their original relative path. Tokens such as `{yyyy}`, `{MM}`, `{dd}`, `{HH}`, `{mm}`, `{ss}`, `{date}`, `{datetime}`, `{name}`, `{ext}`, `{category}`, `{camera}`, `{iso}`, `{fnumber}` and `{shutter}` are filled from the capture date and EXIF data; the editor shows a live preview on sample files.

Date tokens always use the year-first ISO order regardless of the system language or region: `{date}` is `yyyy-MM-dd`, `{time}` is `HHmmss`, and `{datetime}` is `yyyyMMdd_HHmmss`. Target paths therefore never change when you switch the Mac's language, so the next sync does not see files as new or as deletion candidates. If you want a day-month-year or month-day-year order, compose it yourself with `{dd}-{MM}-{yyyy}` or `{MM}-{dd}-{yyyy}`; note that only year-first folder names sort chronologically in the Finder.

Capture time and camera values are read from JPEG, HEIF/HEIC and TIFF-based RAW files (ARW, NEF, CR2, DNG, ORF, RW2, RAF and similar). MP4/MOV clips use the Sony XML sidecar when present, otherwise the file header. Formats without supported metadata (CR3, MXF, AVI and others) fall back to the file's modified time.

Dry Run and sync results show `→ target path` next to files whose destination differs from the source path, and the orphan finder understands the mapped layout.

## Task Card Controls

1. Checksum mode indicator
2. `watchmode` enabled indicator
3. `autounmount` mode indicator
4. `dry-run` button to preview changes without copying
5. Manual copy button
6. `watchmode` toggle button
7. Deleted-item finder for files present only in Target

After a `dry-run` completes, the result screen can launch `Sync Now` directly from the cached Dry Run result. Manual sync now also shows the pre-copy scan and compare phase so users can see which path is currently being inspected before file copying starts.
