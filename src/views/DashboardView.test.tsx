import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import DashboardView from './DashboardView';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string, fallback?: string) => {
      const translations: Record<string, string> = {
        'dashboard.title': 'Dashboard',
        'dashboard.connected': 'connected',
        'dashboard.noDevices': 'no devices',
        'dashboard.analyzing': 'Analyzing...',
        'common.loading': 'Loading...',
        'common.retry': 'Retry',
      };
      return translations[key] ?? fallback ?? key;
    }),
  })),
}));

type VolumeInfo = {
  name: string;
  mount_point: string;
  total_bytes: number;
  available_bytes: number;
  is_removable: boolean;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

let volumeChangedHandler: (() => void) | null = null;

function sampleVolume(name: string, mountPoint: string): VolumeInfo {
  return {
    name,
    mount_point: mountPoint,
    total_bytes: 100,
    available_bytes: 40,
    is_removable: true,
  };
}

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    volumeChangedHandler = null;

    mockListen.mockImplementation(async (_event: string, handler: () => void) => {
      volumeChangedHandler = handler;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores stale failed request after a newer successful request', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createDeferred<VolumeInfo[]>();
    const second = createDeferred<VolumeInfo[]>();

    mockInvoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<DashboardView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    act(() => {
      volumeChangedHandler?.();
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      second.resolve([sampleVolume('USB', '/Volumes/USB')]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('/Volumes/USB')).toBeInTheDocument();
    });

    await act(async () => {
      first.reject(new Error('stale failure'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText(/^ERROR:/)).not.toBeInTheDocument();
    });

    errorSpy.mockRestore();
  });

  it('keeps loading indicator while older request is still in flight', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createDeferred<VolumeInfo[]>();
    const second = createDeferred<VolumeInfo[]>();

    mockInvoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<DashboardView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    act(() => {
      volumeChangedHandler?.();
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      second.resolve([sampleVolume('SD', '/Volumes/SD')]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('/Volumes/SD')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Loading...')).toBeInTheDocument();

    await act(async () => {
      first.resolve([sampleVolume('Old', '/Volumes/OLD')]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Loading...')).not.toBeInTheDocument();
    });

    errorSpy.mockRestore();
  });

  it('handles listen cleanup failure without unhandled rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListen.mockReturnValueOnce(Promise.reject(new Error('listen failed')));

    const { unmount } = render(<DashboardView />);
    unmount();

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[DashboardView] Failed to unlisten volumes-changed',
        expect.any(Error),
      );
    });

    warnSpy.mockRestore();
  });
});
