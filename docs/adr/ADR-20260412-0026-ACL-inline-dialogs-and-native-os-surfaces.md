# ADR-20260412-0026-ACL: Inline dialogs and native OS surfaces
Status: Accepted
Date: 2026-04-12
Tags: tauri, acl, ux, dialogs, native-integration, macos
TL;DR: Keep OS-integrated selection and handoff surfaces native, but move confirmation and informational dialogs into renderer-owned inline UI to reduce ACL fragility and secondary-window permission issues.

## Context

- SyncWatcher uses Tauri v2 capability / permission ACL for frontend-exposed plugin commands.
- Native dialog APIs such as `@tauri-apps/plugin-dialog` `ask()` and `message()` are convenient, but they add ACL-sensitive UI behavior to whichever window invokes them.
- SyncWatcher already uses multiple renderer-owned modal surfaces for first run, auto-unmount confirmation, cancel confirmation, and conflict review.
- The `conflict-review` secondary window exposed that renderer-owned inline dialogs are more robust than native confirmation dialogs when window/capability assumptions drift.
- File and directory selection, OS preview handoff, updater install, and process relaunch are not just “dialogs”; they are OS-integrated behaviors.

## Decision

1. Treat renderer-owned confirmation / informational dialogs as the default for app UI.
   - This includes flows previously implemented with `plugin-dialog` `ask()` or `message()`.
2. Keep OS-integrated selection and handoff surfaces native.
   - Keep `plugin-dialog open()` for file / directory selection.
   - Keep `plugin-opener openPath()` for OS default-app / preview handoff.
   - Keep updater / restart flows on native plugin paths.
3. For new secondary windows:
   - Do not use native `ask()` / `message()` by default.
   - Prefer inline renderer-owned dialog UI inside that window.
4. Capability review remains required for new window labels and new native plugin usage.

## Consequences

- Confirmation and notice flows become more testable in DOM-based frontend tests.
- The renderer owns dialog styling and behavior, which improves consistency across screens.
- App-shell lifecycle flows become slightly more complex because multi-choice and timeout behavior now live in frontend state instead of native dialog helpers.
- Native file / directory pickers and OS handoff flows remain outside this policy because inline replacement would require materially different product features.

## Alternatives Considered

1. Keep all native dialogs
   - Rejected: increases ACL fragility and secondary-window risk for simple confirmation UI.
2. Replace all native surfaces, including pickers and OS handoff, with inline UI
   - Rejected: file browsers, bookmark capture, updater, and relaunch are not equivalent replacements.
3. Change only the conflict-review window and leave the rest ad hoc
   - Rejected: does not establish a clear rule for future screens and windows.
