import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, message } from '@tauri-apps/plugin-dialog';
import type { ReactNode } from 'react';
import type { SyncTask } from './hooks/useSyncTasks';
import App from './App';

interface MockRuntimeState {
  settingsLoaded: boolean;
  tasksLoaded: boolean;
  setsLoaded: boolean;
  closeAction: 'quit' | 'background';
  notifications: boolean;
  tasks: SyncTask[];
}

const runtimeState: MockRuntimeState = {
  settingsLoaded: true,
  tasksLoaded: true,
  setsLoaded: true,
  closeAction: 'quit',
  notifications: true,
  tasks: [],
};

const eventHandlers = new Map<string, (event?: { payload?: unknown }) => unknown>();
const { setLastLogMock, setQueuedMock } = vi.hoisted(() => ({
  setLastLogMock: vi.fn(),
  setQueuedMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    label: 'main',
    isVisible: vi.fn().mockResolvedValue(true),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
  message: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      language: 'en',
      theme: 'system',
      dataUnitSystem: 'binary',
      notifications: runtimeState.notifications,
      stateLocation: '',
      maxLogLines: 10000,
      closeAction: runtimeState.closeAction,
    },
    loaded: runtimeState.settingsLoaded,
    updateSettings: vi.fn(),
    resetSettings: vi.fn(),
  }),
}));

vi.mock('./hooks/useSyncTaskStatus', () => ({
  useSyncTaskStatusStore: {
    getState: () => ({
      setLastLog: setLastLogMock,
      setQueued: setQueuedMock,
    }),
  },
}));

vi.mock('./context/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./context/SyncTasksContext', () => ({
  useSyncTasksContext: () => ({
    tasks: runtimeState.tasks,
    loaded: runtimeState.tasksLoaded,
    addTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    error: null,
    reload: vi.fn(),
  }),
  SyncTasksProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./context/ExclusionSetsContext', () => ({
  useExclusionSetsContext: () => ({
    sets: [],
    loaded: runtimeState.setsLoaded,
    addSet: vi.fn(),
    updateSet: vi.fn(),
    deleteSet: vi.fn(),
    resetSets: vi.fn(),
    getPatternsForSets: vi.fn(),
    error: null,
    reload: vi.fn(),
  }),
  ExclusionSetsProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./components/layout/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./components/runtime/BackendRuntimeBridge', () => ({
  default: () => null,
}));

vi.mock('./components/ui/AutoUnmountConfirmModal', () => ({
  default: ({
    opened,
    onConfirm,
    onCancel,
  }: {
    opened: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (opened ? (
    <>
      <button type="button" onClick={onConfirm}>confirm-auto-unmount</button>
      <button type="button" onClick={onCancel}>cancel-auto-unmount</button>
    </>
  ) : null),
}));

vi.mock('./components/features/UpdateChecker', () => ({
  default: () => null,
}));

vi.mock('./components/ui/Animations', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
  CardAnimation: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./components/ui/StartupProgressOverlay', () => ({
  default: () => null,
}));

vi.mock('./components/ui/Toast', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./components/ui/ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./views/SyncTasksView', () => ({
  default: () => <div>sync-tasks</div>,
}));

