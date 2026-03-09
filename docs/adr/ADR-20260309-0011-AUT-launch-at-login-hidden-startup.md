# ADR-20260309-0011-AUT: Launch-at-login autostart with hidden startup
- Status: Accepted
- Date: 2026-03-09
- Tags: lifecycle, autostart, macos, tauri, settings, ux
- TL;DR: Use Tauri's autostart plugin on macOS, keep login-item state as the OS-owned source of truth, and start hidden only when both the autostart argument and OS login-item state confirm a real login launch.

## Context

- SyncWatcher already supports resident background behavior through tray restore and `closeAction=background`.
- Users want an explicit `로그인 시 자동 실행` setting and first-run explanation for that behavior.
- The app is macOS only, so the login-item implementation should use a native macOS mechanism instead of cross-platform custom scripts.
- Login-triggered startup should behave like a background utility, not a foreground document app that steals focus at sign-in.
- Existing users have already seen a one-time background intro banner, so the new first-run experience must not re-prompt them after upgrade.
- A same-user local process can pass `--autostart` manually, so argv alone is not a strong enough trust signal for hidden startup.

## Decision

1. Use `tauri-plugin-autostart` with `MacosLauncher::LaunchAgent`.
   - Keep the integration in Rust only.
   - Do not expose autostart plugin commands directly to the frontend capability layer.
2. Treat launch-at-login as OS-owned state.
   - Add `launchAtLogin` to `SettingsSnapshot` and frontend `Settings`.
   - Do not persist `launchAtLogin` in `settings.yaml`.
   - Settings reads always reflect the current OS login-item state.
3. Add a dedicated backend command `set_launch_at_login(enabled)`.
   - Keep autostart writes out of generic `update_settings`.
   - Keep MCP settings scope unchanged; MCP does not control login-item registration.
4. Start hidden on login-item launches.
   - Register autostart with `--autostart`.
   - Set the main window config `visible=false` to avoid startup flash.
   - Keep the app hidden and set macOS activation policy to `Accessory` only when `--autostart` is present and the OS reports login-item autostart is enabled.
   - If the login-item state is disabled or cannot be read, fall back to normal visible startup.
   - Emit startup provenance logs for argv presence, login-item enabled state, and hidden-start accept/reject reason.
   - On normal launches, explicitly restore/show the main window.
5. Replace the old first-run background banner with a unified first-run modal.
   - The modal explains both background behavior and launch-at-login.
   - The primary action enables launch-at-login immediately.
   - Existing installs suppress the new modal if the legacy `syncwatcher_bg_intro_shown` flag is already present.

## Consequences

- SyncWatcher gains a native macOS login-item implementation with minimal custom platform code.
- The app no longer relies on YAML persistence for an OS-level preference, reducing drift when users change login items outside the app.
- Hidden startup keeps login autostart aligned with tray/background utility expectations, while narrowing the trust condition for hidden mode and preserving visible fallback on ambiguous launches.
- First-run onboarding becomes modal-based and more prominent, while avoiding duplicate education surfaces.
- Because MCP cannot change login-item state, remote automation keeps a narrower trust boundary.

## Alternatives Considered

1. Manage LaunchAgent/plist files manually
   - Rejected: duplicates platform integration logic already maintained by the official Tauri plugin.
2. Persist `launchAtLogin` in `settings.yaml`
   - Rejected: can drift from the actual OS login-item state and adds extra reconciliation logic.
3. Start visible on login
   - Rejected: utility-app behavior at login should not steal focus or place a window in front of the user's session immediately.
4. Trust `--autostart` alone for hidden startup
   - Rejected: same-user local code can supply the flag without proving a real login-item launch.
5. Keep the old banner and add a second first-run surface
   - Rejected: duplicates onboarding and creates a noisier first-run experience.
