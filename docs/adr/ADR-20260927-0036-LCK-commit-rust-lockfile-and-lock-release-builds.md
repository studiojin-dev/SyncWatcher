# ADR-20260927-0036-LCK: Commit Rust lockfile and lock release builds
Status: Accepted
Date: 2026-09-27
Tags: release, rust, dependencies, supply-chain, reproducibility, app-store
TL;DR: Commit the Rust dependency resolution and make GitHub and local distribution builds fail if the lockfile would change.

## Context

- SyncWatcher distributes an application, but src-tauri/Cargo.lock was ignored while pnpm-lock.yaml was committed.
- Each macOS release build could independently resolve newer compatible Rust dependencies without a source change. This weakens repeatability across the ARM and Intel artifacts and between local and GitHub builds.
- ADR-20260812-0031-OSS requires reproducible dependency notice inputs from lockfiles. ADR-20260305-0009-RLS generates release SBOMs from repository source and lockfile scope.
- Regenerating a lockfile from scratch during this change would update many unrelated Rust packages and Tauri plugins. The existing locally resolved lockfile matches the current manifest and keeps the change focused on the release policy.

## Decision

1. Commit src-tauri/Cargo.lock and remove it from .gitignore. Cargo.toml and Cargo.lock changes belong in the same reviewed change when Rust dependencies are intentionally updated.
2. The GitHub release workflow MUST pass --locked through the Tauri CLI to Cargo for both macOS architectures.
3. The local GitHub DMG and Mac App Store build scripts MUST also pass --locked through the Tauri CLI. A missing or stale lockfile fails the build rather than silently changing the dependency graph.
4. Cargo remains responsible for generating the lockfile. Contributors MUST NOT edit resolved package entries manually.
5. Any future Rust dependency update must regenerate the Rust license report and verify the relevant build and behavior before release.

## Consequences

- Both release architectures and both distribution channels use the dependency versions reviewed in the source commit.
- A manifest change without a corresponding lockfile update fails at build time and requires a follow-up source change.
- Dependency patches no longer enter a release merely because a new compatible crate was published. Updates need deliberate review, including security advisories.
- The tracked lockfile is a new input to the existing source-scoped SBOM and Rust dependency notice process.

## Alternatives Considered

1. Continue ignoring Cargo.lock and resolve compatible versions at build time
   - Rejected: builds from one tag can use different dependency graphs, and source-level dependency evidence is incomplete.
2. Commit Cargo.lock without enforcing --locked in distribution builds
   - Rejected: a stale manifest could still rewrite the lockfile during a release.
3. Regenerate and upgrade every compatible Rust package now
   - Rejected: that would combine the lockfile policy with a large runtime dependency change and require a separate compatibility review.
