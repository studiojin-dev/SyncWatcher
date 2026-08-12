# ADR-20260812-0032-CPR: Route external contributions through Issues instead of pull requests
Status: Accepted
Date: 2026-08-12
Tags: governance, contributions, pull-requests, issues, maintainership
TL;DR: Do not accept unsolicited external pull requests for now; route bug reports and feature proposals through GitHub Issues while preserving Apache-2.0 fork rights.

## Context

- Reviewing and integrating external patches creates an ongoing maintenance, verification, licensing, and release-support obligation.
- SyncWatcher is currently maintained through maintainer-owned changes and is not prepared to operate a general external pull-request review queue.
- Users still need a clear path for reporting bugs, proposing features, asking questions, and privately reporting vulnerabilities.
- The contribution intake policy must not imply a restriction on rights granted under Apache-2.0.

## Decision

1. SyncWatcher does not currently accept unsolicited pull requests or patch submissions from external contributors.
2. External bug reports and focused feature proposals are directed to GitHub Issues.
3. Support questions and early ideas may use GitHub Discussions.
4. Security vulnerabilities must use the private reporting path documented in `SECURITY.md`.
5. Maintainers may still use pull requests for repository-owned work.
6. This intake policy does not restrict anyone's Apache-2.0 rights to fork, modify, or redistribute the licensed Work.

## Consequences

- Public documentation and the pull-request template must state that external pull requests are not currently accepted.
- Issue forms become the primary structured intake path for bugs and feature requests.
- External proposals can be evaluated before maintainers decide whether and how to implement them.
- Contributors cannot assume that a completed patch will be reviewed or merged upstream.
- If the project later opens general pull-request intake, this ADR and the related public documentation must be updated together.

## Alternatives Considered

1. Accept all external pull requests
   - Rejected for now because it creates a review and support queue the current maintenance model is not prepared to sustain.
2. Accept pull requests only after an issue is approved
   - Rejected because it still establishes an external patch-review commitment and makes the public intake boundary less clear.
3. Disable all public feedback
   - Rejected because reproducible bug reports and focused feature proposals remain useful even when implementation stays maintainer-owned.
