# ACL Inline Migration Audit (2026-04-12)

Status: Audit only
Date: 2026-04-12
Scope: frontend production code under `src/`, Tauri capability/config under `src-tauri/`

## Summary

- This audit reviews frontend calls that are gated by Tauri v2 capability / permission ACL and checks whether they are realistic candidates for inline UI replacement.
- The practical replacement target is narrow: `@tauri-apps/plugin-dialog` confirmation / alert style APIs (`ask()`, `message()`).
- Native OS integration APIs should remain native:
  - `plugin-dialog open()`
  - `plugin-opener openPath()`
  - `plugin-updater`
  - `plugin-process`
- Infrastructure APIs are not inline-replacement targets:
  - `@tauri-apps/api/event`
  - `@tauri-apps/api/webviewWindow`
  - `@tauri-apps/api/app`
  - `invoke()`

## Current Capability Coverage

- Capability file: `src-tauri/capabilities/default.json`
- Window labels covered:
  - `main`
  - `conflict-review`
- Permissions explicitly enabled there:
  - `core:default`
  - `core:window:allow-close`
  - `opener:default`
  - `opener:allow-open-path` with `$HOME/**`, `/Volumes/**`
  - `fs:default`
  - `dialog:default`
  - `window-state:default`
  - `updater:default`
  - `process:default`

## Dynamic / Secondary Window Audit

- Static main window label:
  - `src-tauri/tauri.conf.json` -> `main`
- Dynamic window creation:
  - `src-tauri/src/lib.rs` -> `WebviewWindowBuilder::new(&app, "conflict-review", ...)`
- Frontend split by window label:
  - `src/App.tsx` routes `windowLabel === 'conflict-review'` to the dedicated conflict review UI

Current result:

- The only secondary window in production is `conflict-review`.
- It is included in the only capability file.
- This means future risk is not “many hidden windows”, but:
  - adding a new window label
  - forgetting to add it to a capability file
  - using a new ACL-sensitive plugin API there

## ACL-Sensitive Usage Inventory

### 1. Inline replacement candidates now

These are confirmation / notice flows that can be migrated to renderer-owned modal UI without changing the underlying business contract.

#### `src/App.tsx`

- Legacy import confirmation: `ask()`
- Legacy import result notice: `message()`
- Quit confirmation when watch/sync/runtime state requires it: `ask()`
- Cmd+Q background/full quit/cancel choice: `message()` with 3 buttons
- Timeout-backed quit prompt path: `ask()` inside `askWithTimeout()`

Assessment:

- Inline migration is possible.
- This is the highest-value target because it centralizes app-shell lifecycle and quit policy.
- The 3-choice and timeout behavior mean this is not a simple drop-in modal replacement. It needs an app-level modal state machine.

#### `src/views/sync-tasks/useSyncTaskActions.ts`

- Open conflict review now after sync: `ask()`
- Disable watch mode confirmation: `ask()`
- Delete task confirmation: `ask()`

Assessment:

- Inline migration is straightforward.
- These are standard 2-choice confirm flows already living inside renderer stateful code.

#### `src/views/RecurringSchedulesView.tsx`

- Clear history confirmation: `ask()`
- Delete all schedules confirmation: `ask()`
- Delete single schedule confirmation: `ask()`

Assessment:

- Inline migration is straightforward.
- These are local 2-choice confirms in a single screen.

#### `src/components/features/OrphanFilesModal.tsx`

- Delete orphan files confirmation: `ask()`

Assessment:

- Inline migration is straightforward.
- This is already a dedicated modal-like workflow, so an embedded confirm state is natural.

### 2. Already migrated / no longer using `ask()`

#### `src/components/features/ConflictReviewWindow.tsx`

- No longer uses `plugin-dialog ask()`
- Remaining ACL-sensitive calls there:
  - `getCurrentWebviewWindow().close()`
  - `openPath(sourcePath / targetPath)`

Assessment:

- The confirmation part is already inline-owned.
- `openPath()` should remain native because it is explicitly the OS preview / default-app fallback.

### 3. Native keepers, not realistic inline replacements

#### Folder / directory pickers (`plugin-dialog open()`)

- `src/views/sync-tasks/useSyncTaskFormController.ts`
- `src/components/ui/FolderInput.tsx`
- `src/views/SettingsView.tsx`

Assessment:

- These are native folder selection flows.
- Replacing them inline would require a custom file browser, path validation, and integration with bookmark / path access capture.
- This is a different product feature, not a dialog-skin replacement.

Recommendation:

- Keep native.

#### OS opener (`plugin-opener openPath()`)

- `src/components/features/ConflictReviewWindow.tsx`

Assessment:

- Purpose is to hand off to the OS default app / preview.
- Inline replacement would not be functionally equivalent.

Recommendation:

- Keep native.

#### Updater / restart

- `src/components/features/UpdateChecker.tsx`
  - `check()`
  - `downloadAndInstall()`
  - `relaunch()`

Assessment:

- These are native updater / process restart responsibilities.
- Inline UI can wrap state and progress, but cannot replace the native capability need.

Recommendation:

- Keep native.

### 4. Infrastructure APIs, not migration targets

- `listen()` across app/runtime/hooks/views
- `getCurrentWebviewWindow()` in app shell and conflict review window
- `getVersion()` in `src/hooks/useAppVersion.ts`
- `invoke()` across app state and backend command bridges

Assessment:

- These are ACL-relevant app bridge calls, but not “dialog UI” problems.
- They should be audited for capability coverage, not converted inline.

## Recommended Policy

- If the goal is to reduce ACL breakage caused by confirmation dialogs, focus only on:
  - `plugin-dialog ask()`
  - `plugin-dialog message()`
- Do not expand scope to native pickers, OS opener, updater, or restart flows.
- Prefer this rule for new UI work:
  - confirmation / informational dialogs => inline renderer-owned UI first
  - OS selection / OS handoff / update / restart => native plugin path
- For any new secondary window:
  - require explicit capability label coverage
  - avoid `plugin-dialog ask()/message()` unless there is a strong reason to keep native dialogs there

## Recommended Implementation Order

1. `src/App.tsx`
   - app-shell close / quit / background choice dialogs
2. `src/views/sync-tasks/useSyncTaskActions.ts`
   - 2-choice confirm flows
3. `src/views/RecurringSchedulesView.tsx`
   - local confirm flows
4. `src/components/features/OrphanFilesModal.tsx`
   - orphan delete confirmation
5. Guardrail for future work
   - when adding a new secondary window, treat native `ask()/message()` as disallowed by default

## Verification Checklist Used In This Audit

- Enumerated production uses of:
  - `ask()`
  - `message()`
  - `open()`
  - `openPath()`
  - `check()`
  - `relaunch()`
  - `getVersion()`
  - `listen()`
  - `getCurrentWebviewWindow()`
- Verified dynamic / secondary window labels in Rust and frontend entrypoints
- Verified current capability file coverage for `main` and `conflict-review`

## ADR Note

- This audit itself does not adopt a repository-wide architectural rule.
- If the team chooses to adopt the policy:
  - “confirmation / informational dialogs are inline-first, native dialogs are reserved for OS-integrated flows”
  - An ADR is required for this decision.
