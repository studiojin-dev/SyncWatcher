import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import type { SyncTask } from '../hooks/useSyncTasks';
import type {
  DryRunResult,
  DryRunSessionState,
  DryRunSessionStatus,
  SyncSessionFinishedEvent,
  SyncSessionState,
} from '../types/syncEngine';
import type { TaskStatus } from '../hooks/useSyncTaskStatus';
import SyncTasksView from './SyncTasksView';

const {
  MockChannel,
  addTaskMock,
  deleteTaskMock,
  showToastMock,
  statusState,
  syncTasksState,
  updateTaskMock,
  useSyncTaskStatusStoreMock,
} = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    id = Math.floor(Math.random() * 1000);
    onmessage: (response: T) => void;

    constructor(onmessage?: (response: T) => void) {
      this.onmessage = onmessage ?? (() => undefined);
    }
  }

  const addTaskMock = vi.fn();
  const deleteTaskMock = vi.fn();
  const updateTaskMock = vi.fn();
  const showToastMock = vi.fn();
  const syncTasksState = {
    tasks: [] as SyncTask[],
  };
  const statusState = {
    statuses: new Map<string, TaskStatus>(),
    watchingTaskIds: new Set<string>(),
    queuedTaskIds: new Set<string>(),
    syncingTaskIds: new Set<string>(),
    dryRunningTaskIds: new Set<string>(),
    dryRunSessions: new Map<string, DryRunSessionState>(),
    syncSessions: new Map<string, SyncSessionState>(),
    setLastLog: vi.fn(),
    setDryRunning: vi.fn(),
    setDryRunningTasks: vi.fn(),
    beginDryRunSession: vi.fn(),
    setDryRunProgress: vi.fn(),
    appendDryRunDiffBatch: vi.fn(),
    completeDryRunSession: vi.fn(),
    failDryRunSession: vi.fn(),
    getDryRunSession: vi.fn(),
    clearDryRunSession: vi.fn(),
    beginSyncSession: vi.fn(),
    setSyncProgress: vi.fn(),
    appendSyncFileBatch: vi.fn(),
    completeSyncSession: vi.fn(),
    failSyncSession: vi.fn(),
    getSyncSession: vi.fn(),
    clearSyncSession: vi.fn(),
  };
  const useSyncTaskStatusStoreMock = Object.assign(() => statusState, {
    getState: () => statusState,
  });

  return {
    MockChannel,
    addTaskMock,
    deleteTaskMock,
    showToastMock,
    statusState,
    syncTasksState,
    updateTaskMock,
    useSyncTaskStatusStoreMock,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: MockChannel,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../context/SyncTasksContext', () => ({
  useSyncTasksContext: () => ({
    tasks: syncTasksState.tasks,
    addTask: addTaskMock,
    updateTask: updateTaskMock,
    deleteTask: deleteTaskMock,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../context/ExclusionSetsContext', () => ({
  useExclusionSetsContext: () => ({
    sets: [],
    getPatternsForSets: vi.fn(() => []),
  }),
}));

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      dataUnitSystem: 'binary',
    },
  }),
}));

