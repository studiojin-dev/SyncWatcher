# ADR-20261022-0038-UPC: Beta update channel with pre-release manifest resolution

Tags: updater, release, beta, github-releases, settings, distribution, macos, tauri
Status: Accepted
Date: 2026-10-22
TL;DR: Add a user-selectable `stable | beta` update channel for the GitHub DMG build. Beta resolves the highest-semver GitHub release (stable or pre-release) that carries `latest.json` and points the Tauri updater at that tag's manifest; stable keeps the fixed `releases/latest` endpoint. The Mac App Store build is unaffected and never exposes the option.

## Context

- The GitHub DMG channel self-updates through `tauri-plugin-updater` with one fixed endpoint, `https://github.com/studiojin-dev/SyncWatcher/releases/latest/download/latest.json`. GitHub resolves `releases/latest` to the newest *non-pre-release* release, so users can never be offered a `vX.Y.Z-beta.N` build even though `.github/workflows/release.yml` already builds, signs, notarizes, and publishes such tags as GitHub pre-releases with their own `latest.json`.
- The maintainer wants to ship early builds to opt-in testers without touching the Mac App Store channel. ADR-20260401-0021-MAS forbids any non-App-Store updater surface in the App Store build, so the feature must be invisible there.
- The JavaScript `check()` API of `@tauri-apps/plugin-updater` cannot override endpoints; only the Rust `UpdaterBuilder::endpoints()` can. The plugin's `download`/`install` commands look the `Update` up in the *webview* resource table by id.
- GitHub has no "latest pre-release" download URL and the release workflow treats tags as immutable (ADR-20260812-0034-RSH), so a rolling `beta` tag or a mutable pointer release is not an option.
- AGENTS.md forbids new dependencies unless requested. `semver` is already compiled into the app as a transitive dependency of `tauri` and `tauri-plugin-updater`, and the updater itself compares versions with it.

An ADR is required for this decision.

## Decision

1. **Setting.** `StoredSettings.updateChannel: stable | beta` (default `stable`) is persisted in `settings.yaml`, exposed through `SettingsSnapshot`/`SettingsPatch`, and editable in Settings → System. The MCP settings patch does not expose it. The row renders only when the distribution policy reports `supportsSelfUpdate`, so the App Store build never shows it.
2. **One app command, not the plugin's JS `check()`.** The frontend calls `check_for_app_update(channel)`. The command refuses when `channel_policy(...).can_self_update` is false (the updater plugin is not even registered there), builds the updater with the configured endpoint for `stable`, or with an overridden endpoint for `beta`, registers the resulting `Update` in the webview resource table, and returns the plugin-compatible metadata (`rid`, `currentVersion`, `version`, `date`, `body`, `rawJson`) plus the effective `channel` and `endpoint`. The frontend reconstructs `new Update(metadata)` so download, install, and relaunch reuse the plugin unchanged.
3. **Beta manifest resolution.** The command reads `GET /repos/studiojin-dev/SyncWatcher/releases?per_page=30` with a `SyncWatcher/<version>` user agent, drops drafts and releases without a `latest.json` asset, parses the remaining tags as semver (`v` prefix optional), and selects the **highest version across stable and pre-release**. The endpoint becomes `releases/download/<tag>/latest.json`. Consequences of "highest semver, not newest pre-release":
   - `2.2.0-beta.1` is offered over `2.1.0`;
   - once `2.2.0` ships it outranks every `2.2.0-beta.N`/`2.2.0-rcN`, so beta users are moved back onto stable automatically;
   - `-rc` pre-releases count as beta-channel candidates, because the release workflow already classifies both as pre-releases.
4. **Fallback.** If the GitHub API call fails or no eligible release exists, the command logs the reason and checks the stable endpoint instead of failing, so a rate-limited or offline beta tester still receives stable updates. The returned metadata reports `channel: stable` in that case.
5. **No downgrade on channel switch.** Switching from `beta` back to `stable` only changes which manifest is consulted. The updater never downgrades, so an installed beta stays until a stable version with a higher semver is published. The settings description states this.
6. **Release process.** No workflow change is needed: pushing `vX.Y.Z-beta.N` (or `-rcN`) already produces a signed, notarized pre-release with DMGs, updater bundles, `latest.json`, checksums, and SBOMs. Beta versions are set in `tauri.conf.json` and `Cargo.toml` (and therefore `Cargo.lock`) exactly like stable ones. The download badge and the studiojin-home release-notes sync continue to ignore pre-releases.
7. **Pre-release versions never reach the Mac App Store.** `tauri.appstore.conf.json` inherits `version` from `tauri.conf.json`, and App Store Connect rejects a `CFBundleShortVersionString` with a pre-release suffix. `scripts/release/local-mac-app-store-build.sh` therefore refuses to build unless the version is a plain `X.Y.Z`; the stable bump that follows a beta cycle restores App Store eligibility.
8. **`semver` becomes a direct dependency.** It adds no new crate to `Cargo.lock`; it only makes the already-present crate available to the app so the channel resolver orders versions exactly like the updater does.

## Consequences

- Opt-in testers get beta builds through the same signed updater flow as stable users; stable users see no behavioural change because the stable path still uses the fixed `releases/latest` endpoint.
- The beta check adds one unauthenticated GitHub API request (60/hour/IP limit) per check; auto-checks run once per launch, so the limit is not a practical concern. Failures degrade to the stable check.
- The App Store build keeps its App Store-only update policy: no setting, no command path, no updater plugin. While the tree carries a beta version, the local App Store packaging script fails fast instead of producing an invalid package.
- The frontend caches the channel the backend actually used; a beta request that fell back to stable is retried on the next manual check, and switching channels discards the cached update.
- `latest.json` for a pre-release is reachable at a tag-bound, immutable URL, consistent with ADR-20260812-0034-RSH; nothing mutates published releases.
- Tag naming now matters for channel membership: only semver-parsable `vX.Y.Z[-pre]` tags with a `latest.json` asset are candidates.

## Alternatives Considered

1. Keep JS `check()` and add a second configured endpoint for beta
   - Rejected: the updater uses the first endpoint that answers, not the highest version, and there is no fixed URL for "latest pre-release".
2. Maintain a rolling `beta` tag or a mutable "beta pointer" release that CI overwrites
   - Rejected: conflicts with immutable, tag-bound releases and attestation (ADR-0034) and adds a mutable asset with signing implications.
3. Pick the most recently created pre-release instead of the highest semver
   - Rejected: once stable `2.2.0` ships after `2.2.0-beta.2`, beta users would be stuck on the beta until the next pre-release.
4. Resolve the beta endpoint in the webview with `fetch` and compare versions in TypeScript
   - Rejected: the endpoint still has to reach the Rust `UpdaterBuilder`, and duplicating version ordering in two languages invites drift from the updater's own comparator.
5. Fail the check when beta resolution fails
   - Rejected: an offline or rate-limited tester would lose stable updates too; logging plus a stable fallback is safer.
