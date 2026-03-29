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
      return { ok: true, issue: null };
    }
    if (command === 'runtime_validate_orphan_scan') {
      return { ok: true, issue: null };
    }
    return undefined;
  });
}

describe('SyncTasksView validation and orphan scan flows', () => {
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
    listenMock.mockResolvedValue(() => {});
    askMock.mockResolvedValue(true);
    installDefaultInvokeMock();
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

    renderWithMantine(<SyncTasksView />);

    fireEvent.click(screen.getByText('EDIT'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    expect(
      await screen.findByText('syncTasks.validationModal.title'),
    ).toBeInTheDocument();
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

  it('shows the validation modal and blocks orphan scan for duplicate targets', async () => {
    syncTasksState.tasks = [
      {
        id: 'task-1',
        name: 'Task 1',
        source: '/tmp/source-1',
        target: '/tmp/shared-target',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
      {
        id: 'task-2',
        name: 'Task 2',
        source: '/tmp/source-2',
        target: '/tmp/shared-target',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
    ];

    invokeMock.mockImplementation(async (command: string, payload?: { taskId?: string }) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'runtime_validate_tasks') {
        return { ok: true, issue: null };
      }
      if (command === 'runtime_validate_orphan_scan' && payload?.taskId === 'task-1') {
        return {
          ok: false,
          issue: {
            code: 'duplicateTarget',
            taskId: 'task-1',
            taskName: 'Task 1',
            conflictingTaskIds: ['task-2'],
            conflictingTaskNames: ['Task 2'],
            source: null,
            target: '/tmp/shared-target',
          },
        };
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getAllByTitle('orphan.title')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByTitle('orphan.title')[0]);

    expect(
      await screen.findByText('syncTasks.validationModal.title'),
    ).toBeInTheDocument();
    expect(screen.getByText('syncTasks.errors.duplicateTarget')).toBeInTheDocument();
    expect(screen.getAllByText('Task 2').length).toBeGreaterThan(0);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'find_orphan_files'),
    ).toBe(false);
  });

  it('shows the validation modal and blocks orphan scan for nested targets', async () => {
    syncTasksState.tasks = [
      {
        id: 'task-1',
        name: 'Task 1',
        source: '/tmp/source-1',
        target: '/tmp/root-target/child',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
      {
        id: 'task-2',
        name: 'Task 2',
        source: '/tmp/source-2',
        target: '/tmp/root-target',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
    ];

    invokeMock.mockImplementation(async (command: string, payload?: { taskId?: string }) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'runtime_validate_tasks') {
        return { ok: true, issue: null };
      }
      if (command === 'runtime_validate_orphan_scan' && payload?.taskId === 'task-1') {
        return {
          ok: false,
          issue: {
            code: 'targetSubdirConflict',
            taskId: 'task-1',
            taskName: 'Task 1',
            conflictingTaskIds: ['task-2'],
            conflictingTaskNames: ['Task 2'],
            source: null,
            target: '/tmp/root-target/child',
          },
        };
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getAllByTitle('orphan.title')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByTitle('orphan.title')[0]);

    expect(
      await screen.findByText('syncTasks.validationModal.title'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('syncTasks.errors.targetSubdirConflict'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Task 2').length).toBeGreaterThan(0);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'find_orphan_files'),
    ).toBe(false);
  });

  it('still opens orphan scan for an unrelated valid task when other tasks conflict', async () => {
    syncTasksState.tasks = [
      {
        id: 'task-1',
        name: 'Task 1',
        source: '/tmp/source-1',
        target: '/tmp/conflict-root',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
      {
        id: 'task-2',
        name: 'Task 2',
        source: '/tmp/source-2',
        target: '/tmp/conflict-root/child',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
      {
        id: 'task-3',
        name: 'Task 3',
        source: '/tmp/source-3',
        target: '/tmp/isolated-target',
        checksumMode: false,
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      },
    ];

    invokeMock.mockImplementation(async (command: string, payload?: { taskId?: string }) => {
      if (command === 'list_conflict_review_sessions') {
        return [];
      }
      if (command === 'get_removable_volumes') {
        return [];
      }
      if (command === 'runtime_validate_tasks') {
        return { ok: true, issue: null };
      }
      if (command === 'runtime_validate_orphan_scan' && payload?.taskId === 'task-3') {
        return { ok: true, issue: null };
      }
      if (command === 'find_orphan_files') {
        return [];
      }
      return undefined;
    });

    renderWithMantine(<SyncTasksView />);

    await waitFor(() => {
      expect(screen.getAllByTitle('orphan.title')).toHaveLength(3);
    });

    fireEvent.click(screen.getAllByTitle('orphan.title')[2]);

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some((call) => call[0] === 'find_orphan_files'),
      ).toBe(true);
    });
    expect(
      screen.queryByText('syncTasks.validationModal.title'),
    ).not.toBeInTheDocument();
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

    renderWithMantine(<SyncTasksView />);

    fireEvent.click(screen.getByText('EDIT'));
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.change(screen.getByPlaceholderText('/path/to/source'), {
      target: { value: '/tmp/source' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/target'), {
      target: { value: '/tmp/target' },
    });
    fireEvent.click(screen.getByText('syncTasks.save'));

    expect(
      await screen.findByText('syncTasks.validationModal.title'),
    ).toBeInTheDocument();
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

      renderWithMantine(<SyncTasksView />);

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

      expect(
        await screen.findByText('syncTasks.validationModal.title'),
      ).toBeInTheDocument();
      expect(screen.getAllByText('Task 1').length).toBeGreaterThan(0);
      expect(addTaskMock).not.toHaveBeenCalled();
      expect(statusState.setLastLog).not.toHaveBeenCalled();
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('saves an edited task after successful validation and shows a success toast', async () => {
    renderWithMantine(<SyncTasksView />);

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
    expect(
      screen.queryByText('syncTasks.validationModal.title'),
    ).not.toBeInTheDocument();
  });

  it('creates a new task after successful validation and shows a success toast', async () => {
    renderWithMantine(<SyncTasksView />);

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
    expect(
      screen.queryByText('syncTasks.validationModal.title'),
    ).not.toBeInTheDocument();
  });
});
