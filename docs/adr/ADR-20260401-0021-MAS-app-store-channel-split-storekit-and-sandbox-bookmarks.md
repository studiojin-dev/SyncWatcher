# ADR-20260401-0021-MAS: App Store channel split with StoreKit supporter state and sandbox bookmarks
Status: Accepted
Date: 2026-04-01
Tags: app-store, distribution, storekit, sandbox, bookmarks, updater, macos, tauri
TL;DR: Ship GitHub DMG and Mac App Store as separate channels, keep optional supporter purchases provider-specific, use best-effort App Store update notices, and persist user-selected path access with security-scoped bookmarks.

## Context

- SyncWatcher already ships through GitHub Releases with a Tauri updater and Lemon Squeezy supporter-license flow.
- The Mac App Store imposes different rules for updater delivery, copy-protection UX, sandbox access, and in-app purchases.
- SyncWatcher stores source and target directories as plain paths today, which is not sufficient for App Sandbox relaunch access.
- The product policy remains "free to use, optional support purchase" rather than feature gating.

## Decision

1. Split distribution into two explicit runtime channels:
   - `github` for direct `.dmg` downloads and GitHub Releases
   - `app_store` for the Mac App Store build
2. Use separate bundle identifiers per channel:
   - `dev.studiojin.syncwatcher` for GitHub
   - `dev.studiojin.syncwatcher.appstore` for Mac App Store
3. Keep supporter state provider-specific:
   - GitHub build uses Lemon Squeezy checkout and license-key lifecycle
   - App Store build uses StoreKit 2 non-consumable purchase and restore flow
4. Preserve the product policy that supporter purchases are optional support only and do not unlock a separate core feature tier.
5. Disable the GitHub updater plugin for the App Store build and replace it with a best-effort App Store metadata check that only offers `Open App Store`.
6. Enable App Sandbox for the App Store build and persist user-selected directory access through security-scoped bookmarks for settings and sync-task paths.
7. Allow first-run import of GitHub DMG settings, sync tasks, and exclusion sets into the App Store channel, but require users to reselect folders when sandbox access must be refreshed.
8. Keep the Apple App Store flow serverless for v1:
   - no custom receipt-validation server
   - no central entitlement service
   - on-device StoreKit transaction checks only

## Consequences

- GitHub and App Store builds can coexist without mixing updater behavior or purchase UX.
- App Store builds comply with Apple distribution rules by removing license-key entry, direct digital-purchase links, and in-app self-updating.
- Source, target, and state-location access become more robust across relaunch in the App Store build, but user-selected bookmark refresh is now part of the failure model.
- `isRegistered` remains a useful UI-level supporter signal, but its backing provider depends on the current channel.
- Release and submission workflow becomes more complex because metadata, entitlements, and review notes now differ by channel.

## Alternatives Considered

1. Keep one universal build and detect the store origin at runtime
   - Rejected: updater, payment UX, and sandbox behavior are channel constraints, not just cosmetic runtime flags.
2. Reuse Lemon Squeezy inside the App Store build
   - Rejected: conflicts with App Store payment expectations for digital goods and review risk.
3. Add a custom receipt-validation server for App Store purchases
   - Rejected: unnecessary for the optional-support model in v1 and would add operational surface area.
4. Keep plain path storage in the App Store build
   - Rejected: breaks relaunch access under App Sandbox and undermines removable-media workflows.
