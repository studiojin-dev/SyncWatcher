# App Store Launch Checklist

## Channel Setup

- Confirm the App Store build uses bundle identifier `dev.studiojin.syncwatcher.appstore`.
- Confirm the GitHub DMG build keeps bundle identifier `dev.studiojin.syncwatcher`.
- Confirm the App Store build disables the GitHub updater and only offers `Open App Store`.
- Confirm the App Store build hides Lemon Squeezy checkout, license-key entry, and Buy Me a Coffee links.
- Confirm the GitHub DMG build keeps Lemon Squeezy checkout, license activation, and GitHub update flow.

## Release Path

- Treat the Mac App Store path as local/manual release work; do not submit or upload it from GitHub Actions.
- Keep GitHub Actions as verification-only for the App Store path.
- Keep `scripts/release/local-macos-release.sh` scoped to the GitHub DMG distribution flow.
- Set `VITE_APP_STORE_URL` for the public App Store listing fallback even when `SYNCWATCHER_APP_STORE_APP_ID` is only injected locally for App Store builds.

## App Store Connect

- Create the macOS app as a free app.
- Add the non-consumable in-app purchase `Lifetime Supporter` with product ID `LifetimeSupporter`.
- Set the App Store product page URL in `VITE_APP_STORE_URL`.
- Inject `SYNCWATCHER_APP_STORE_APP_ID` locally for App Store builds when you want best-effort metadata-based update checks.
- Fill in the Privacy Policy URL and Support URL.
- Upload screenshots for the current macOS release.
- Complete Paid Applications, tax, and banking setup before submitting the IAP.
- Use the Apple Standard EULA. Do not add a custom EULA unless legal requirements change.

## Review Notes

Use review notes that clearly state the following:

- SyncWatcher is free to download and use.
- `Lifetime Supporter` (`LifetimeSupporter`) is an optional one-time support purchase.
- The purchase does not unlock additional sync features or change existing behavior.
- The Mac App Store build uses StoreKit 2 only.
- The GitHub DMG build is a separate distribution channel with Lemon Squeezy support purchases.
- The Mac App Store build checks for updates on a best-effort basis and opens the App Store instead of installing updates directly.
- Folder access uses user-selected security-scoped bookmarks because the Mac App Store build runs in the App Sandbox.

## Manual Verification

- Verify GitHub DMG still supports Lemon Squeezy purchase, license activation, and GitHub updater.
- Verify the Mac App Store build shows StoreKit purchase and restore only.
- Verify the Mac App Store build can re-open source, target, and state-location bookmarks after relaunch.
- Verify removable-volume reinsert flows work with refreshed sandbox access.
- Verify the Mac App Store update notice opens the App Store listing and never downloads or installs in-app.
- Verify the first-run legacy import copies settings, sync tasks, and exclusion sets without copying Lemon license state.
- Verify Terms and Privacy links are reachable from Settings and About.