vi.mock('../hooks/useSyncTaskStatus', () => ({
  useSyncTaskStatusStore: useSyncTaskStatusStoreMock,
  useDryRunSession: (taskId: string) => statusState.dryRunSessions.get(taskId),
  useSyncSession: (taskId: string) => statusState.syncSessions.get(taskId),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const askMock = ask as unknown as ReturnType<typeof vi.fn>;

function getInvokeArgs(command: string) {
  const call = invokeMock.mock.calls.find(([name]) => name === command);
  expect(call).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

function createDefaultTask(): SyncTask {
  return {
    id: 'task-1',
    name: 'Task 1',
    source: '[DISK_UUID:disk-1]/DCIM',
    target: '/tmp/target',
    checksumMode: false,
    watchMode: true,
    autoUnmount: true,
    sourceType: 'uuid',
  };
}

function createEmptyDryRunResult(): DryRunResult {
  return {
    diffs: [],
    total_files: 0,
    files_to_copy: 0,
    files_modified: 0,
    bytes_to_copy: 0,
    targetPreflight: null,
  };
}

function createDryRunSession(
  taskId: string,
  taskName: string,
  status: DryRunSessionStatus = 'running',
  result: DryRunResult = createEmptyDryRunResult(),
): DryRunSessionState {
  return {
    taskId,
    taskName,
    status,
    result,
    updatedAtUnixMs: Date.now(),
  };
}

function createSyncSession(
  taskId: string,
  taskName: string,
  status: 'running' | 'completed' | 'cancelled' | 'failed' = 'running',
): SyncSessionState {
  return {
    taskId,
    taskName,
    status,
    result: {
      entries: [],
      files_copied: 0,
      bytes_copied: 0,
      errors: [],
      conflictCount: 0,
      hasPendingConflicts: false,
      targetPreflight: null,
    },
    updatedAtUnixMs: Date.now(),
  };
}

function getOrCreateTaskStatus(taskId: string): TaskStatus {
  return statusState.statuses.get(taskId) ?? { taskId, status: 'idle' };
}

function setTaskStatus(taskId: string, status: TaskStatus['status']) {
  const current = getOrCreateTaskStatus(taskId);
  statusState.statuses.set(taskId, { ...current, status });
}

function installStatefulStatusMockImplementations() {
  statusState.setLastLog.mockImplementation(
    (taskId: string, log: TaskStatus['lastLog']) => {
      const current = getOrCreateTaskStatus(taskId);
      statusState.statuses.set(taskId, { ...current, lastLog: log });
    },
  );
  statusState.getDryRunSession.mockImplementation((taskId: string) =>
    statusState.dryRunSessions.get(taskId),
  );
  statusState.setDryRunning.mockImplementation(
    (taskId: string, dryRunning: boolean) => {
      if (dryRunning) {
        statusState.dryRunningTaskIds.add(taskId);
        setTaskStatus(taskId, 'dryRunning');
        return;
      }

      statusState.dryRunningTaskIds.delete(taskId);
      setTaskStatus(
        taskId,
        statusState.watchingTaskIds.has(taskId) ? 'watching' : 'idle',
      );
    },
  );
  statusState.beginDryRunSession.mockImplementation(
    (taskId: string, taskName: string) => {
      statusState.dryRunSessions.set(
        taskId,
        createDryRunSession(taskId, taskName),
      );
    },
  );
  statusState.completeDryRunSession.mockImplementation(
    (taskId: string, result: DryRunResult) => {
      const current =
        statusState.dryRunSessions.get(taskId) ??
        createDryRunSession(taskId, taskId);
      statusState.dryRunSessions.set(taskId, {
        ...current,
        status: 'completed',
        result,
        error: undefined,
        updatedAtUnixMs: Date.now(),
      });
    },
  );
  statusState.failDryRunSession.mockImplementation(
    (taskId: string, error: string) => {
      const current =
        statusState.dryRunSessions.get(taskId) ??
        createDryRunSession(taskId, taskId);
      statusState.dryRunSessions.set(taskId, {
        ...current,
        status: error.toLowerCase().includes('cancel') ? 'cancelled' : 'failed',
        error,
        updatedAtUnixMs: Date.now(),
      });
    },
  );
  statusState.clearDryRunSession.mockImplementation((taskId: string) => {
    statusState.dryRunSessions.delete(taskId);
  });
  statusState.beginSyncSession.mockImplementation(
    (taskId: string, taskName: string) => {
      statusState.syncSessions.set(taskId, createSyncSession(taskId, taskName));
    },
  );
  statusState.getSyncSession.mockImplementation((taskId: string) =>
    statusState.syncSessions.get(taskId),
  );
  statusState.completeSyncSession.mockImplementation((
    taskId: string,
    result: SyncSessionFinishedEvent,
  ) => {
    const current =
      statusState.syncSessions.get(taskId) ?? createSyncSession(taskId, taskId);
    statusState.syncSessions.set(taskId, {
      ...current,
      status: result.status,
      result: {
        ...current.result,
        files_copied: result.files_copied,
        bytes_copied: result.bytes_copied,
        errors: result.errors,
        conflictCount: result.conflictCount,
        hasPendingConflicts: result.hasPendingConflicts,
        targetPreflight: result.targetPreflight,
      },
      error: result.reason,
      updatedAtUnixMs: Date.now(),
    });
  });
  statusState.failSyncSession.mockImplementation((taskId: string, error: string) => {
    const current =
      statusState.syncSessions.get(taskId) ?? createSyncSession(taskId, taskId);
    statusState.syncSessions.set(taskId, {
      ...current,
      status: error.toLowerCase().includes('cancel') ? 'cancelled' : 'failed',
      error,
      updatedAtUnixMs: Date.now(),
    });
  });
  statusState.clearSyncSession.mockImplementation((taskId: string) => {
    statusState.syncSessions.delete(taskId);
  });
}

function renderWithMantine(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

function installDefaultInvokeMock() {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_conflict_review_sessions') {
      return [];
    }
    if (command === 'get_removable_volumes') {
      return [];
    }
    if (command === 'start_sync_from_dry_run') {
      return {
        syncResult: {
          files_copied: 0,
          bytes_copied: 0,
          errors: [],
        },
        conflictSessionId: null,
        conflictCount: 0,
        hasPendingConflicts: false,
        targetPreflight: null,
      };
    }
    if (command === 'sync_dry_run') {
      return createEmptyDryRunResult();
    }
    return undefined;
  });
}

describe('SyncTasksView dry-run flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncTasksState.tasks = [createDefaultTask()];
    statusState.statuses = new Map();
    statusState.watchingTaskIds = new Set(['task-1']);
    statusState.queuedTaskIds = new Set();
    statusState.syncingTaskIds = new Set();
    statusState.dryRunningTaskIds = new Set();
    statusState.dryRunSessions = new Map();
    statusState.syncSessions = new Map();
    statusState.setLastLog.mockReset();
    statusState.setDryRunning.mockReset();
    statusState.setDryRunningTasks.mockReset();
    statusState.beginDryRunSession.mockReset();
    statusState.setDryRunProgress.mockReset();
    statusState.appendDryRunDiffBatch.mockReset();
    statusState.completeDryRunSession.mockReset();
    statusState.failDryRunSession.mockReset();
    statusState.getDryRunSession.mockReset();
    statusState.clearDryRunSession.mockReset();
    statusState.beginSyncSession.mockReset();
    statusState.getSyncSession.mockReset();
    statusState.completeSyncSession.mockReset();
    statusState.failSyncSession.mockReset();
    statusState.clearSyncSession.mockReset();
    installStatefulStatusMockImplementations();
    statusState.getDryRunSession.mockImplementation((taskId: string) =>
      statusState.dryRunSessions.get(taskId),
    );
    listenMock.mockResolvedValue(() => {});
    askMock.mockResolvedValue(true);
    installDefaultInvokeMock();
  });

  it('does not execute dry-run before in-app confirmation', async () => {
    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));

    expect(askMock).not.toHaveBeenCalled();
    expect(screen.getByText('syncTasks.confirmDryRun')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
    ).toBe(false);
  });

  it('executes dry-run after in-app confirmation', async () => {
    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
      ).toBe(true);
    });
    expect(getInvokeArgs('sync_dry_run')).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        diffBatchChannel: expect.any(MockChannel),
      }),
    );
    expect(statusState.beginDryRunSession).toHaveBeenCalledWith('task-1', 'Task 1');
    expect(statusState.setDryRunning).toHaveBeenCalledWith('task-1', true);
    expect(statusState.completeDryRunSession).toHaveBeenCalledWith(
      'task-1',
      createEmptyDryRunResult(),
    );
  });

  it('applies dry-run diff batches through the invoke-scoped channel', async () => {
    let resolveDryRun!: (result: DryRunResult) => void;
    const dryRunPromise = new Promise<DryRunResult>((resolve) => {
      resolveDryRun = resolve;
    });

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'sync_dry_run') {
        return await dryRunPromise;
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
      ).toBe(true);
    });

    const { diffBatchChannel } = getInvokeArgs('sync_dry_run');
    (diffBatchChannel as InstanceType<typeof MockChannel>).onmessage({
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
    });

    expect(statusState.appendDryRunDiffBatch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        taskId: 'task-1',
        diffs: expect.arrayContaining([
          expect.objectContaining({
            path: 'a.txt',
            kind: 'New',
          }),
        ]),
      }),
    );

    resolveDryRun(createEmptyDryRunResult());
    await waitFor(() => {
      expect(statusState.completeDryRunSession).toHaveBeenCalledWith(
        'task-1',
        createEmptyDryRunResult(),
      );
    });
  });

  it('reopens an existing dry-run session instead of starting a new run', async () => {
    statusState.dryRunSessions = new Map([
      ['task-1', createDryRunSession('task-1', 'Task 1', 'completed')],
    ]);

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));

    expect(askMock).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
    ).toBe(false);
    expect(screen.getByText('syncTasks.dryRun · Task 1')).toBeInTheDocument();
  });

  it('keeps the dry-run icon distinct from the watch icon when a dry-run session exists', async () => {
    statusState.dryRunSessions = new Map([
      ['task-1', createDryRunSession('task-1', 'Task 1', 'completed')],
    ]);

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
      expect(screen.getByTitle('syncTasks.watchToggleOff')).toBeInTheDocument();
    });

    const dryRunIcon = screen
      .getByTitle('syncTasks.dryRun')
      .querySelector('svg');
    const watchIcon = screen
      .getByTitle('syncTasks.watchToggleOff')
      .querySelector('svg');

    expect(dryRunIcon).not.toBeNull();
    expect(watchIcon).not.toBeNull();
    expect(dryRunIcon?.innerHTML).not.toEqual(watchIcon?.innerHTML);
  });

  it('keeps the cancel modal path when dry-run is active without a local session', async () => {
    statusState.statuses = new Map([
      ['task-1', { taskId: 'task-1', status: 'dryRunning' }],
    ]);

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('common.cancel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('common.cancel'));

    expect(askMock).not.toHaveBeenCalled();
    expect(
      screen.getByText('syncTasks.cancelDryRun', { exact: false }),
    ).toBeInTheDocument();
  });

  it('starts a new dry-run from the result view retry action', async () => {
    statusState.dryRunSessions = new Map([
      ['task-1', createDryRunSession('task-1', 'Task 1', 'completed')],
    ]);

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));
    fireEvent.click(screen.getByText('common.retry'));

    expect(askMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
      ).toBe(true);
    });
    expect(statusState.beginDryRunSession).toHaveBeenCalledWith('task-1', 'Task 1');
  });

  it('returns to the dry-run result when sync now detects a stale reusable result', async () => {
    statusState.dryRunSessions = new Map([
      ['task-1', createDryRunSession('task-1', 'Task 1', 'completed')],
    ]);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'start_sync_from_dry_run') {
        throw new Error(
          'Dry Run result is stale. Run Dry Run again before syncing. Changed path: DCIM/a.jpg',
        );
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));
    fireEvent.click(screen.getByText('syncTasks.syncNowFromDryRun'));
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('start_sync_from_dry_run', {
        taskId: 'task-1',
        fileBatchChannel: expect.any(MockChannel),
      });
    });

    expect(statusState.clearSyncSession).toHaveBeenCalledWith('task-1');
    expect(statusState.syncSessions.has('task-1')).toBe(false);
    expect(screen.getByText('syncTasks.dryRun · Task 1')).toBeInTheDocument();
    expect(
      screen.queryByText('syncTasks.startSync · Task 1'),
    ).not.toBeInTheDocument();
    expect(showToastMock).toHaveBeenCalledWith(
      'syncTasks.dryRunSyncRequiresRerun',
      'warning',
    );
  });
});
