import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import BackendRuntimeBridge from './BackendRuntimeBridge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../../context/SyncTasksContext', () => ({
  useSyncTasksContext: () => ({
    loaded: true,
  }),
}));

vi.mock('../../context/ExclusionSetsContext', () => ({
  useExclusionSetsContext: () => ({
    loaded: true,
  }),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
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
  getStatus: vi.fn((_taskId?: string): { lastLog?: { message: string } } | undefined => undefined),
  setStatus: vi.fn(),
  setLastLog: vi.fn(),
  setProgress: vi.fn(),
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
const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();

type TauriInternalsShape = {
  invoke?: unknown;
};

describe('BackendRuntimeBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    storeState.queuedTaskIds = new Set<string>();
    storeState.syncingTaskIds = new Set<string>();
    storeState.getStatus.mockImplementation(() => undefined);
    storeState.setLastLog.mockImplementation(() => undefined);
    storeState.setProgress.mockImplementation(() => undefined);
    mockListen.mockImplementation(async (eventName: string, handler: (event: { payload?: unknown }) => void) => {
      eventHandlers.set(eventName, handler);
      return () => {
        eventHandlers.delete(eventName);
      };
    });
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

  it('marks initial runtime sync as error when runtime_get_state never resolves', async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockInvoke.mockImplementation((command: string) => {
      if (command === 'runtime_get_state') {
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

    expect(showToastMock).toHaveBeenCalledWith('Failed to read runtime state', 'error');
    consoleErrorSpy.mockRestore();

  });

  it('marks initial runtime sync as success when runtime_get_state resolves', async () => {
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

    expect(mockInvoke).toHaveBeenCalledWith('runtime_get_state');
  });

  it('refreshes runtime state when config-store-changed is emitted', async () => {
    mockInvoke
      .mockResolvedValueOnce({
        watchingTasks: [],
        syncingTasks: [],
        queuedTasks: [],
      })
      .mockResolvedValueOnce({
        watchingTasks: ['task-1'],
        syncingTasks: [],
        queuedTasks: [],
      });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('config-store-changed')).toBe(true);
    });

    const handler = eventHandlers.get('config-store-changed');
    if (!handler) {
      throw new Error('config-store-changed handler not found');
    }

    act(() => {
      handler({
        payload: {
          scope: 'settings',
        },
      });
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
    expect(storeState.setWatchingTasks).toHaveBeenLastCalledWith(['task-1']);
  });

  it('stores progress and avoids duplicate lastLog updates when message is unchanged', async () => {
    const statusMap = new Map<string, { lastLog?: { message: string } }>();
    storeState.getStatus.mockImplementation((taskId?: string) => (
      taskId ? statusMap.get(taskId) : undefined
    ));
    storeState.setLastLog.mockImplementation((taskId: string, log: { message: string }) => {
      statusMap.set(taskId, { lastLog: { message: log.message } });
    });
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('sync-progress')).toBe(true);
    });

    const handler = eventHandlers.get('sync-progress');
    if (!handler) {
      throw new Error('sync-progress handler not found');
    }

    act(() => {
      handler({
        payload: {
          taskId: 'task-1',
          message: 'copying.mov',
          current: 1,
          total: 2,
          processedBytes: 1024,
          totalBytes: 4096,
          currentFileBytesCopied: 1024,
          currentFileTotalBytes: 2048,
        },
      });
      handler({
        payload: {
          taskId: 'task-1',
          message: 'copying.mov',
          current: 1,
          total: 2,
          processedBytes: 1536,
          totalBytes: 4096,
          currentFileBytesCopied: 1536,
          currentFileTotalBytes: 2048,
        },
      });
    });

    expect(storeState.setProgress).toHaveBeenCalledTimes(2);
    expect(storeState.setLastLog).toHaveBeenCalledTimes(1);
  });

  it('sets sync completion message when runtime sync ends without reason', async () => {
    storeState.getStatus.mockImplementation((taskId?: string) => (
      taskId ? { lastLog: { message: 'Syncing...' } } : undefined
    ));
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-sync-state')).toBe(true);
    });

    const handler = eventHandlers.get('runtime-sync-state');
    if (!handler) {
      throw new Error('runtime-sync-state handler not found');
    }

    act(() => {
      handler({
        payload: {
          taskId: 'task-1',
          syncing: false,
        },
      });
    });

    expect(storeState.setLastLog).toHaveBeenCalledWith('task-1', expect.objectContaining({
      message: 'sync.syncComplete',
      level: 'success',
    }));
  });

  it('does not overwrite explicit auto-unmount status with runtime sync reason', async () => {
    storeState.getStatus.mockImplementation((taskId?: string) => (
      taskId ? { lastLog: { message: 'syncTasks.autoUnmountPendingStatus' } } : undefined
    ));
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-sync-state')).toBe(true);
    });

    const handler = eventHandlers.get('runtime-sync-state');
    if (!handler) {
      throw new Error('runtime-sync-state handler not found');
    }

    act(() => {
      handler({
        payload: {
          taskId: 'task-1',
          syncing: false,
          reason: 'sync failed',
        },
      });
    });

    expect(storeState.setLastLog).not.toHaveBeenCalled();
  });
});
