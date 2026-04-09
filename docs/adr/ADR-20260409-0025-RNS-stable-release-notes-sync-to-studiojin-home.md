# ADR-20260409-0025-RNS: Stable release notes sync to the studiojin-home SyncWatcher page

Tags: release, homepage, github-actions, workflow-dispatch, docs
Status: Accepted
Date: 2026-04-09
TL;DR: After a stable GitHub Release is published, trigger a workflow in `kimjj81/studiojin-home` to import that release's notes into the `/syncwatcher/` product page, using a fine-grained PAT with only `Actions: write`.

## Context

- SyncWatcher already publishes stable and prerelease builds through GitHub Releases, and stable releases are the direct-download channel users see first.
- `studiojin-home` is a separate repository that hosts the public product page at `https://studiojin.dev/syncwatcher/`.
- The homepage needs release notes on the product page itself, not as separate blog posts, and the notes should accumulate as a collapsible history.
- The homepage repository is private, so cross-repository automation requires explicit authentication and a minimal-permission trigger path.

## Decision

1. Keep release-note generation in the existing SyncWatcher release pipeline as the canonical source of truth.
2. Add a separate post-publish workflow in SyncWatcher that runs on `release.published` and on manual `workflow_dispatch` replay.
3. Sync only published stable releases:
   - automatic runs skip prereleases
   - manual replay validates that the requested tag is published, non-draft, and non-prerelease before dispatching
4. Trigger `kimjj81/studiojin-home` with GitHub's workflow dispatch API, not repository dispatch.
5. Authenticate that cross-repo trigger with a fine-grained PAT stored in SyncWatcher as `BLOG_REPO_DISPATCH_TOKEN`, scoped only to `kimjj81/studiojin-home` with `Actions: write`.
6. Let the homepage repository own content generation, build validation, and commit/push using its local `GITHUB_TOKEN`.
7. Store imported release notes in a dedicated Astro content collection and render them as a collapsible history on `/syncwatcher/`, newest first with the latest entry open by default.

## Consequences

- The product page updates only after a stable release is actually published, so draft or failed release attempts cannot leak into the homepage.
- Workflow dispatch keeps the cross-repo token narrower than repository dispatch, which would require `Contents: write`.
- The homepage repository remains the only writer of its tracked files, so content generation and deployment stay local to that repo.
- Manual replay exists for recovery after dispatch failures or published-release recovery runs without mutating already-published SyncWatcher assets.

## Alternatives Considered

1. Repository dispatch from SyncWatcher to the homepage repo
   - Rejected: requires broader token access (`Contents: write`) than workflow dispatch.
2. Build-time fetch from the homepage page directly against the GitHub Releases API
   - Rejected: couples site builds to a remote API call and removes versioned content history from the repo.
3. Separate blog posts for each release
   - Rejected: the requirement is to keep release notes on the product page as supporting product information, not as standalone articles.
