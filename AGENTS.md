# AGENTS.md - SyncWatcher

This document defines agent workflow rules (HOW) only.
Requirements (WHAT) live in `doc/`, and architecture decisions (WHY) live in `doc/adr/`.

## 1) Scope and Principles

- Target platform is macOS only (Apple Silicon, Intel)
- Prefer correctness and clarity over cleverness
- Do not add dependencies or external services unless explicitly requested
- Avoid large refactors unless explicitly requested
- Preserve existing public behavior by default

## 2) Workflow (Non-trivial Tasks)

1. Restate the goal in one sentence
2. Propose a short execution plan
3. Use TDD when practical: failing repro/test -> minimal fix -> cleanup
4. Summarize what changed and why

## 3) Required Checks

### Documentation Check (MUST)

Consult authoritative docs for:

- API signatures/options
- Version-sensitive or latest behavior
- Deployment/auth/security concerns
- Production reliability/performance

If docs are unavailable, do not make hard assumptions. State uncertainty or ask first.

### ADR Compliance (MUST)

- Record architecture/design decisions with trade-offs as ADRs
- Do not ship changes that conflict with existing ADRs before updating ADRs
- If new constraints or non-obvious choices appear, confirm ADR need first

### Verification (MUST)

Do not claim correctness without verification steps:

- Run tests
- Build/type-check
- Perform realistic manual checks

## 4) Stop and Ask

- Requirements are unclear
- The change may be breaking
- The behavior depends on docs/ADRs not yet verified

## 5) Implementation Rules

- TypeScript: never use `as any` or `@ts-ignore`
- Error handling: prefer `Result` in Rust, handle async errors explicitly in TS
- Tauri commands: keep Rust/TS command names aligned; use `invoke("cmd", { ... })`

## 6) Common Commands

```bash
# dev / build
npm run dev
npm run build
npm run preview

# lint / test
npm run lint
npm run lint:check
npm run test
npm run test:ui
npm run test:coverage

# tauri
npm run tauri <command>
```

## 7) Document Locations

- Place documents under `doc/`
- Place ADRs under `doc/adr/`
