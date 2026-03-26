import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, open } from '@tauri-apps/plugin-dialog';
import SyncTasksView from './SyncTasksView';

const {
  updateTaskMock,
  deleteTaskMock,
  addTaskMock,
  showToastMock,
  statusState,
  useSyncTaskStatusStoreMock,
} = vi.hoisted(() => {
  const updateTaskMock = vi.fn();
  const deleteTaskMock = vi.fn();
  const addTaskMock = vi.fn();
  const showToastMock = vi.fn();
  const statusState = {
    statuses: new Map(),
    watchingTaskIds: new Set<string>(['task-1']),
    queuedTaskIds: new Set<string>(),
    syncingTaskIds: new Set<string>(),
    dryRunningTaskIds: new Set<string>(),
    dryRunSessions: new Map<string, unknown>(),
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
    updateTaskMock,
    deleteTaskMock,
    addTaskMock,
    showToastMock,
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
const openMock = open as unknown as ReturnType<typeof vi.fn>;

describe('SyncTasksView action confirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusState.watchingTaskIds = new Set(['task-1']);
    statusState.queuedTaskIds = new Set();
    statusState.syncingTaskIds = new Set();
    statusState.dryRunningTaskIds = new Set();
    statusState.dryRunSessions = new Map();
    statusState.statuses = new Map();
    statusState.setLastLog.mockReset();
    statusState.setDryRunning.mockReset();
    statusState.beginDryRunSession.mockReset();
    statusState.completeDryRunSession.mockReset();
    statusState.failDryRunSession.mockReset();
    statusState.clearDryRunSession.mockReset();
    statusState.clearDryRunSession.mockImplementation((taskId: string) => {
      statusState.dryRunSessions.delete(taskId);
    });
    showToastMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    openMock.mockResolvedValue(null);
    askMock.mockResolvedValue(true);
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
  });

  it('does not execute dry-run when confirmation is rejected', async () => {
    askMock.mockResolvedValueOnce(false);
    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

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

  it('reopens an existing dry-run session instead of starting a new run', async () => {
    statusState.dryRunSessions = new Map([
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

    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

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

    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

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

    render(
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

  it('keeps the cancel modal path when dry-run is active without a local session', async () => {
    statusState.statuses = new Map([
      ['task-1', { taskId: 'task-1', status: 'dryRunning' }],
    ]);

    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('common.cancel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('common.cancel'));

    expect(askMock).not.toHaveBeenCalled();
    expect(
      screen.getByText('syncTasks.cancelDryRun', { exact: false }),
    ).toBeInTheDocument();
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
    expect(invokeMock.mock.calls.some((call) => call[0] === 'start_sync')).toBe(
      false,
    );
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

    render(<SyncTasksView />);

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

  it('starts a new dry-run from the result view retry action', async () => {
    statusState.dryRunSessions = new Map([
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

    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));
    fireEvent.click(screen.getByText('common.retry'));

    await waitFor(() => {
      expect(askMock).toHaveBeenCalled();
    });
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'sync_dry_run'),
    ).toBe(true);
  });

  it('shows a warning toast when dry-run target directory will be created later', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'sync_dry_run') {
        return {
          diffs: [],
          total_files: 0,
          files_to_copy: 0,
          files_modified: 0,
          bytes_to_copy: 0,
          targetPreflight: {
            kind: 'willCreateDirectory',
            path: '/tmp/missing-target',
          },
        };
      }
      return undefined;
    });

    render(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getByTitle('syncTasks.dryRun')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('syncTasks.dryRun'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        'syncTasks.targetDirectoryWillBeCreated',
        'warning',
      );
    });
  });

  it('opens a validation modal instead of an error toast when save validation fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'runtime_validate_tasks') {
        return {
          ok: false,
          issue: {
            code: 'duplicateTarget',
            taskId: 'task-1',
            taskName: 'Task 1',
            conflictingTaskIds: ['task-2'],
            conflictingTaskNames: ['Task 2'],
            source: null,
            target: '/tmp/target',
          },
        };
      }
      return undefined;
    });

    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText('EDIT'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    expect(await screen.findByText('syncTasks.validationModal.title')).toBeInTheDocument();
    expect(screen.getByText('syncTasks.errors.duplicateTarget')).toBeInTheDocument();
    expect(screen.getByText('Task 2')).toBeInTheDocument();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalledWith(
      'syncTasks.errors.duplicateTarget',
      'error',
    );
    expect(statusState.setLastLog).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        message: 'syncTasks.errors.duplicateTarget',
        level: 'error',
      }),
    );
  });

  it('renders task id fallbacks in the validation modal when some conflicting names are missing', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'runtime_validate_tasks') {
        return {
          ok: false,
          issue: {
            code: 'watchCycle',
            taskId: 'task-1',
            taskName: 'Task 1',
            conflictingTaskIds: ['task-2', 'task-3'],
            conflictingTaskNames: ['Task 2'],
            source: null,
            target: null,
          },
        };
      }
      return undefined;
    });

    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText('EDIT'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    expect(await screen.findByText('syncTasks.validationModal.title')).toBeInTheDocument();
    expect(screen.getAllByText('Task 1').length).toBeGreaterThan(0);
    expect(screen.getByText('Task 2')).toBeInTheDocument();
    expect(screen.getByText('task-3')).toBeInTheDocument();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('opens a validation modal for new tasks without writing a provisional lastLog', async () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');
    try {
      invokeMock.mockImplementation(async (command: string) => {
        if (command === 'list_conflict_review_sessions') {
          return [];
        }
        if (command === 'get_removable_volumes') {
          return [];
        }
        if (command === 'runtime_validate_tasks') {
          return {
            ok: false,
            issue: {
              code: 'duplicateTarget',
              taskId: '11111111-1111-4111-8111-111111111111',
              taskName: 'Draft Task',
              conflictingTaskIds: ['task-1'],
              conflictingTaskNames: ['Task 1'],
              source: '/tmp/source',
              target: '/tmp/target',
            },
          };
        }
        return undefined;
      });

      render(
        <MantineProvider>
          <SyncTasksView />
        </MantineProvider>,
      );

      fireEvent.click(screen.getByText('syncTasks.addTask'));
      fireEvent.click(screen.getAllByRole('radio')[0]);
      fireEvent.change(screen.getByPlaceholderText('MY_BACKUP_TASK'), {
        target: { value: 'Draft Task' },
      });
      fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
        target: { value: '/tmp/source' },
      });
      fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
        target: { value: '/tmp/target' },
      });
      fireEvent.click(screen.getByText('syncTasks.save'));

      expect(await screen.findByText('syncTasks.validationModal.title')).toBeInTheDocument();
      expect(screen.getAllByText('Task 1').length).toBeGreaterThan(0);
      expect(addTaskMock).not.toHaveBeenCalled();
      expect(statusState.setLastLog).not.toHaveBeenCalled();
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('saves an edited task after successful validation and shows a success toast', async () => {
    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText('EDIT'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('MY_BACKUP_TASK'), {
      target: { value: 'Task 1 Updated' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/updated-target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          name: 'Task 1 Updated',
          source: '/tmp/source',
          target: '/tmp/updated-target',
        }),
      );
    });
    expect(showToastMock).toHaveBeenCalledWith(
      'syncTasks.editTask: Task 1 Updated',
      'success',
    );
    expect(screen.queryByText('syncTasks.validationModal.title')).not.toBeInTheDocument();
  });

  it('creates a new task after successful validation and shows a success toast', async () => {
    render(
      <MantineProvider>
        <SyncTasksView />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText('syncTasks.addTask'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('MY_BACKUP_TASK'), {
      target: { value: 'New Task' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/new-source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/new-target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    await waitFor(() => {
      expect(addTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Task',
          source: '/tmp/new-source',
          target: '/tmp/new-target',
        }),
      );
    });
    expect(showToastMock).toHaveBeenCalledWith(
      'syncTasks.addTask: New Task',
      'success',
    );
    expect(screen.queryByText('syncTasks.validationModal.title')).not.toBeInTheDocument();
  });
});
