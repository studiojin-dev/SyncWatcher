# ADR-20260812-0033-GAT: GitHub App installation token for homepage release-note dispatch
Status: Accepted
Date: 2026-08-12
Tags: github-actions, github-app, authentication, release, homepage, least-privilege
TL;DR: Replace the long-lived cross-repository PAT with a job-scoped GitHub App installation token limited to dispatching the studiojin-home import workflow.

## Context

- ADR-20260409-0025-RNS established a cross-repository workflow-dispatch path from SyncWatcher stable releases to `kimjj81/studiojin-home`.
- That ADR used the long-lived fine-grained PAT `BLOG_REPO_DISPATCH_TOKEN`, limited to `Actions: write` on the homepage repository.
- The dispatch is ongoing maintainer automation, not an interactive user action, so tying it to a personal token creates rotation and account-lifecycle risk.
- GitHub App installation access tokens are short-lived and can be restricted to the single target repository and the Actions permission required by the dispatch endpoint.

## Decision

1. Replace `BLOG_REPO_DISPATCH_TOKEN` with a GitHub App owned by `kimjj81` and installed only on `kimjj81/studiojin-home`.
2. Grant the App only `Actions: write` repository permission; it does not receive Contents write, webhook subscriptions, or access to additional repositories.
3. Store the App ID and private key as `STUDIOJIN_HOME_APP_ID` and `STUDIOJIN_HOME_APP_PRIVATE_KEY` Environment secrets in `github-release`.
4. In the SyncWatcher dispatch job, mint a repository-limited App installation token with `actions/create-github-app-token@v2` and use it only for the workflow-dispatch API request.
5. Allow the token action's post-job cleanup to revoke the installation token; the homepage workflow continues to write its own files with its local `GITHUB_TOKEN`.
6. Retain the existing PAT only until the App-backed dispatch completes successfully in GitHub Actions, then revoke and delete it.

## Consequences

- The cross-repository dispatch no longer depends on a maintainer's long-lived personal token or its expiry schedule.
- Compromise of the GitHub App private key remains security-sensitive, but tokens minted during release jobs expire and are repository- and permission-limited.
- The release dispatch job now depends on the `github-release` Environment and its two GitHub App secrets.
- Operators can validate the migration by manually dispatching a published stable release through the existing recovery path and confirming the homepage import workflow starts.

## Alternatives Considered

1. Reissue and retain a fine-grained PAT
   - Rejected: it preserves personal-account dependency and recurring expiration rotation for an ongoing automation path.
2. Use the source workflow's `GITHUB_TOKEN`
   - Rejected: it is limited to the source repository and does not grant access to the separately owned homepage repository.
3. Use repository dispatch
   - Rejected: ADR-20260409-0025-RNS already established that workflow dispatch provides the required narrow Actions permission without broader Contents write access.
