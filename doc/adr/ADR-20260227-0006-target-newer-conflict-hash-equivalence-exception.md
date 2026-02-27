# ADR-20260227-0006: Target-newer conflict hash-equivalence exception

- Status: Accepted
- Date: 2026-02-27
- Tags: sync-task, safety, conflict-review, checksum, macos, tauri
- TL;DR: When target mtime is newer, classify as conflict only if content differs; if source and target are hash-identical, treat as no-op.

## Context

- ADR-20260219-0005 defined `target.modified > source.modified` as unconditional conflict.
- In real copy workflows, target files can be recreated from source later, resulting in newer mtime but identical content.
- The previous rule generated false-positive conflict sessions and unnecessary user actions.
- Conflict Review close flow and media preview rely on accurate conflict candidate quality; false positives degrade usability.

## Decision

1. Refine target-newer conflict rule:
   - Keep `target.modified > source.modified` as an initial candidate condition.
   - If file size differs, keep it as conflict.
   - If file size matches, compute xxHash64 for source and target regardless of `checksum_mode`.
   - If hashes are equal, do not create conflict item (treat as unchanged).
   - If hashes differ, keep it as conflict item.
2. Scope the always-hash behavior to target-newer candidates only, to avoid broad scan cost increase.
3. Keep failure behavior unchanged:
   - Hash/read failures remain fail-fast errors (no silent fallback).
4. This ADR supersedes the unconditional interpretation in ADR-20260219-0005 section "Decision #1" while preserving the rest of ADR-0005 lifecycle/UX decisions.

## Consequences

- Reduces false-positive conflict sessions for files that are timestamp-different but content-identical.
- Keeps data-protection semantics: truly different target-newer files still require explicit review.
- Adds checksum work for target-newer same-size candidates even when `checksum_mode` is off.
- Keeps command/API contracts unchanged (`open_conflict_review_window`, `resolve_conflict_items`, `close_conflict_review_session`, `get_conflict_item_preview`).

## Alternatives Considered

1. Keep strict mtime-only rule
   - Rejected: causes recurring false conflicts after manual or external copy workflows.
2. Make hash exception depend on `checksum_mode`
   - Rejected: conflict correctness should not depend on optional diff sensitivity toggles.
3. Fully hash-based comparison for all files
   - Rejected: higher global scan cost than needed for this issue.
