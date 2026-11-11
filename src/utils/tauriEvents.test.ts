import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferUnlisten } from './tauriEvents';

afterEach(() => vi.useRealTimers());

describe('Tauri event cleanup', () => {
  it('allows queued native JS registration to settle before unregistering', async () => {
    let installed = false;
    setTimeout(() => { installed = true; }, 0);
    const unlisten = vi.fn(() => {
      if (!installed) throw new TypeError('listeners[eventId] is undefined');
    });
    await expect(deferUnlisten(unlisten)()).resolves.toBeUndefined();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('unregisters only once even when cleanup is requested repeatedly', async () => {
    const unlisten = vi.fn();
    const cleanup = deferUnlisten(unlisten);
    await Promise.all([cleanup(), cleanup(), cleanup()]);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('preserves actual cleanup failures for callers to handle', async () => {
    const error = new Error('native cleanup failed');
    const cleanup = deferUnlisten(() => { throw error; });
    await expect(cleanup()).rejects.toBe(error);
  });
});
