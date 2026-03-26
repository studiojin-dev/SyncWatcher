# ADR-20260324-0016-LIC: Lemon Squeezy handles supporter licensing while GitHub Releases remain the distribution origin for v1
Status: Accepted
Date: 2026-03-24
Tags: licensing, release, distribution, updater, lemonsqueezy, github
TL;DR: Use Lemon Squeezy for optional supporter purchases and license-key lifecycle, but keep GitHub Releases as the source of install files and Tauri updater metadata in v1.

## Context

- SyncWatcher already ships macOS artifacts and Tauri updater metadata through GitHub Releases.
- The product policy remains "free to use, optional supporter license" instead of gating core functionality behind a purchase.
- The app already includes Lemon Squeezy activation and validation primitives, but product identifiers were hard-coded and there was no local deactivation flow for moving a license between machines.
- Lemon Squeezy customer flows can issue license keys and link customers to downloads, but v1 does not require Lemon-hosted build artifacts.

## Decision

1. Keep GitHub Releases as the authoritative source for:
   - `.dmg` and updater artifacts
   - `latest.json` consumed by Tauri updater
   - release automation and signing
2. Use Lemon Squeezy only for:
   - checkout and receipts
   - customer-facing license key issuance
   - runtime license activation, validation, and instance deactivation
3. Treat the supporter license as an identity/support signal only in v1:
   - update `isRegistered` UI state
   - do not gate core backup features
4. Move Lemon Squeezy product identifiers out of Rust source constants and into build/runtime configuration:
   - `SYNCWATCHER_LEMON_SQUEEZY_STORE_ID`
   - `SYNCWATCHER_LEMON_SQUEEZY_PRODUCT_ID`
   - optional `SYNCWATCHER_LEMON_SQUEEZY_VARIANT_ID`
5. Add a local "remove license" flow that deactivates the current Lemon Squeezy instance and clears cached local state.
6. Keep the Lemon Squeezy checkout URL configurable from frontend build environment via `VITE_LEMON_SQUEEZY_CHECKOUT_URL`.
7. Require release builds to provide the Lemon Squeezy store/product identifiers so shipped binaries cannot silently lose license verification.

## Consequences

- Users continue to download and auto-update from GitHub Releases regardless of whether they bought an optional supporter license.
- Supporter purchases remain simple: purchase in Lemon Squeezy, receive the key, paste it into the app, and optionally remove it before moving to another machine.
- Release automation stays close to the current pipeline and avoids introducing a custom update server in v1.
- If future requirements demand customer-only file delivery from Lemon Squeezy, SyncWatcher will need a second-phase design for asset synchronization and likely a dynamic update service.

## Alternatives Considered

1. Move all downloads to Lemon Squeezy immediately
   - Rejected: unnecessary for the optional-support model and would complicate updater integration.
2. Keep hard-coded Lemon Squeezy IDs in source
   - Rejected: makes per-environment configuration brittle and requires code changes for storefront changes.
3. Gate core app functionality behind the supporter license in v1
   - Rejected: conflicts with the current free-use product policy and would expand scope into entitlement enforcement.
