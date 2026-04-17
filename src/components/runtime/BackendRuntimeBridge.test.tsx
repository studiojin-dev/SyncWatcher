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
  setDryRunningTasks: vi.fn(),
  getStatus: vi.fn(
    (
      _taskId?: string,
    ):
      | { status?: string; lastLog?: { message: string } }
      | undefined => undefined,
  ),
  setStatus: vi.fn(),
  setLastLog: vi.fn(),
  setProgress: vi.fn(),
  setWatching: vi.fn(),
  setQueued: vi.fn(),
  setSyncing: vi.fn(),
  setDryRunning: vi.fn(),
  beginDryRunSession: vi.fn(),
  setDryRunProgress: vi.fn(),
  appendDryRunDiffBatch: vi.fn(),
  completeDryRunSession: vi.fn(),
  failDryRunSession: vi.fn(),
  getDryRunSession: vi.fn((taskId: string) => storeState.dryRunSessions.get(taskId)),
  clearDryRunSession: vi.fn(),
  beginSyncSession: vi.fn(),
  setSyncProgress: vi.fn(),
  appendSyncFileBatch: vi.fn(),
  completeSyncSession: vi.fn(),
  failSyncSession: vi.fn(),
  getSyncSession: vi.fn((taskId: string) => storeState.syncSessions.get(taskId)),
  clearSyncSession: vi.fn(),
  queuedTaskIds: new Set<string>(),
  syncingTaskIds: new Set<string>(),
  dryRunningTaskIds: new Set<string>(),
  dryRunSessions: new Map<string, unknown>(),
  syncSessions: new Map<string, unknown>(),
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('BackendRuntimeBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    storeState.queuedTaskIds = new Set<string>();
    storeState.syncingTaskIds = new Set<string>();
    storeState.dryRunningTaskIds = new Set<string>();
    storeState.dryRunSessions = new Map<string, unknown>();
    storeState.syncSessions = new Map<string, unknown>();
    storeState.getStatus.mockImplementation(() => undefined);
    storeState.setLastLog.mockImplementation(() => undefined);
    storeState.setProgress.mockImplementation(() => undefined);
    storeState.setDryRunning.mockImplementation(() => undefined);
    storeState.setDryRunningTasks.mockImplementation(() => undefined);
    storeState.beginDryRunSession.mockImplementation(() => undefined);
    storeState.setDryRunProgress.mockImplementation(() => undefined);
    storeState.appendDryRunDiffBatch.mockImplementation(() => undefined);
    storeState.completeDryRunSession.mockImplementation(() => undefined);
    storeState.failDryRunSession.mockImplementation(() => undefined);
    storeState.getDryRunSession.mockImplementation((taskId: string) => storeState.dryRunSessions.get(taskId));
    storeState.setSyncProgress.mockImplementation(() => undefined);
    storeState.appendSyncFileBatch.mockImplementation(() => undefined);
    storeState.completeSyncSession.mockImplementation(() => undefined);
    storeState.failSyncSession.mockImplementation(() => undefined);
    storeState.getSyncSession.mockImplementation((taskId: string) => storeState.syncSessions.get(taskId));
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
      dryRunningTasks: [],
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
      dryRunningTasks: [],
    })
    .mockResolvedValueOnce({
      watchingTasks: ['task-1'],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
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

  it('ignores an older runtime snapshot when a newer refresh resolves first', async () => {
    const firstRequest = createDeferred<{
      watchingTasks: string[];
      syncingTasks: string[];
      queuedTasks: string[];
      dryRunningTasks: string[];
    }>();
    const secondRequest = createDeferred<{
      watchingTasks: string[];
      syncingTasks: string[];
      queuedTasks: string[];
      dryRunningTasks: string[];
    }>();

    mockInvoke
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    const onStateChange = vi.fn();
    render(<BackendRuntimeBridge onInitialRuntimeSyncChange={onStateChange} />);

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

    await act(async () => {
      secondRequest.resolve({
        watchingTasks: ['task-new'],
        syncingTasks: [],
        queuedTasks: [],
        dryRunningTasks: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(storeState.setWatchingTasks).toHaveBeenCalledWith(['task-new']);
      expect(onStateChange).toHaveBeenCalledWith('success');
    });

    const appliedCallCount = storeState.setWatchingTasks.mock.calls.length;

    await act(async () => {
      firstRequest.resolve({
        watchingTasks: ['task-old'],
        syncingTasks: [],
        queuedTasks: [],
        dryRunningTasks: [],
      });
      await Promise.resolve();
    });

    expect(storeState.setWatchingTasks).toHaveBeenCalledTimes(appliedCallCount);
    expect(storeState.setWatchingTasks).not.toHaveBeenCalledWith(['task-old']);
  });

  it('ignores a stale runtime error after a newer runtime sync succeeds', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstRequest = createDeferred<{
      watchingTasks: string[];
      syncingTasks: string[];
      queuedTasks: string[];
      dryRunningTasks: string[];
    }>();
    const secondRequest = createDeferred<{
      watchingTasks: string[];
      syncingTasks: string[];
      queuedTasks: string[];
      dryRunningTasks: string[];
    }>();

    mockInvoke
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    const onStateChange = vi.fn();
    render(<BackendRuntimeBridge onInitialRuntimeSyncChange={onStateChange} />);

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

    await act(async () => {
      secondRequest.resolve({
        watchingTasks: [],
        syncingTasks: [],
        queuedTasks: [],
        dryRunningTasks: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('success');
    });

    await act(async () => {
      firstRequest.reject(new Error('stale failure'));
      await Promise.resolve();
    });

    expect(onStateChange).not.toHaveBeenCalledWith('error');
    expect(showToastMock).not.toHaveBeenCalledWith('Failed to read runtime state', 'error');
    expect(storeState.setLastLog).not.toHaveBeenCalledWith('__runtime__', expect.anything());
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      'Runtime state sync command failed',
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
  });

  it('ignores late runtime_get_state resolution after unmount', async () => {
    const pendingRequest = createDeferred<{
      watchingTasks: string[];
      syncingTasks: string[];
      queuedTasks: string[];
      dryRunningTasks: string[];
    }>();

    mockInvoke.mockImplementationOnce(() => pendingRequest.promise);

    const onStateChange = vi.fn();
    const { unmount } = render(
      <BackendRuntimeBridge onInitialRuntimeSyncChange={onStateChange} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(onStateChange).toHaveBeenCalledWith('pending');

    unmount();

    await act(async () => {
      pendingRequest.resolve({
        watchingTasks: ['task-late'],
        syncingTasks: [],
        queuedTasks: [],
        dryRunningTasks: [],
      });
      await Promise.resolve();
    });

    expect(storeState.setWatchingTasks).not.toHaveBeenCalled();
    expect(onStateChange.mock.calls).toEqual([['pending']]);
    expect(showToastMock).not.toHaveBeenCalled();
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
      dryRunningTasks: [],
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
          origin: 'manual',
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
          origin: 'manual',
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

  it('updates manual sync sessions from sync progress while leaving file batches to invoke channels', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });
    storeState.syncSessions = new Map([
      ['task-1', { status: 'running' }],
    ]);

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('sync-progress')).toBe(true);
      expect(eventHandlers.has('sync-session-finished')).toBe(true);
    });

    expect(eventHandlers.has('sync-file-batch')).toBe(false);

    act(() => {
      eventHandlers.get('sync-progress')?.({
        payload: {
          taskId: 'task-1',
          origin: 'manual',
          message: 'copying.mov',
        },
      });
    });

    expect(storeState.setSyncProgress).toHaveBeenCalledTimes(1);
    expect(storeState.appendSyncFileBatch).not.toHaveBeenCalled();
  });

  it('terminalizes manual sync sessions from sync-session-finished', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });
    storeState.syncSessions = new Map([
      ['task-1', { status: 'running' }],
    ]);

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('sync-session-finished')).toBe(true);
    });

    act(() => {
      eventHandlers.get('sync-session-finished')?.({
        payload: {
          taskId: 'task-1',
          origin: 'manual',
          status: 'completed',
          files_copied: 2,
          bytes_copied: 20,
          errors: [],
          conflictCount: 0,
          hasPendingConflicts: false,
          targetPreflight: null,
        },
      });
    });

    expect(storeState.completeSyncSession).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        files_copied: 2,
      }),
    );
  });

  it('ignores sync-session-finished when the session was already cleared', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });
    storeState.syncSessions = new Map();

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('sync-session-finished')).toBe(true);
    });

    act(() => {
      eventHandlers.get('sync-session-finished')?.({
        payload: {
          taskId: 'task-1',
          origin: 'manual',
          status: 'failed',
          files_copied: 0,
          bytes_copied: 0,
          errors: [],
          conflictCount: 0,
          hasPendingConflicts: false,
          targetPreflight: null,
          reason: 'Dry Run result is stale.',
        },
      });
    });

    expect(storeState.completeSyncSession).not.toHaveBeenCalled();
  });

  it('requests source review when runtime sync ends with an unresolved UUID source', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });

    const onUuidSourceResolutionError = vi.fn();
    render(
      <BackendRuntimeBridge
        onUuidSourceResolutionError={onUuidSourceResolutionError}
      />,
    );

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
          origin: 'manual',
          reason: 'Volume with DISK_UUID old-disk not found (not mounted?)',
        },
      });
    });

    expect(onUuidSourceResolutionError).toHaveBeenCalledWith('task-1');
  });

  it('stores dry-run progress and accepts dry-run diff batch fallback events', async () => {
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-dry-run-state')).toBe(true);
      expect(eventHandlers.has('dry-run-progress')).toBe(true);
      expect(eventHandlers.has('dry-run-diff-batch')).toBe(true);
    });

    act(() => {
      eventHandlers.get('runtime-dry-run-state')?.({
        payload: {
          taskId: 'task-1',
          dryRunning: true,
          reason: 'Dry run started',
        },
      });
      eventHandlers.get('dry-run-progress')?.({
        payload: {
          taskId: 'task-1',
          phase: 'scanningSource',
          message: 'Scanning source',
          current: 2,
          total: 10,
          processedBytes: 2048,
          totalBytes: 8192,
        },
      });
      eventHandlers.get('dry-run-diff-batch')?.({
        payload: {
          taskId: 'task-1',
          phase: 'comparing',
          message: 'Comparing',
          diffs: [
            {
              path: 'a.txt',
              kind: 'New',
              source_size: 1024,
              target_size: null,
              checksum_source: null,
              checksum_target: null,
            },
          ],
          summary: {
            total_files: 10,
            files_to_copy: 1,
            files_modified: 0,
            bytes_to_copy: 1024,
          },
          targetPreflight: null,
        },
      });
    });

    expect(storeState.setDryRunning).toHaveBeenCalledWith('task-1', true);
    expect(storeState.setDryRunProgress).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        phase: 'scanningSource',
        message: 'Scanning source',
      }),
    );
    expect(storeState.appendDryRunDiffBatch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        taskId: 'task-1',
        message: 'Comparing',
      }),
    );
    expect(storeState.setLastLog).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        message: 'Dry run started',
        level: 'info',
      }),
    );
  });

  it('keeps dry-running status when runtime-watch-state arrives for the same task', async () => {
    storeState.getStatus.mockImplementation((taskId?: string) => (
      taskId === 'task-1' ? { status: 'dryRunning' } : undefined
    ));
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-watch-state')).toBe(true);
    });

    act(() => {
      eventHandlers.get('runtime-watch-state')?.({
        payload: {
          taskId: 'task-1',
          watching: true,
        },
      });
    });

    expect(storeState.setStatus).not.toHaveBeenCalledWith('task-1', 'watching');
    expect(storeState.setStatus).not.toHaveBeenCalledWith('task-1', 'idle');
  });

  it('ignores late dry-run progress after a terminal session', async () => {
    storeState.dryRunSessions = new Map<string, unknown>([
      [
        'task-1',
        {
          taskId: 'task-1',
          taskName: 'Task 1',
          status: 'completed',
          result: {
            diffs: [],
            total_files: 0,
            files_to_copy: 0,
            files_modified: 0,
            bytes_to_copy: 0,
            targetPreflight: null,
          },
        },
      ],
    ]);
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
    });

    render(<BackendRuntimeBridge />);

    await waitFor(() => {
      expect(eventHandlers.has('dry-run-progress')).toBe(true);
      expect(eventHandlers.has('dry-run-diff-batch')).toBe(true);
    });

    act(() => {
      eventHandlers.get('dry-run-progress')?.({
        payload: {
          taskId: 'task-1',
          phase: 'comparing',
          message: 'late progress',
        },
      });
      eventHandlers.get('dry-run-diff-batch')?.({
        payload: {
          taskId: 'task-1',
          phase: 'comparing',
          message: 'late diff batch',
          diffs: [],
          summary: {
            total_files: 0,
            files_to_copy: 0,
            files_modified: 0,
            bytes_to_copy: 0,
          },
          targetPreflight: null,
        },
      });
    });

    expect(storeState.setDryRunning).not.toHaveBeenCalledWith('task-1', true);
    expect(storeState.setDryRunProgress).not.toHaveBeenCalled();
    expect(storeState.appendDryRunDiffBatch).not.toHaveBeenCalled();
  });

  it('sets sync completion message when runtime sync ends without reason', async () => {
    storeState.getStatus.mockImplementation((taskId?: string) => (
      taskId ? { lastLog: { message: 'Syncing...' } } : undefined
    ));
    mockInvoke.mockResolvedValue({
      watchingTasks: [],
      syncingTasks: [],
      queuedTasks: [],
      dryRunningTasks: [],
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
          origin: 'manual',
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
      dryRunningTasks: [],
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
          origin: 'manual',
          reason: 'sync failed',
        },
      });
    });

    expect(storeState.setLastLog).not.toHaveBeenCalled();
  });
});
