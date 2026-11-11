import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { vi } from 'vitest';

if (typeof window !== 'undefined' && typeof window.alert !== 'function') {
  Object.defineProperty(window, 'alert', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
}

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => { }),
}));

// Mock Tauri dialog plugin
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  ask: vi.fn(async () => true),
}));

// Cleanup after each test
afterEach(async () => {
  cleanup();
  // Let asynchronous native listener disposal finish before the next test
  // replaces its event handlers and clears the mocks.
  await Promise.resolve();
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  vi.clearAllMocks();
});
