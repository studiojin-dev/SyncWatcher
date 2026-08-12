# ADR-20260812-0034-RSH: Tag-bound and run-scoped GitHub release hardening
Status: Accepted
Date: 2026-08-12
Tags: release, github-actions, security, provenance, supply-chain, concurrency
TL;DR: Bind manual release recovery to the exact tag ref, serialize runs per tag, pass only current-run build artifacts to metadata and attestation jobs, and pin third-party actions to reviewed commit SHAs.

## Context

- ADR-20260404-0022-REL allows an operator to recover an already-published tag through `workflow_dispatch` when `reuse_published_release=true`.
- A workflow dispatch can be started from a branch while separately supplying a tag-shaped input. In that case GitHub's OIDC identity and `GITHUB_SHA` describe the branch, even if a checkout later selects the requested tag.
- Recovery runs reuse a Release that can already contain assets from an older run. Enumerating every Release asset before generating checksums or attestations can therefore give current-run provenance to a file that the current run did not build.
- Two runs targeting the same tag can otherwise mutate the same draft, assets, updater metadata, and release state concurrently.
- Release actions receive signing credentials or modify published assets, so mutable action tags leave a supply-chain substitution risk.

## Decision

1. A manual release run MUST be dispatched with `github.ref_type == tag` and `github.ref_name == inputs.tag_name`. The tag gate fails before any Release mutation if either condition is false.
2. Every source checkout in a release build MUST explicitly select that validated tag.
3. Release workflow runs MUST use a per-tag concurrency group with `cancel-in-progress=false` so an in-flight release is not cancelled midway through publication.
4. Each architecture build MUST stage the DMG, updater bundle, and updater signature under the same sanitized names used for GitHub Release assets and upload them as short-retention workflow artifacts.
5. Updater metadata, checksums, and attestations MUST consume only those workflow artifacts from the current run. Existing GitHub Release assets are not a provenance input.
6. The current-run manifest MUST contain exactly one DMG and one updater bundle for each supported architecture before checksums or attestations are generated.
7. Third-party actions in the release and cross-repository dispatch workflows MUST be pinned to reviewed full commit SHAs. Human-readable major-version comments document the intended update line.

## Consequences

- Manual recovery must select the exact tag in the dispatch ref as well as provide the matching `tag_name`; selecting `main` now fails safely.
- GitHub OIDC identity, source checkout, release tag, and attestation subject are aligned to one immutable ref.
- A stale or unrelated asset already attached to the Release cannot receive a new checksum or attestation from a later recovery run.
- Same-tag runs wait for one another rather than racing or cancelling a partially completed release.
- Workflow artifacts temporarily duplicate the current build outputs for at most seven days, adding storage and transfer time.
- Action upgrades require an explicit commit-SHA review instead of automatically following a mutable major tag.

## Alternatives Considered

1. Checkout the requested tag while allowing dispatch from any ref
   - Rejected: checkout does not change the GitHub Actions OIDC workflow identity or event `GITHUB_SHA`.
2. Continue downloading every asset from the GitHub Release
   - Rejected: a recovery Release is persistent state and cannot prove which run produced each pre-existing file.
3. Cancel older same-tag runs when a new run starts
   - Rejected: cancellation can leave a draft or published Release partially mutated.
4. Keep major-version action tags and rely on repository ownership
   - Rejected: signing and release workflows require immutable third-party code references.