function createTask(overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    id: 'task-1',
    name: 'Task',
    source: '/src',
    target: '/dst',
    checksumMode: false,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const askMock = ask as unknown as ReturnType<typeof vi.fn>;
const messageMock = message as unknown as ReturnType<typeof vi.fn>;

async function emitEvent(eventName: string, payload?: unknown) {
  const handler = eventHandlers.get(eventName);
  if (!handler) {
    throw new Error(`Event handler not registered: ${eventName}`);
  }

  await act(async () => {
    await handler({ payload });
  });
}

describe('App close lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    setLastLogMock.mockReset();
    setQueuedMock.mockReset();
    runtimeState.settingsLoaded = true;
    runtimeState.tasksLoaded = true;
    runtimeState.setsLoaded = true;
    runtimeState.closeAction = 'quit';
    runtimeState.notifications = true;
    runtimeState.tasks = [];

    eventHandlers.clear();

    listenMock.mockImplementation(async (eventName: string, handler: (event?: { payload?: unknown }) => unknown) => {
      eventHandlers.set(eventName, handler);
      return () => {
        if (eventHandlers.get(eventName) === handler) {
          eventHandlers.delete(eventName);
        }
      };
    });

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }

      return undefined;
    });

    askMock.mockResolvedValue(true);
    messageMock.mockResolvedValue('Cancel');
  });

  it('keeps window-close background behavior without cmd+q prompt', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested', { source: 'window-close' });

    expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('runs background path when cmd+q chooses background under background mode', async () => {
    runtimeState.closeAction = 'background';
    messageMock.mockResolvedValue('app.cmdQuitBackgroundOption');

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested', { source: 'cmd-quit' });

    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('prioritizes cmd+q over concurrent window-close in background mode (background option)', async () => {
    runtimeState.closeAction = 'background';
    messageMock.mockResolvedValue('app.cmdQuitBackgroundOption');

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    const closeHandler = eventHandlers.get('close-requested');
    if (!closeHandler) {
      throw new Error('close-requested handler not found');
    }

    await act(async () => {
      const windowClose = closeHandler({ payload: { source: 'window-close' } });
      const cmdQuit = closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.all([windowClose, cmdQuit]);
    });

    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'hide_to_background'),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('prioritizes cmd+q over concurrent window-close in background mode (full quit option)', async () => {
    runtimeState.closeAction = 'background';
    messageMock.mockResolvedValue('app.cmdQuitFullQuitOption');

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    const closeHandler = eventHandlers.get('close-requested');
    if (!closeHandler) {
      throw new Error('close-requested handler not found');
    }

    await act(async () => {
      const windowClose = closeHandler({ payload: { source: 'window-close' } });
      const cmdQuit = closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.all([windowClose, cmdQuit]);
    });

    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('runs full quit path when cmd+q chooses quit under background mode', async () => {
    runtimeState.closeAction = 'background';
    messageMock.mockResolvedValue('app.cmdQuitFullQuitOption');

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested', { source: 'cmd-quit' });

    expect(invokeMock).toHaveBeenCalledWith('quit_app');
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('cancels when cmd+q dialog chooses cancel under background mode', async () => {
    runtimeState.closeAction = 'background';
    messageMock.mockResolvedValue('Cancel');

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested', { source: 'cmd-quit' });

    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('auto-quits after 10 seconds when cmd+q in quit mode has no response', async () => {
    runtimeState.closeAction = 'quit';
    const askDeferred = createDeferred<boolean>();
    askMock.mockReturnValueOnce(askDeferred.promise);

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    vi.useFakeTimers();
    const emitPromise = emitEvent('close-requested', { source: 'cmd-quit' });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    await emitPromise;

    expect(invokeMock).toHaveBeenCalledWith('quit_app');
  });

  it('does not quit when cmd+q in quit mode is cancelled before timeout', async () => {
    runtimeState.closeAction = 'quit';
    askMock.mockResolvedValue(false);

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    vi.useFakeTimers();
    await emitEvent('close-requested', { source: 'cmd-quit' });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('forces quit path for tray-quit even when closeAction is background', async () => {
    runtimeState.settingsLoaded = false;
    runtimeState.tasksLoaded = false;
    runtimeState.closeAction = 'background';

    const view = render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('tray-quit-requested')).toBe(true);
    });

    await emitEvent('tray-quit-requested');

    runtimeState.settingsLoaded = true;
    runtimeState.tasksLoaded = true;

    view.rerender(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('quit_app');
    });
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('prevents duplicate dialogs on repeated cmd+q close events', async () => {
    runtimeState.closeAction = 'quit';
    runtimeState.tasks = [createTask({ watchMode: true })];
    const askDeferred = createDeferred<boolean>();
    askMock.mockReturnValueOnce(askDeferred.promise);

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    const closeHandler = eventHandlers.get('close-requested');
    if (!closeHandler) {
      throw new Error('close-requested handler not found');
    }

    await act(async () => {
      const firstCall = closeHandler({ payload: { source: 'cmd-quit' } });
      const secondCall = closeHandler({ payload: { source: 'cmd-quit' } });

      await Promise.resolve();
      expect(askMock).toHaveBeenCalledTimes(1);

      askDeferred.resolve(true);
      await Promise.all([firstCall, secondCall]);
    });

    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
    ).toHaveLength(1);
  });

  it('updates pending status when runtime auto-unmount confirmation is requested', async () => {
    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-auto-unmount-request')).toBe(true);
    });

    await emitEvent('runtime-auto-unmount-request', {
      taskId: 'task-1',
      taskName: 'Task 1',
      source: '/Volumes/CARD',
      filesCopied: 0,
      bytesCopied: 0,
      reason: 'zero-copy',
    });

    expect(setLastLogMock).toHaveBeenCalledWith('task-1', expect.objectContaining({
      message: 'syncTasks.autoUnmountPendingStatus',
      level: 'warning',
    }));
  });

  it('disables auto-unmount for this session when user cancels confirmation', async () => {
    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('runtime-auto-unmount-request')).toBe(true);
    });

    await emitEvent('runtime-auto-unmount-request', {
      taskId: 'task-1',
      taskName: 'Task 1',
      source: '/Volumes/CARD',
      filesCopied: 0,
      bytesCopied: 0,
      reason: 'zero-copy',
    });

    await waitFor(() => {
      expect(screen.getByText('cancel-auto-unmount')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('cancel-auto-unmount'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_auto_unmount_session_disabled', {
        taskId: 'task-1',
        disabled: true,
      });
    });

    expect(setLastLogMock).toHaveBeenCalledWith('task-1', expect.objectContaining({
      message: 'syncTasks.autoUnmountCancelledStatus',
      level: 'warning',
    }));
    expect(setQueuedMock).toHaveBeenCalledWith('task-1', false);
  });
});
