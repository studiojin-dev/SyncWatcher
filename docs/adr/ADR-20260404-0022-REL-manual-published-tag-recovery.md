# ADR-20260404-0022-REL: Manual published-tag release recovery with explicit operator opt-in
Status: Accepted
Date: 2026-04-04
Tags: release, ci, github-actions, tauri, updater, macos
TL;DR: Keep tag-push releases immutable by default, allow an explicit `workflow_dispatch` recovery path that reuses an already-published release only when the operator opts in, and require GitHub-generated release notes for every release creation or recovery run.

## Context

- `ADR-20260325-0017-REL` made published-tag retries fail fast to preserve release immutability after the `v1.3.1` race condition.
- `v1.4.3` then failed in `prepare_release` because the workflow detected a published release for the same tag and exited before any recovery work could run.
- The direct-download GitHub release remains the authoritative distribution origin for updater metadata and shipped artifacts.
- Some failures are operational rather than semantic versioning mistakes:
  - transient CI failures after publication
  - partial or missing assets that need deterministic replacement
  - metadata regeneration for a tag that should not force a new public version number
- Fully automatic reuse of published releases would make ordinary tag pushes mutable again and would weaken the protection introduced by `ADR-20260325-0017-REL`.

## Decision

1. Keep tag-push release runs immutable:
   - `push` runs for an already-published tag still fail fast with operator guidance.
2. Add a manual recovery path through `workflow_dispatch`:
   - the operator provides the release tag
   - the operator must explicitly set `reuse_published_release=true`
3. When that manual opt-in is present for an already-published tag:
   - reuse the existing release instead of failing
   - upload rebuilt assets to the same release
   - rebuild `latest.json`, checksums, SBOMs, and attestation bundles deterministically
4. Propagate release state through the workflow so upload steps match the actual draft/published state of the target release.
5. Skip the final publish step when the recovery run is operating on an already-published release, because there is no draft transition left to perform.
6. Require release note generation for every GitHub release workflow path:
   - new releases must be created with GitHub-generated release notes
   - recovery runs must regenerate and reapply release notes before the final publish/finish stage
   - operator-written preface text may be prepended, but the workflow must not leave a release without generated notes

## Consequences

- Ordinary tag pushes remain safe and immutable once a release is published.
- Maintainers get a documented, explicit recovery path for same-tag rebuilds without cutting an artificial patch version for operational failures.
- Published release recovery remains a conscious operator action rather than an accidental rerun side effect.
- The workflow becomes slightly more complex because release state must be carried through the job graph.
- Release notes remain consistent across fresh releases and same-tag recovery runs instead of drifting to stale or placeholder text.

## Alternatives Considered

1. Keep failing every published-tag retry
   - Rejected: operational recovery for the exact tag becomes unnecessarily expensive and forces version churn.
2. Allow all reruns to mutate published releases automatically
   - Rejected: weakens release immutability and makes accidental same-tag mutation too easy.
3. Allow any manual dispatch to reuse published releases without extra confirmation
   - Rejected: still too easy to mutate a published release by mistake.
