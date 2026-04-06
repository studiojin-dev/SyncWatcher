# ADR-20260310-0012-PRG: Exclusion defaults consolidation into a program set

Status: Accepted
Date: 2026-03-10
Tags: sync-task, exclusion, migration, config-store, ux, macos, tauri
TL;DR: Replace per-ecosystem built-in exclusion defaults with one `program` built-in set, automatically migrate legacy built-in IDs in stored exclusion sets and tasks, and remove project-authored files like `.gitignore` and `.env` from built-in defaults.

## Context

- SyncWatcher currently ships many per-ecosystem built-in exclusion sets (`nodejs`, `python`, `rust`, `jvm-build`, `dotnet`, `ruby-rails`, `php-laravel`, `dart-flutter`, `swift-xcode`, `infra-terraform`).
- Users increasingly treat all of those entries as one broad "program artifacts" category rather than as separate toggleable groups.
- The separate built-in IDs make the settings UI noisier and create more migration surface for stored tasks that reference those IDs.
- The existing `git` built-in set excludes both `.git` and `.gitignore`, but `.gitignore` is a project-authored file that users may want to keep in sync.
- Older exclusion defaults also treated Python `.env` files as disposable environment artifacts, but `.env` files are commonly project-authored configuration that users may want to back up and sync.
- pnpm's official store directory spelling is `.pnpm-store`; we should keep that spelling in defaults and not introduce an underscore alias as another built-in pattern.
- ADR-20260228-0007 required keeping the older built-in set IDs for compatibility. This consolidation changes that rule, so an ADR update is required.

## Decision

1. Collapse built-in exclusion defaults to exactly three sets:
   - `system-defaults`
   - `git`
   - `program`
2. Define `program` as the ordered, deduplicated union of the current non-system, non-git built-in defaults:
   - `nodejs`
   - `python`
   - `rust`
   - `jvm-build`
   - `dotnet`
   - `ruby-rails`
   - `php-laravel`
   - `dart-flutter`
   - `swift-xcode`
   - `infra-terraform`
3. Keep `.pnpm-store` in `program` because that is the official pnpm store spelling. Do not add `.pnpm_store` as another built-in default.
4. Change the `git` built-in set to include `.git` only. Remove `.gitignore` from built-in defaults.
5. Do not include `.env` in the built-in `program` set. When normalizing stored built-in `program` patterns, strip `.env` so previously migrated defaults stop excluding it automatically.
6. Automatically migrate stored config on load:
   - Merge every legacy built-in program set into `program`.
   - Preserve user-added patterns from legacy built-in sets by appending them into `program` with deduplication.
   - Rewrite task `exclusion_sets` references from any legacy built-in program ID to `program`.
   - Keep custom exclusion-set IDs untouched.
   - Persist rewritten config only when the normalized content changed.
7. Treat `system-defaults`, `git`, and `program` as the canonical built-in order in stored exclusion-set data and UI reloads.
8. This ADR supersedes the "keep existing built-in set IDs (`system-defaults`, `nodejs`, `python`, `git`, `rust`) for compatibility" part of ADR-20260228-0007. The rest of ADR-20260228-0007 remains in force.

## Consequences

- Positive
  - The exclusion settings UI becomes simpler and better matches how users categorize generated files in practice.
  - Stored tasks keep their exclusion behavior after migration because legacy built-in IDs are rewritten to `program`.
  - `.gitignore` is no longer hidden behind a built-in exclusion and can participate in sync by default.
  - `.env` files are no longer implicitly hidden behind the built-in `program` exclusion and can participate in sync by default.
  - Built-in defaults continue to include official pnpm store paths without adding undocumented variants.
- Trade-offs
  - Users lose the ability to toggle built-in language/tooling groups independently unless they create their own custom sets.
  - Existing customized legacy built-in sets are folded into `program`, so their original per-ecosystem names no longer remain visible as separate built-in entries.
  - Config normalization on load adds a small amount of backend migration logic.

## Alternatives Considered

1. Keep all per-ecosystem built-in sets and only remove `.gitignore`
   - Rejected: does not address the UI and persistence complexity that motivated the consolidation.
2. Add `program` but keep legacy built-in sets alongside it
   - Rejected: retains duplicated concepts and keeps task/config migration ambiguous.
3. Add both `.pnpm-store` and `.pnpm_store` to built-in defaults
   - Rejected: `.pnpm_store` is not the official pnpm spelling, and a built-in alias would expand defaults without a documented basis.
4. Migrate exclusion-set definitions but leave stored task references unchanged
   - Rejected: tasks referencing retired built-in IDs would silently lose their intended exclusion coverage.
