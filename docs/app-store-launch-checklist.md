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

## App Review Guideline Gates

Source of truth: Apple App Review Guidelines, last reviewed for this checklist
on 2026-04-25.

- Guideline 2.4.5(i): Mac App Store builds MUST run in the App Sandbox and
  use appropriate macOS APIs, including security-scoped bookmarks, for
  user-selected file access.
- Guideline 2.4.5(ii): Mac App Store builds MUST be packaged and submitted
  with Apple/Xcode-provided technologies; they MUST NOT use third-party
  installers, shared install locations, or multi-app install bundles.
- Guideline 2.4.5(iii): Launch-at-login and any background process behavior
  MUST require explicit user consent and MUST NOT continue after the user quits
  SyncWatcher unless the user has consented to that behavior.
- Guideline 2.4.5(iv): Mac App Store builds MUST NOT download or install
  standalone apps, kexts, additional code, or resources that add functionality
  or significantly change the reviewed app.
- Guideline 2.4.5(v): Mac App Store builds MUST NOT request root escalation or
  use setuid attributes.
- Guideline 2.4.5(vi): Mac App Store builds MUST NOT show a launch license
  screen, require license keys, or implement SyncWatcher-owned copy protection.
- Guideline 2.4.5(vii): Mac App Store builds MUST follow an App Store-only
  update policy and use the Mac App Store as the only update distribution path.
  GitHub updater flows, direct-download update links, in-app update downloads,
  in-app update installs, menu-bar update commands, and external updater
  mechanisms are release blockers. The only allowed update action is opening
  the Mac App Store listing from the in-app update notice.
- Guideline 2.4.5(viii): Mac App Store builds SHOULD run on the currently
  shipping macOS and MUST NOT depend on deprecated or optionally installed
  technologies.
- Guideline 2.4.5(ix): Mac App Store builds MUST include all language and
  localization support inside the single app bundle.
- Guidelines 2.1 and 2.3: Review submissions MUST be complete, stable, and
  accurate. Metadata, screenshots, previews, and review notes MUST match the
  submitted binary, describe material changes specifically, and avoid hidden or
  undocumented behavior.
- Guideline 3.1.1: Mac App Store digital support purchases MUST use StoreKit
  in-app purchase. Lemon Squeezy checkout, license-key unlock, Buy Me a Coffee,
  and external purchase calls to action MUST NOT appear in the App Store build.
- Guidelines 5.1 and 5.2: Privacy Policy and Support URL MUST be present and
  reachable. User data access MUST be permission-based and minimized. App
  assets, metadata, screenshots, third-party services, and marketing copy MUST
  be covered by the required rights and licenses.

## Review Notes

Use review notes that clearly state the following:

- SyncWatcher is free to download and use.
- `Lifetime Supporter` (`LifetimeSupporter`) is an optional one-time support purchase.
- The purchase does not unlock additional sync features or change existing behavior.
- The Mac App Store build uses StoreKit 2 only.
- The GitHub DMG build is a separate distribution channel with Lemon Squeezy support purchases.
- The Mac App Store build checks for updates on a best-effort basis and opens the App Store instead of installing updates directly.
- Folder access uses user-selected security-scoped bookmarks because the Mac App Store build runs in the App Sandbox.
- The Mac App Store build does not include direct download links, GitHub
  updater installation, in-app update installation, menu-bar update commands,
  external updater mechanisms, license-key entry, or external digital-purchase
  calls to action.

## Manual Verification

- Verify GitHub DMG still supports Lemon Squeezy purchase, license activation, and GitHub updater.
- Verify the Mac App Store build shows StoreKit purchase and restore only.
- Verify the Mac App Store build can re-open source, target, and state-location bookmarks after relaunch.
- Verify removable-volume reinsert flows work with refreshed sandbox access.
- Verify the Mac App Store update notice opens the App Store listing and never downloads or installs in-app.
- Verify the Mac App Store menu bar does not show `Check for Updates...`.
- Verify the first-run legacy import copies settings, sync tasks, and exclusion sets without copying Lemon license state.
- Verify Terms and Privacy links are reachable from Settings and About.
- Verify App Store metadata, screenshots, previews, privacy answers, support
  URL, and review notes match the submitted binary and mention non-obvious
  App Store channel behavior.
