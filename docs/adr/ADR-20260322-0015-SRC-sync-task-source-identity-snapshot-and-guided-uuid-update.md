# ADR-20260322-0015-SRC: SyncTask source identity snapshot and guided UUID update

Tags: sync-task, uuid, removable-media, config-store, ux, macos, tauri
Status: Accepted
Date: 2026-03-22
TL;DR: Keep UUID source tokens as the runtime contract, persist extra removable-media identity hints beside each task, and offer conservative user-approved UUID update recommendations when a stored UUID no longer resolves.

## Context

SyncWatcher already supports UUID-based SyncTask sources through `[DISK_UUID:...]`, `[VOLUME_UUID:...]`, and legacy `[UUID:...]` tokens. That works while the mounted volume still exposes the same UUID, but removable media can lose or change the previously stored UUID after reformatting or repartitioning.

Apple's Disk Arbitration documentation explicitly states that device description keys are not uniform across all devices and transports, so callers must tolerate missing metadata and hardware-specific variance. In practice:

- `VolumeUUID` is a filesystem UUID and commonly changes after reformatting.
- media or partition UUIDs can also change after repartitioning or some formatting flows.
- some devices expose a stable storage or card serial number through IOKit, while others expose only a USB bridge serial number or nothing useful at all.

That means SyncWatcher cannot rely on one universal immutable identifier for removable media on macOS.

## Decision

We keep the existing UUID token syntax and runtime resolution behavior unchanged. Runtime sync and dry-run still resolve only the stored UUID token forms.

We add an optional `sourceIdentity` snapshot to UUID-source SyncTasks. This snapshot stores the best currently available identity hints from mounted media, including:

- device serial
- media UUID
- device GUID
- transport serial
- bus protocol
- filesystem name
- total bytes
- volume name
- last seen disk UUID
- last seen volume UUID

The snapshot is refreshed when a UUID-source task is created, edited, or explicitly updated to a new recommendation while the corresponding media is mounted.

When a stored UUID no longer resolves, SyncWatcher compares the saved snapshot against currently mounted removable volumes and produces a recommendation only when exactly one high-confidence candidate exists. The confidence order is:

1. exact device serial
2. exact device GUID
3. exact media UUID
4. exact last-seen disk or volume UUID
5. unique composite fallback: same total bytes, same filesystem, and either matching volume name or the configured source subpath exists on the candidate mount

`transportSerial` is treated as low-confidence metadata only. It may strengthen the composite fallback when the candidate is already unique, but it must never be used as the sole proof for automatic recommendation because generic USB bridge serials can identify the reader instead of the inserted media.

Recommendations do not rewrite tasks automatically. The app opens a review modal, shows the evidence and confidence label, and lets the user:

- update the task to the proposed UUID
- dismiss the recommendation
- open the task editor

Manual sync, dry-run, background runtime sync, startup refresh, and `volumes-changed` all funnel into the same review flow when a UUID-based source cannot be resolved and a recommendation is available.

## Consequences

### Positive

- preserves backward compatibility for stored UUID source tokens
- avoids silent task rewrites for ambiguous removable-media matches
- uses stronger identifiers when macOS exposes them, while still working on devices that only expose weaker hints
- gives users a guided repair path after reformatting or media replacement

### Negative

- persisted SyncTask records now carry more metadata than the runtime strictly needs
- recommendation quality depends on device-specific metadata exposure
- some stale UUID cases will remain unresolved when matching evidence is weak or ambiguous

## Rejected Alternatives

### Replace UUID source tokens with a richer hardware identifier syntax

Rejected because it would break or complicate the current runtime contract, migration surface, and user-facing task format. Richer identifiers are useful as auxiliary evidence, but not reliable enough to become the only runtime key across all macOS removable-media paths.

### Auto-update UUID-source tasks whenever one candidate looks likely

Rejected because removable-media metadata is not uniform and bridge-level identifiers can be misleading. A conservative user-approved recommendation flow is safer than silent mutation.

### Use transport serial as a primary removable-media identifier

Rejected because macOS can expose a USB reader or bridge serial instead of the actual card identity, especially for SD card readers and generic USB mass-storage bridges.

## References

- [Apple Disk Arbitration Programming Guide: Manipulating Disks and Volumes](https://developer.apple.com/library/archive/documentation/DriversKernelHardware/Conceptual/DiskArbitrationProgGuide/ManipulatingDisks/ManipulatingDisks.html)
- [Apple Disk Arbitration Programming Guide: Arbitration Basics](https://developer.apple.com/library/archive/documentation/DriversKernelHardware/Conceptual/DiskArbitrationProgGuide/ArbitrationBasics/ArbitrationBasics.html)
- [Apple Disk Arbitration framework docs](https://developer.apple.com/documentation/diskarbitration)
- [Apple kIOMediaUUIDKey](https://developer.apple.com/documentation/kernel/kiomediauuidkey?changes=_1_6)
- [DADisk.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/DiskArbitration.framework/Headers/DADisk.h)
- [IOMedia.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/IOKit.framework/Headers/storage/IOMedia.h)
- [IOStorageDeviceCharacteristics.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/IOKit.framework/Headers/storage/IOStorageDeviceCharacteristics.h)
- [IOStorageCardCharacteristics.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/IOKit.framework/Headers/storage/IOStorageCardCharacteristics.h)
