import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from '@tauri-apps/api/app';
import { DEFAULT_APP_VERSION, useAppVersion } from './useAppVersion';

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

const mockGetVersion = vi.mocked(getVersion);

describe('useAppVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the runtime version when Tauri app API succeeds', async () => {
    mockGetVersion.mockResolvedValueOnce('1.1.6');

    const { result } = renderHook(() => useAppVersion());

    await waitFor(() => {
      expect(result.current).toBe('1.1.6');
    });
  });

  it('keeps the tauri.conf.json version as fallback when Tauri app API fails', async () => {
    mockGetVersion.mockRejectedValueOnce(new Error('Failed to get version'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAppVersion());

    await waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        'Failed to get app version from Tauri app API; using tauri.conf.json version'
      );
    });
    expect(result.current).toBe(DEFAULT_APP_VERSION);

    consoleWarn.mockRestore();
  });
});
