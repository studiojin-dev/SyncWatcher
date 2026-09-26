# ADR-20260927-0035-BAD: Use an organization-owned GitHub App for direct download-badge updates
Status: Accepted
Date: 2026-09-27
Tags: github-actions, github-app, rulesets, branch-protection, least-privilege, badges
TL;DR: Let a private GitHub App write only the generated installer download badge to main, while keeping main's deletion, force-push, and linear-history protections in force.

## Context

- `.github/workflows/update-download-badge.yml` generates `docs/badges/installer-downloads.json` and pushes a commit to `main`.
- The workflow's `GITHUB_TOKEN` already had `contents: write`, but the active `main` ruleset required changes through a pull request, so GitHub rejected the push.
- The built-in GitHub Actions integration (ID `15368`) could not be added as a bypass actor to this organization-owned ruleset; GitHub returned HTTP 422 because the integration was not part of the ruleset source or owner organization.
- The existing `main` ruleset combined pull-request enforcement with deletion, non-fast-forward, and linear-history protections. A bypass actor added to that combined ruleset could bypass all of those rules.

## Decision

1. Use a private GitHub App owned by `studiojin-dev`, installed only on `studiojin-dev/SyncWatcher`, with `Contents: read and write` and GitHub's mandatory `Metadata: read` permission. Do not enable webhooks, user authorization, or organization permissions.
2. Mint a repository-limited installation token in the badge workflow using the repository-pinned `actions/create-github-app-token@v2` action. Use the token for release API reads, checkout, and pushing the generated badge. Set the job's `GITHUB_TOKEN` permissions to none. Store the App ID in the `BADGE_APP_ID` repository variable and the private key in the `BADGE_APP_PRIVATE_KEY` repository secret.
3. Split the active `main` ruleset into structural protections and a pull-request-only ruleset. Keep deletion protection, non-fast-forward protection, and required linear history in the structural ruleset without an App bypass.
4. Put the existing organization-admin and repository-admin bypass actors in the pull-request-only ruleset to preserve their existing ability to bypass that rule. Add the new App integration as an `always` bypass actor to that pull-request-only ruleset. The App therefore bypasses the PR gate while all structural protections still apply.
5. Restrict installation-token creation to `studiojin-dev/SyncWatcher` and `Contents: write`. The workflow does not receive the private key through source code or logs.

## Consequences

- The badge workflow can update the generated JSON directly on `main` once `BADGE_APP_PRIVATE_KEY` is configured.
- The App's installation token is limited to one repository and expires after the job. The App's private key remains a persistent credential and must be stored only as an Actions secret.
- Any trusted workflow that can access `BADGE_APP_PRIVATE_KEY` can mint the same App token; protect changes to workflows and review any future workflow that is granted access to that secret.
- Human pull requests continue to require the pull-request rule. Deletion, force-push, and linear-history rules continue to apply to the App.

## Alternatives Considered

1. Add the built-in GitHub Actions integration ID `15368` directly to the existing ruleset
   - Rejected: GitHub rejected the ruleset update because the integration was not part of the ruleset source or owner organization.
2. Add the App as a bypass actor to the existing combined `main` ruleset
   - Rejected: `always` bypass at that level would also bypass deletion, non-fast-forward, and linear-history protections.
3. Open a pull request for every generated badge update
   - Rejected: the maintainer requested this generated data update to land directly on `main`.
