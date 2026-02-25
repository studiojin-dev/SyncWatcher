import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BackendRuntimeBridge from './BackendRuntimeBridge';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../../context/SyncTasksContext', () => ({
  useSyncTasksContext: () => ({
    tasks: [],
    loaded: true,
  }),
}));

vi.mock('../../context/ExclusionSetsContext', () => ({
  useExclusionSetsContext: () => ({
    sets: [],
    loaded: true,
  }),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      dataUnitSystem: 'binary',
    },
    loaded: true,
  }),
}));

const showToastMock = vi.fn();

vi.mock('../ui/Toast', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

const storeState = {
  setWatchingTasks: vi.fn(),
  setSyncingTasks: vi.fn(),
  setQueuedTasks: vi.fn(),
  getStatus: vi.fn(() => undefined),
  setStatus: vi.fn(),
  setLastLog: vi.fn(),
  setWatching: vi.fn(),
  setQueued: vi.fn(),
  setSyncing: vi.fn(),
  queuedTaskIds: new Set<string>(),
  syncingTaskIds: new Set<string>(),
};

vi.mock('../../hooks/useSyncTaskStatus', () => ({
  useSyncTaskStatusStore: {
    getState: () => storeState,
  },
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type TauriInternalsShape = {
  invoke?: unknown;
};

describe('BackendRuntimeBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.queuedTaskIds = new Set<string>();
    storeState.syncingTaskIds = new Set<string>();
    mockListen.mockResolvedValue(() => {});
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      value: { invoke: vi.fn() } satisfies TauriInternalsShape,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: TauriInternalsShape }).__TAURI_INTERNALS__;
  });

  it('marks initial runtime sync as error when runtime_set_config never resolves', async () => {
    vi.useFakeTimers();

    mockInvoke.mockImplementation((command: string) => {
      if (command === 'runtime_set_config') {
        return new Promise<never>(() => {});
      }
      return Promise.resolve(undefined);
    });

    const onStateChange = vi.fn();
    render(<BackendRuntimeBridge onInitialRuntimeSyncChange={onStateChange} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(onStateChange).toHaveBeenCalledWith('pending');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(onStateChange).toHaveBeenCalledWith('error');

    expect(showToastMock).toHaveBeenCalledWith('Failed to apply runtime configuration', 'error');

  });

  it('marks initial runtime sync as success when runtime_set_config resolves', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
    });

    const onStateChange = vi.fn();
    render(<BackendRuntimeBridge onInitialRuntimeSyncChange={onStateChange} />);

    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('success');
    });

    expect(mockInvoke).toHaveBeenCalledWith('runtime_set_config', {
      payload: {
        tasks: [],
        exclusionSets: [],
        settings: {
          dataUnitSystem: 'binary',
        },
      },
    });
  });
});
