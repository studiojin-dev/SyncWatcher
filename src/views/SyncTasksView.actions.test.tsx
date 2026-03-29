import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import type { SyncTask } from '../hooks/useSyncTasks';
import type { DryRunSessionState } from '../types/syncEngine';
import type { TaskStatus } from '../hooks/useSyncTaskStatus';
import SyncTasksView from './SyncTasksView';

const {
  addTaskMock,
  deleteTaskMock,
  showToastMock,
  statusState,
  syncTasksState,
  updateTaskMock,
  useSyncTaskStatusStoreMock,
} = vi.hoisted(() => {
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
  };
  const useSyncTaskStatusStoreMock = Object.assign(() => statusState, {
    getState: () => statusState,
  });

  return {
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
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const askMock = ask as unknown as ReturnType<typeof vi.fn>;

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
    if (command === 'runtime_validate_tasks') {
      return {
        ok: true,
        issue: null,
      };
    }
    if (command === 'runtime_validate_orphan_scan') {
      return {
        ok: true,
        issue: null,
      };
    }
    if (command === 'start_sync') {
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
      return {
        diffs: [],
        total_files: 0,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: null,
      };
    }
    return undefined;
  });
}

describe('SyncTasksView sync and watch confirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncTasksState.tasks = [createDefaultTask()];
    statusState.statuses = new Map();
    statusState.watchingTaskIds = new Set(['task-1']);
    statusState.queuedTaskIds = new Set();
    statusState.syncingTaskIds = new Set();
    statusState.dryRunningTaskIds = new Set();
    statusState.dryRunSessions = new Map();
    statusState.setLastLog.mockReset();
    statusState.clearDryRunSession.mockReset();
    listenMock.mockResolvedValue(() => {});
    askMock.mockResolvedValue(true);
    installDefaultInvokeMock();
  });

  it('requests source review when sync fails because the UUID source is unresolved', async () => {
    const onRequestSourceRecommendationReview = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'start_sync') {
        throw new Error('Volume with DISK_UUID old-disk not found (not mounted?)');
      }
      return undefined;
    });

    renderWithMantine(
      <SyncTasksView
        onRequestSourceRecommendationReview={onRequestSourceRecommendationReview}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.startSync')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.startSync'));

    await waitFor(() => {
      expect(onRequestSourceRecommendationReview).toHaveBeenCalledWith('task-1');
    });
  });

  it('does not execute sync when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.startSync')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.startSync'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(invokeMock.mock.calls.some((call) => call[0] === 'start_sync')).toBe(
      false,
    );
  });

  it('does not toggle watch off when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.watchToggleOff')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.watchToggleOff'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('skips manual auto-unmount when session suppression is enabled', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'start_sync') {
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
      if (command === 'is_auto_unmount_session_disabled') {
        return true;
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.startSync')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.startSync'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'is_auto_unmount_session_disabled',
        {
          taskId: 'task-1',
        },
      );
    });

    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'unmount_volume'),
    ).toBe(false);
    expect(statusState.setLastLog).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        message: 'syncTasks.autoUnmountSuppressedStatus',
        level: 'warning',
      }),
    );
  });
});
