# ADR-20260812-0031-OSS: Apache-2.0 licensing with separate StudioJin brand assets
Status: Accepted
Date: 2026-08-12
Tags: licensing, open-source, trademark, distribution, supporter, app-store
TL;DR: License SyncWatcher source and derived object code under Apache-2.0 while reserving StudioJin trademarks and enumerated brand assets, without changing the GitHub or Mac App Store supporter channels.

## Context

- SyncWatcher was publicly readable under PolyForm Noncommercial 1.0.0 while StudioJin's official binaries were described as proprietary distributions.
- That structure prevented commercial source use and made source, binary, supporter, and distribution rights harder to understand.
- SyncWatcher's supporter purchases do not gate core functionality, so describing Lemon Squeezy's provider key as a software-use license creates a false entitlement implication.
- StudioJin still needs to protect the SyncWatcher name, application icon, and official-distribution identity from misleading use by modified builds.
- The Mac App Store and GitHub Releases have different updater, sandbox, and payment constraints established by ADR-20260401-0021-MAS.

## Decision

1. License the SyncWatcher source code under Apache License 2.0 using the SPDX identifier `Apache-2.0` in package metadata.
2. Treat Object-form distributions derived from the Apache-2.0 Work as governed by Apache-2.0. StudioJin's Terms may govern official distribution services, support, payments, and store relationships but must not reduce Apache-2.0 rights.
3. Keep `SyncWatcher`, the SyncWatcher logo and official application icon, `StudioJin`, StudioJin logos, and enumerated marketing/packaging assets outside the Apache-2.0 Work.
4. Maintain `TRADEMARKS.md` for permitted truthful references and anti-confusion rules, and `BRAND_ASSETS.md` as the path-level asset classification.
5. Require forks and independently redistributed modified builds to use their own name and application icon. Allow truthful references such as “Fork of SyncWatcher” and links to the original project when they do not imply endorsement or official status.
6. Keep Lemon Squeezy's internal license-key API and persisted implementation fields where compatibility requires them, but present the user-facing concept as a supporter key and supporter status.
7. Keep both official distribution channels and their existing provider-specific purchase paths:
   - GitHub Releases with optional Lemon Squeezy supporter keys
   - Mac App Store with optional StoreKit `Lifetime Supporter`
8. Supporter purchases do not add, remove, or condition Apache-2.0 rights and do not unlock a separate core feature tier.
9. Bundle a generated, complete Rust dependency license report and expose frontend dependency license and notice text in the About view. Keep the generation inputs in the repository so notices can be reproduced from the lockfiles.
10. Record the source, license, trademark status, and release-evidence expectation for third-party and generated visual assets in `BRAND_ASSETS.md`.
11. Remove unused third-party template logos and generated marketing images rather than carrying provenance and trademark obligations for assets that are not used by the application or its documentation.

This decision supersedes the licensing characterization and user-facing “supporter license” terminology in ADR-20260324-0016-LIC. Its GitHub distribution and Lemon Squeezy provider-integration decisions remain in force. ADR-20260401-0021-MAS remains in force for channel separation, App Store updates, StoreKit, sandbox bookmarks, and local submission.

## Consequences

- Commercial use, modification, sublicensing, and redistribution are allowed under Apache-2.0, including for forks.
- Official StudioJin builds no longer rely on a separate proprietary binary grant to restrict Apache-2.0 redistribution rights.
- Fork maintainers must replace protected branding even though they may retain Apache-required notices and truthfully describe the project's origin.
- Packaging paths remain stable because brand assets are classified in place instead of being moved.
- Internal names such as `license_key` and `isRegistered` remain temporarily where renaming would create provider or persistence compatibility risk; UI copy no longer presents them as software-use entitlements.
- Existing App Store sandbox, updater, StoreKit, and release workflows continue unchanged.
- Release artifacts include project notices plus `THIRD_PARTY_LICENSES.html`; frontend production builds include `oss-licenses.json` and render its license text in the application.
- The official SyncWatcher name, icon, packaging artwork, and current documentation captures remain reserved; removal is limited to unused template/generated assets and stale captures.

## Alternatives Considered

1. Keep PolyForm Noncommercial for source code
   - Rejected: it blocks the intended commercial-use, modification, and redistribution rights.
2. Apply Apache-2.0 to every image and brand asset
   - Rejected: Apache-2.0 does not grant trademark rights, and an explicit asset boundary better prevents misleading official-looking forks.
3. Move all brand files into a new directory
   - Rejected for now: Tauri, DMG, and App Store packaging use fixed paths, so a path-level manifest provides the boundary without unnecessary release risk.
4. Rename every internal Lemon Squeezy license symbol immediately
   - Rejected: the provider API uses license terminology, and a mechanical internal rename would add regression risk without improving the user-facing rights explanation.
