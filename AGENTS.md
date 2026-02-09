# AGENTS.md - SyncWatcher

This repository uses AI coding agents.
If rules are missing or unclear, the agent must ask before proceeding.

## Purpose & Scope

This file defines HOW the agent works.
WHAT to build is defined in SPECS (see `doc/`).
WHY decisions were made is defined in ADRs (see `doc/adr/`).

## Core Rules

- Prefer correctness and clarity over cleverness
- Do not introduce new dependencies or services unless explicitly requested
- Avoid large refactors unless explicitly requested
- Preserve existing public behavior by default

## Plan Then Act

For non-trivial tasks:

1. Restate the goal in one sentence
2. Propose a short plan
3. (TDD, when possible) Red: write a failing test or a clear reproduction
4. (TDD, when possible) Green: make the minimal change to pass
5. (TDD, when possible) Blue: refactor for clarity and maintainability
6. Summarize what changed and why

## Documentation Rule (MUST)

Consult authoritative documentation when tasks involve:

- specific APIs, options, or signatures
- version-dependent or "latest" behavior
- deployment, auth, cloud, or security concerns
- production reliability or performance

If documentation is required and unavailable, ask for it or state uncertainty.

## ADR Rule (MUST)

Architectural or design decisions with trade-offs MUST be recorded as ADRs
(e.g. in `doc/adr/`).
The agent MUST NOT override existing ADRs without updating them first.
If a change introduces new constraints or non-obvious choices, stop and request an ADR.

## Verification

Do not claim correctness without describing how to verify it
(tests, build, or realistic checks).

## Repository Hygiene

If a .gitignore file does not exist, create one before adding
environment-, build-, or tool-specific files.

## Stop and Ask

Ask before proceeding if requirements are unclear,
changes are breaking, or behavior depends on docs or decisions.

---

## Build & Development Commands

```bash
# Development
npm run dev              # Start dev server (Vite + Tauri, port 1420)

# Building
npm run build           # TypeScript compile + Vite build
npm run preview         # Preview production build

# Linting
npm run lint            # ESLint with auto-fix
npm run lint:check      # ESLint check only (no auto-fix)

# Testing
npm run test            # Run Vitest
npm run test:ui         # Vitest with UI
npm run test:coverage   # Vitest with coverage

# Tauri CLI (via npm script)
npm run tauri <command> # e.g., npm run tauri dev, npm run tauri build
```

## Documents

Place documents in `doc/` directory.

## Testing

- **Framework**: Vitest with React Testing Library
- **Run tests**: `npm run test` or `npm run test:ui`
- **Single test**: `npm test -- <test-file>`
- **Coverage**: `npm run test:coverage`

## TypeScript Configuration

- **Target**: ES2020
- **Strict mode**: Enabled (`strict: true`)
- **No unused locals/parameters**: Enforced
- **JSX**: React JSX transform (`react-jsx`)
- **Module resolution**: Bundler mode
- **Key rule**: Never suppress type errors with `as any` or `@ts-ignore`

## Code Style Guidelines

### Imports

```typescript
// Order: External packages → Local imports
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./App.css";
```

### Component Patterns

```typescript
// Functional components with hooks (preferred)
function ComponentName() {
  const [state, setState] = useState("");

  async function handleAction() {
    // Async functions for Tauri commands
    const result = await invoke("command_name", { param });
  }

  return <div>{/* JSX */}</div>;
}

export default ComponentName;
```

### Naming Conventions

- **Components**: PascalCase (`MyComponent`)
- **Functions/variables**: camelCase (`myFunction`, `myVariable`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_ITEMS`)
- **Tauri commands**: snake_case in Rust (`greet_name`), invoked with same name in TypeScript

### Type Usage

- Prefer inferred types when obvious
- Explicit types for function parameters and returns
- Type assertions only when absolutely necessary (use sparingly)
- Interface for object shapes, Type for unions/primitives

### Tauri Integration

```typescript
// Frontend (TypeScript)
import { invoke } from "@tauri-apps/api/core";

async function callRust() {
  const result = await invoke("command_name", { param: value });
}

// Backend (Rust)
#[tauri::command]
fn command_name(param: &str) -> String {
    // Rust implementation
}

// Register in invoke_handler
.invoke_handler(tauri::generate_handler![command_name])
```

### Error Handling

- Rust: `.expect()` for panics, `Result` types for recoverable errors
- TypeScript: try/catch blocks, proper error logging (to be added)
- Always handle async errors with try/catch or .catch()

### React Patterns

- Use functional components with hooks
- Prefer `useState` over class components
- Use `React.StrictMode` wrapper in root
- Controlled components for forms
- Event handlers: `onChange={(e) => handleChange(e)}`

### CSS & Styling

- **Tailwind CSS v4** with Vite plugin
- Dark mode support via `@media (prefers-color-scheme: dark)`
- Component-specific CSS in `src/styles/`

## Key Configuration Files

- **package.json**: Scripts, dependencies (React 18.3, Tauri v2, Vite 6, Zustand)
- **tsconfig.json**: TypeScript strict mode, ES2020
- **vite.config.ts**: Vite + React plugin, Tauri dev server config (port 1420)
- **vitest.config.ts**: Vitest configuration with happy-dom
- **.eslintrc.json**: ESLint rules with TypeScript support
- **Cargo.toml**: Rust dependencies (tauri v2, serde)

## Development Notes

- **Vite dev server**: Fixed port 1420 (required by Tauri)
- **Hot Module Replacement**: Port 1421 for HMR
- **Ignore**: Vite ignores `src-tauri/**` in watch mode
- **Type checking**: Run via `tsc` (part of `npm run build`)

## Future Conventions (To Be Established)

- **Formatting**: Consider Prettier for consistent formatting
- **API calls**: Centralize Tauri command invocations in a dedicated module

## Tauri-Specific Guidelines

- Commands defined in `src-tauri/src/lib.rs`
- Registered in `.invoke_handler()`
- Invoked via `@tauri-apps/api/core`
- Parameters: Pass as object `invoke("cmd", { param: value })`
- Serialization: `serde` handles JSON conversion automatically

## When Making Changes

1. **Frontend changes**: Run `npm run dev` to test in Tauri dev mode
2. **Rust changes**: Tauri CLI auto-recompiles
3. **Type safety**: Verify with `tsc` (included in build)
4. **Cross-platform**: Test on target platforms (macOS, Linux, Windows)

## Common Issues

- **Port 1420 in use**: Kill process or change port in vite.config.ts (not recommended for Tauri)
- **Type errors**: Fix before commit—never suppress with @ts-ignore
- **Rust compile errors**: Check Cargo.toml dependencies and Cargo.lock
- **Tauri command not found**: Ensure command is registered in invoke_handler and exported

## Additional Resources

- Tauri docs: <https://tauri.app/develop/>
- React docs: <https://react.dev/>
- Vite docs: <https://vitejs.dev/>
- Tailwind CSS v4: <https://tailwindcss.com/docs/installation/using-vite>
