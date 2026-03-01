# ADR-20260301-0008: watchMode zero-copy auto-unmount deferred confirmation

- Status: Accepted
- Date: 2026-03-01
- Tags: watch-mode, auto-unmount, ux, notification, safety, macos
- TL;DR: When watch sync copies zero files, replace immediate auto-unmount with notification + deferred in-app confirmation, and unmount only after explicit approval.

## Context

- In watch mode, successful runtime sync with `auto_unmount=true` previously unmounted immediately.
- When `files_copied==0`, immediate unmount is surprising and blocks quick post-sync inspection after remount.
- Users requested both system notification and in-app confirmation before unmount in this zero-copy case.
- The app may be hidden in background mode, so confirmation cannot assume visible UI.

## Decision

1. Introduce a zero-copy branch in runtime watch sync completion.
   - Condition: `auto_unmount==true && !hasPendingConflicts && files_copied==0`
   - Action: do not call `unmount_volume` immediately.
2. Emit `runtime-auto-unmount-request` event from runtime in the zero-copy branch.
   - Payload includes `taskId`, `taskName`, `source`, `filesCopied`, `bytesCopied`, `reason='zero-copy'`.
3. Always send a system notification for each zero-copy request.
   - This bypasses user notification preference for this specific safety-critical prompt.
4. Queue requests in frontend and defer modal display while main window is hidden.
   - Activate confirmation only when window visibility is restored.
5. Unmount only on explicit user confirmation.
   - Cancel/ignore keeps disk mounted indefinitely until a future explicit action.
6. Keep existing immediate auto-unmount behavior for `files_copied>0` when no pending conflicts.

## Consequences

- Prevents unintended immediate unmounts after zero-copy watch sync.
- Adds an extra interaction step in one branch, increasing UX complexity.
- Guarantees user awareness via system notification even when app is backgrounded.
- Deferred queue handling introduces additional state management in app lifecycle.
- Maintains previous hands-free behavior for non-zero-copy successful syncs.

## Alternatives Considered

1. Keep immediate unmount for zero-copy
   - Rejected: directly conflicts with inspection workflow and user request.
2. Disable auto-unmount globally in watch mode
   - Rejected: removes desirable automation for normal copy runs.
3. Use notification-only with no in-app confirmation
   - Rejected: lacks explicit consent and risks silent unmount behavior.
4. Apply confirmation to every auto-unmount (including non-zero-copy)
   - Rejected: over-corrects and adds friction for expected successful copy flows.
