# ADR-20260228-0007: Exclusion template expansion and exclusion-pattern limit increase

- Status: Accepted
- Date: 2026-02-28
- Tags: sync-task, exclusion, templates, reliability, performance, macos, tauri
- TL;DR: Expand default exclusion templates across major ecosystems, merge missing defaults for existing users once, and raise exclusion-pattern limit from 100 to 300 with runtime deduplication.

## Context

- Dry-run and sync users increasingly include generated directories across multiple ecosystems (`.pnpm`, framework caches, build artifacts, language-specific temp outputs).
- Existing default exclusion sets were too narrow for polyglot repositories and required repetitive manual setup.
- Runtime currently enforces a hard exclusion-pattern limit of 100. With expanded templates and multi-set selection, this can cause avoidable validation failures.
- Existing users already have `exclusion_sets.yaml`; replacing it would destroy user intent. We need a non-destructive path.
- An ADR is required for this decision.

## Decision

1. Expand built-in exclusion templates
   - Keep existing set IDs (`system-defaults`, `nodejs`, `python`, `git`, `rust`) for compatibility.
   - Add new built-in sets for JVM, .NET, Ruby/Rails, PHP/Laravel, Dart/Flutter, Swift/Xcode, Terraform.
   - Include broader cache/build/generated-directory patterns (including `.pnpm`) to reduce manual configuration.
2. Non-destructive one-time default merge for existing users
   - Introduce local migration key: `exclusion_sets_defaults_version`.
   - Introduce defaults version constant: `2`.
   - On startup, if version is not applied, append only missing default sets by `id`.
   - Never overwrite existing set names/patterns.
   - Persist migration version after successful merge (or immediately if no merge is needed).
3. Raise exclusion-pattern limit
   - Increase hard limit from 100 to 300 in both input validation and sync engine runtime checks.
   - Keep max pattern length at 255 unchanged.
4. Deduplicate runtime exclusion patterns
   - During runtime resolution, deduplicate patterns while preserving first-seen order.
   - Reduce accidental duplication cost and lower risk of hitting hard limits.

## Consequences

- Positive
  - Better out-of-box behavior for mixed-language repositories and framework-heavy projects.
  - Fewer manual exclusion edits for common cache/build folders.
  - Lower failure rate when multiple exclusion sets are selected together.
  - Existing users keep their customizations while still receiving new default sets.
- Trade-offs
  - Higher maximum pattern count increases matcher setup work and memory usage.
  - Broader defaults can hide files users may occasionally want to sync; users must deselect sets where needed.
  - Versioned migration adds minor startup complexity.

## Alternatives Considered

1. Keep 100 limit and fail when exceeded
   - Rejected: predictable but too restrictive once defaults expand aggressively.
2. Keep 100 limit and auto-truncate overflow patterns
   - Rejected: silent behavior changes are harder to reason about and can hide user intent.
3. Overwrite existing users with new defaults
   - Rejected: destructive; violates user customization expectations.
4. Expand only Node/Python sets
   - Rejected: insufficient for multi-language repositories and modern full-stack projects.
