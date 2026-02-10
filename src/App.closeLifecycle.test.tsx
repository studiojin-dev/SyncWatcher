import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
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

const eventHandlers = new Map<string, () => unknown>();

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

vi.mock('./components/ui/Animations', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
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
    deleteMissing: false,
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

async function emitEvent(eventName: string) {
  const handler = eventHandlers.get(eventName);
  if (!handler) {
    throw new Error(`Event handler not registered: ${eventName}`);
  }

  await act(async () => {
    await handler();
  });
}

describe('App close lifecycle', () => {
  beforeEach(() => {
    runtimeState.settingsLoaded = true;
    runtimeState.tasksLoaded = true;
    runtimeState.setsLoaded = true;
    runtimeState.closeAction = 'quit';
    runtimeState.notifications = true;
    runtimeState.tasks = [];

    eventHandlers.clear();

    listenMock.mockImplementation(async (eventName: string, handler: () => unknown) => {
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
        };
      }

      return undefined;
    });

    askMock.mockResolvedValue(true);
  });

  it('shows confirmation and quits when runtime state lookup fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'runtime_get_state') {
        throw new Error('runtime unavailable');
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested');

    expect(askMock).toHaveBeenCalledWith('app.quitConfirmMessageStateUnknown', {
      title: 'app.quitConfirmTitle',
      kind: 'warning',
    });
    expect(invokeMock).toHaveBeenCalledWith('quit_app');
  });

  it('cancels quit when user rejects runtime-unknown confirmation', async () => {
    askMock.mockResolvedValue(false);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'runtime_get_state') {
        throw new Error('runtime unavailable');
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested');

    expect(askMock).toHaveBeenCalledTimes(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('queues close-requested until lifecycle is ready and then applies closeAction', async () => {
    runtimeState.settingsLoaded = false;
    runtimeState.tasksLoaded = false;
    runtimeState.closeAction = 'background';

    const view = render(<App />);

    await waitFor(() => {
      expect(eventHandlers.has('close-requested')).toBe(true);
    });

    await emitEvent('close-requested');

    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);

    runtimeState.settingsLoaded = true;
    runtimeState.tasksLoaded = true;

    view.rerender(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
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

  it('prevents duplicate confirmation dialogs on repeated close events', async () => {
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
      const firstCall = closeHandler();
      const secondCall = closeHandler();

      await Promise.resolve();
      expect(askMock).toHaveBeenCalledTimes(1);

      askDeferred.resolve(true);
      await Promise.all([firstCall, secondCall]);
    });

    expect(invokeMock).toHaveBeenCalledWith('quit_app');
    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
    ).toHaveLength(1);
  });
});
