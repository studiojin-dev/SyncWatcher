import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, open } from '@tauri-apps/plugin-dialog';
import SyncTasksView from './SyncTasksView';

const {
  updateTaskMock,
  deleteTaskMock,
  addTaskMock,
  statusState,
  useSyncTaskStatusStoreMock,
} = vi.hoisted(() => {
  const updateTaskMock = vi.fn();
  const deleteTaskMock = vi.fn();
  const addTaskMock = vi.fn();
  const statusState = {
    statuses: new Map(),
    watchingTaskIds: new Set<string>(['task-1']),
    queuedTaskIds: new Set<string>(),
    syncingTaskIds: new Set<string>(),
  };
  const useSyncTaskStatusStoreMock = Object.assign(
    () => statusState,
    {
      getState: () => statusState,
    },
  );
  return {
    updateTaskMock,
    deleteTaskMock,
    addTaskMock,
    statusState,
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
    tasks: [
      {
        id: 'task-1',
        name: 'Task 1',
        source: '[DISK_UUID:disk-1]/DCIM',
        target: '/tmp/target',
        checksumMode: false,
        watchMode: true,
        autoUnmount: true,
        sourceType: 'uuid',
      },
    ],
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
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const askMock = ask as unknown as ReturnType<typeof vi.fn>;
const openMock = open as unknown as ReturnType<typeof vi.fn>;

describe('SyncTasksView action confirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusState.watchingTaskIds = new Set(['task-1']);
    statusState.queuedTaskIds = new Set();
    statusState.syncingTaskIds = new Set();
    statusState.statuses = new Map();
    listenMock.mockResolvedValue(() => {});
    openMock.mockResolvedValue(null);
    askMock.mockResolvedValue(true);
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
        };
      }
      if (command === 'sync_dry_run') {
        return {
          diffs: [],
          total_files: 0,
          files_to_copy: 0,
          files_modified: 0,
          bytes_to_copy: 0,
        };
      }
      return undefined;
    });
  });

  it('does not execute dry-run when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
    ).toBe(false);
  });

  it('does not execute sync when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.startSync')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.startSync'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'start_sync'),
    ).toBe(false);
  });

  it('does not toggle watch off when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.watchToggleOff')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.watchToggleOff'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
