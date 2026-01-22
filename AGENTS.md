# AGENTS.md - SyncWatcher Developer Guide

This guide helps agentic coding agents work effectively in the SyncWatcher codebase (Tauri + React + TypeScript).

## Build & Development Commands

```bash
# Development
npm run dev              # Start dev server (Vite + Tauri, port 1420)

# Building
npm run build           # TypeScript compile + Vite build
npm run preview         # Preview production build

# Tauri CLI (via npm script)
npm run tauri <command> # e.g., npm run tauri dev, npm run tauri build
```

## Documents

place documents in "doc" directory.

## Testing

**No testing framework is currently configured.** When adding tests:

- Consider Vitest for unit/integration tests (Vite-native)
- Consider React Testing Library for component tests
- Run single test: `npm test -- <test-file>` (once configured)

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

- Tailwind CSS v4.1.18 available but not actively used (using CSS modules via App.css)
- Dark mode support via `@media (prefers-color-scheme: dark)`
- CSS in `App.css` or component-specific `.css` files
- Tailwind integration: Add classes directly in JSX if using Tailwind utilities

## Project Structure

```
src/
├── main.tsx          # React root (ReactDOM.createRoot)
├── App.tsx           # Main component
├── App.css           # Styles
└── vite-env.d.ts     # Vite type definitions

src-tauri/
├── src/
│   ├── main.rs       # Entry point
│   └── lib.rs        # Tauri commands & app builder
├── Cargo.toml        # Rust dependencies
└── tauri.conf.json   # Tauri configuration
```

## Key Configuration Files

- **package.json**: Scripts, dependencies (React 18.3, Tauri v2, Vite 6)
- **tsconfig.json**: TypeScript strict mode, ES2020
- **vite.config.ts**: Vite + React plugin, Tauri dev server config (port 1420)
- **Cargo.toml**: Rust dependencies (tauri v2, serde)

## Development Notes

- **Vite dev server**: Fixed port 1420 (required by Tauri)
- **Hot Module Replacement**: Port 1421 for HMR
- **Ignore**: Vite ignores `src-tauri/**` in watch mode
- **Type checking**: Run via `tsc` (part of `npm run build`)

## Future Conventions (To Be Established)

- **Linting**: Consider ESLint when codebase grows
- **Formatting**: Consider Prettier for consistent formatting
- **Testing**: Establish test framework (Vitest recommended)
- **State management**: For complex state, consider Context API or Zustand
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
- Tailwind CSS v4: <https://tailwindcss.com/blog/tailwindcss-v4-alpha>
