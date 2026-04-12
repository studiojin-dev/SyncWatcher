import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ReactNode } from 'react';
import type { SyncTask } from './hooks/useSyncTasks';
import App from './App';
import type { DistributionInfo } from './context/DistributionContext';

interface MockRuntimeState {
  settingsLoaded: boolean;
  tasksLoaded: boolean;
  setsLoaded: boolean;
  closeAction: 'quit' | 'background';
  notifications: boolean;
  isRegistered: boolean;
  tasks: SyncTask[];
}

const runtimeState: MockRuntimeState = {
  settingsLoaded: true,
  tasksLoaded: true,
  setsLoaded: true,
  closeAction: 'quit',
  notifications: true,
  isRegistered: false,
  tasks: [],
};

const eventHandlers = new Map<string, (event?: { payload?: unknown }) => unknown>();
const {
  distributionState,
  reloadDistributionMock,
  resolveDistributionMock,
  setLastLogMock,
  setQueuedMock,
  setLaunchAtLoginMock,
  updateSettingsMock,
  updateCheckerPropsMock,
} = vi.hoisted(() => ({
  distributionState: {
    loaded: true,
    info: {
      channel: 'github' as const,
      purchaseProvider: 'lemon_squeezy' as const,
      canSelfUpdate: true,
      appStoreAppId: null,
      appStoreCountry: 'us',
      appStoreUrl: null,
      legacyImportAvailable: false,
    } as DistributionInfo,
  },
  reloadDistributionMock: vi.fn(),
  resolveDistributionMock: vi.fn(async () => distributionState.info),
  setLastLogMock: vi.fn(),
  setQueuedMock: vi.fn(),
  setLaunchAtLoginMock: vi.fn(),
  updateSettingsMock: vi.fn(),
  updateCheckerPropsMock: vi.fn(),
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
      isRegistered: runtimeState.isRegistered,
      launchAtLogin: false,
    },
    loaded: runtimeState.settingsLoaded,
    updateSettings: updateSettingsMock,
    setLaunchAtLogin: setLaunchAtLoginMock,
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

vi.mock('./context/DistributionContext', () => ({
  DistributionProvider: ({ children }: { children: ReactNode }) => children,
  useDistribution: () => ({
    info: distributionState.info,
    loaded: distributionState.loaded,
    reload: reloadDistributionMock,
    resolve: resolveDistributionMock,
  }),
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

vi.mock('./components/runtime/SyncTaskSourceRecommendationBridge', () => ({
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
  default: (props: { autoCheckEnabled: boolean; manualCheckRequestNonce: number }) => {
    updateCheckerPropsMock(props);
    return <div data-testid="update-checker">{props.manualCheckRequestNonce}</div>;
  },
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
  useToast: () => ({
    showToast: vi.fn(),
  }),
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

function getRegisteredHandlerIfPresent(eventName: string) {
  const handlerFromMap = eventHandlers.get(eventName);
  if (handlerFromMap) {
    return handlerFromMap;
  }

  const matchingCall = [...listenMock.mock.calls]
    .reverse()
    .find(([registeredEventName]) => registeredEventName === eventName);

  return matchingCall?.[1] as
    | ((event?: { payload?: unknown }) => unknown)
    | undefined;
}

async function waitForRegisteredHandler(eventName: string) {
  await waitFor(() => {
    expect(getRegisteredHandlerIfPresent(eventName)).toBeDefined();
  });

  const handler = getRegisteredHandlerIfPresent(eventName);
  if (!handler) {
    throw new Error(`Event handler not registered: ${eventName}`);
  }

  return handler;
}

async function emitEvent(eventName: string, payload?: unknown) {
  const handler = await waitForRegisteredHandler(eventName);

  await act(async () => {
    await handler({ payload });
  });
}

async function startEvent(eventName: string, payload?: unknown) {
  const handler = await waitForRegisteredHandler(eventName);
  return handler({ payload });
}

async function flushAppEffects() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
  });
}

describe('App close lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    reloadDistributionMock.mockReset();
    resolveDistributionMock.mockReset();
    resolveDistributionMock.mockResolvedValue({
      channel: 'github',
      purchaseProvider: 'lemon_squeezy',
      canSelfUpdate: true,
      appStoreAppId: null,
      appStoreCountry: 'us',
      appStoreUrl: null,
      legacyImportAvailable: false,
    });
    setLastLogMock.mockReset();
    setQueuedMock.mockReset();
    setLaunchAtLoginMock.mockReset();
    updateCheckerPropsMock.mockReset();
    setLaunchAtLoginMock.mockResolvedValue(true);
    runtimeState.settingsLoaded = true;
    runtimeState.tasksLoaded = true;
    runtimeState.setsLoaded = true;
    runtimeState.closeAction = 'quit';
    runtimeState.notifications = true;
    runtimeState.isRegistered = false;
    runtimeState.tasks = [];
    distributionState.loaded = true;
    distributionState.info = {
      channel: 'github',
      purchaseProvider: 'lemon_squeezy',
      canSelfUpdate: true,
      appStoreAppId: null,
      appStoreCountry: 'us',
      appStoreUrl: null,
      legacyImportAvailable: false,
    };
    localStorage.clear();
    localStorage.setItem('syncwatcher_bg_intro_shown', '1');

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
      if (command === 'refresh_supporter_status') {
        return {
          isRegistered: runtimeState.isRegistered,
          provider: 'lemon_squeezy',
        };
      }
      if (command === 'get_supporter_status') {
        return {
          isRegistered: runtimeState.isRegistered,
          provider: 'lemon_squeezy',
        };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    updateSettingsMock.mockReset();
  });

  it('refreshes supporter status on startup', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('sync-tasks')).toBeInTheDocument();
    });

    expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
  });

  it('shows the hidden owner license debug modal only when the guarded command succeeds', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_owner_license_debug_snapshot') {
        return {
          appSupportDir: '/Users/test/Library/Application Support/dev.studiojin.syncwatcher',
          markerPath: '/Users/test/Library/Application Support/dev.studiojin.syncwatcher/.owner-license-debug',
          licenseStatePath: '/Users/test/Library/Application Support/dev.studiojin.syncwatcher/license_state.json',
          distribution: {
            channel: 'github',
            purchaseProvider: 'lemon_squeezy',
            canSelfUpdate: true,
            appStoreAppId: null,
            appStoreCountry: 'us',
            appStoreUrl: null,
            legacyImportAvailable: false,
          },
          cachedSupporterStatus: {
            isRegistered: true,
            provider: 'lemon_squeezy',
          },
          cachedLicenseStatus: {
            isRegistered: true,
            licenseKey: 'abcd…1234',
          },
          cachedLicenseState: {
            licenseKey: 'abcd1234',
            instanceId: 'instance-1',
            validatedAt: '2026-04-06T00:00:00Z',
            isValid: true,
          },
          refreshSupporterStatus: {
            ok: true,
            status: {
              isRegistered: true,
              provider: 'lemon_squeezy',
            },
            error: null,
          },
        };
      }
      if (command === 'refresh_supporter_status') {
        return {
          isRegistered: runtimeState.isRegistered,
          provider: 'lemon_squeezy',
        };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    render(<App />);

    expect(await screen.findByTestId('owner-license-debug-modal')).toBeInTheDocument();
    expect(screen.getByText('Owner License Debug')).toBeInTheDocument();
    expect(screen.getByText(/instance-1/)).toBeInTheDocument();
  });

  it('keeps registered state while startup supporter refresh is pending or succeeds', async () => {
    runtimeState.isRegistered = true;
    const deferred = createDeferred<{
      isRegistered: boolean;
      provider: 'lemon_squeezy' | 'app_store';
    }>();

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        return deferred.promise;
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
    });

    expect(updateSettingsMock).not.toHaveBeenCalledWith({ isRegistered: false });

    deferred.resolve({ isRegistered: true, provider: 'lemon_squeezy' });

    await waitFor(() => {
      expect(updateSettingsMock).not.toHaveBeenCalledWith({ isRegistered: false });
    });
  });

  it('keeps registered state when startup supporter refresh throws', async () => {
    runtimeState.isRegistered = true;

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        throw new Error('network down');
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
    });
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        '[App] Supporter status refresh failed:',
        expect.any(Error),
      );
    });
    expect(updateSettingsMock).not.toHaveBeenCalledWith({ isRegistered: false });

    consoleError.mockRestore();
  });

  it('falls back to locally cached supporter status when startup refresh throws', async () => {
    runtimeState.isRegistered = false;

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        throw new Error('network down');
      }
      if (command === 'get_supporter_status') {
        return {
          isRegistered: true,
          provider: 'lemon_squeezy',
        };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_supporter_status');
    });
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: true });
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[App] Supporter status refresh failed:',
      expect.any(Error),
    );

    consoleError.mockRestore();
  });

  it('falls back to App Store supporter status when startup refresh throws on App Store builds', async () => {
    distributionState.info = {
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreCountry: 'us',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
      legacyImportAvailable: false,
    };
    resolveDistributionMock.mockResolvedValue(distributionState.info);
    runtimeState.isRegistered = false;

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        throw new Error('storekit bridge busy');
      }
      if (command === 'get_supporter_status') {
        return {
          isRegistered: true,
          provider: 'app_store',
        };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_supporter_status');
    });
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: true });
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[App] Supporter status refresh failed:',
      expect.any(Error),
    );

    consoleError.mockRestore();
  });

  it('restores locally cached supporter status when startup refresh returns inactive', async () => {
    runtimeState.isRegistered = false;

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        return { isRegistered: false, provider: 'lemon_squeezy' };
      }
      if (command === 'get_supporter_status') {
        return {
          isRegistered: true,
          provider: 'lemon_squeezy',
        };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('refresh_supporter_status');
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_supporter_status');
    });
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: true });
    });
  });

  it('marks the app unregistered when startup supporter refresh returns inactive', async () => {
    runtimeState.isRegistered = true;

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_supporter_status') {
        return { isRegistered: false, provider: 'lemon_squeezy' };
      }
      if (command === 'get_supporter_status') {
        return { isRegistered: false, provider: 'lemon_squeezy' };
      }
      if (command === 'runtime_get_state') {
        return {
          watchingTasks: [],
          syncingTasks: [],
          queuedTasks: [],
        };
      }
      if (command === 'find_sync_task_source_recommendations') {
        return {
          recommendations: [],
        };
      }

      return undefined;
    });

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_supporter_status');
    });
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: false });
    });
  });

  it('shows the first-run intro modal only when no intro keys exist', async () => {
    localStorage.clear();

    render(<App />);

    expect(screen.getByText('app.firstRunIntroTitle')).toBeInTheDocument();
    expect(screen.queryByText('app.backgroundIntroMessage')).not.toBeInTheDocument();
  });

  it('does not show the first-run intro modal when the legacy intro key exists', async () => {
    render(<App />);

    expect(screen.queryByText('app.firstRunIntroTitle')).not.toBeInTheDocument();
  });

  it('persists intro dismissal when the user chooses maybe later', async () => {
    localStorage.clear();

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'app.firstRunIntroLater' }));

    await waitFor(() => {
      expect(screen.queryByText('app.firstRunIntroTitle')).not.toBeInTheDocument();
    });
    expect(localStorage.getItem('syncwatcher_first_run_intro_seen')).toBe('1');
    expect(localStorage.getItem('syncwatcher_bg_intro_shown')).toBe('1');
  });

  it('enables launch at login from the first-run intro before dismissing', async () => {
    localStorage.clear();

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'app.firstRunIntroEnable' }));

    await waitFor(() => {
      expect(setLaunchAtLoginMock).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('app.firstRunIntroTitle')).not.toBeInTheDocument();
    });
    expect(localStorage.getItem('syncwatcher_first_run_intro_seen')).toBe('1');
    expect(localStorage.getItem('syncwatcher_bg_intro_shown')).toBe('1');
  });

  it('keeps window-close background behavior without cmd+q prompt', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    await emitEvent('close-requested', { source: 'window-close' });

    expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
    expect(screen.queryByText('app.quitConfirmTitle')).not.toBeInTheDocument();
  });

  it('runs background path when cmd+q chooses background under background mode', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    const eventPromise = startEvent('close-requested', { source: 'cmd-quit' });

    expect(await screen.findByText('app.cmdQuitBackgroundPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app.cmdQuitBackgroundOption' }));
    await eventPromise;

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
    });
    expect(invokeMock).toHaveBeenCalledWith('hide_to_background');
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('prioritizes cmd+q over concurrent window-close in background mode (background option)', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    const closeHandler = await waitForRegisteredHandler('close-requested');

    await act(async () => {
      void closeHandler({ payload: { source: 'window-close' } });
      void closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.resolve();
    });

    expect(await screen.findByText('app.cmdQuitBackgroundPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app.cmdQuitBackgroundOption' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter((call) => call[0] === 'hide_to_background'),
      ).toHaveLength(1);
    });
    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'hide_to_background'),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
  });

  it('prioritizes cmd+q over concurrent window-close in background mode (full quit option)', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    const closeHandler = await waitForRegisteredHandler('close-requested');

    await act(async () => {
      void closeHandler({ payload: { source: 'window-close' } });
      void closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.resolve();
    });

    expect(await screen.findByText('app.cmdQuitBackgroundPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app.cmdQuitFullQuitOption' }));

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
      ).toHaveLength(1);
    });
    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('runs full quit path when cmd+q chooses quit under background mode', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    const eventPromise = startEvent('close-requested', { source: 'cmd-quit' });

    expect(await screen.findByText('app.cmdQuitBackgroundPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app.cmdQuitFullQuitOption' }));
    await eventPromise;

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('quit_app');
    });
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('cancels when cmd+q dialog chooses cancel under background mode', async () => {
    runtimeState.closeAction = 'background';

    render(<App />);

    await waitFor(() => {
      expect(
        listenMock.mock.calls.some(([eventName]) => eventName === 'close-requested'),
      ).toBe(true);
    });

    const eventPromise = startEvent('close-requested', { source: 'cmd-quit' });

    expect(await screen.findByText('app.cmdQuitBackgroundPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app.cmdQuitCancelOption' }));
    await eventPromise;

    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'quit_app'),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === 'hide_to_background'),
    ).toBe(false);
  });

  it('auto-quits after 10 seconds when cmd+q in quit mode has no response', async () => {
    runtimeState.closeAction = 'quit';

    render(<App />);

    const closeHandler = await waitForRegisteredHandler('close-requested');

    vi.useFakeTimers();
    let emitPromise: unknown;
    await act(async () => {
      emitPromise = closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.resolve();
    });

    expect(screen.getByText('app.cmdQuitPrompt')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    await emitPromise;

    expect(invokeMock).toHaveBeenCalledWith('quit_app');
  });

  it('does not quit when cmd+q in quit mode is cancelled before timeout', async () => {
    runtimeState.closeAction = 'quit';

    render(<App />);

    const closeHandler = await waitForRegisteredHandler('close-requested');

    vi.useFakeTimers();
    let eventPromise: unknown;
    await act(async () => {
      eventPromise = closeHandler({ payload: { source: 'cmd-quit' } });
      await Promise.resolve();
    });

    expect(screen.getByText('app.cmdQuitPrompt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await eventPromise;

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

    await flushAppEffects();

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

  it('forwards app update menu events to UpdateChecker as manual check requests', async () => {
    render(<App />);

    await flushAppEffects();

    expect(await screen.findByTestId('update-checker')).toHaveTextContent('0');

    await emitEvent('app-check-for-updates-requested');

    await waitFor(() => {
      expect(screen.getByTestId('update-checker')).toHaveTextContent('1');
    });

    expect(updateCheckerPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        autoCheckEnabled: false,
        manualCheckRequestNonce: 1,
      }),
    );
  });

  it('prevents duplicate dialogs on repeated cmd+q close events', async () => {
    runtimeState.closeAction = 'quit';
    runtimeState.tasks = [createTask({ watchMode: true })];

    render(<App />);

    await flushAppEffects();

    const firstEvent = startEvent('close-requested', { source: 'cmd-quit' });
    const secondEvent = startEvent('close-requested', { source: 'cmd-quit' });

    expect(await screen.findByText('app.cmdQuitPrompt')).toBeInTheDocument();
    expect(screen.getAllByText('app.cmdQuitPrompt')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
    await Promise.all([firstEvent, secondEvent]);

    expect(
      invokeMock.mock.calls.filter((call) => call[0] === 'quit_app'),
    ).toHaveLength(1);
  });

  it('updates pending status when runtime auto-unmount confirmation is requested', async () => {
    render(<App />);

    await flushAppEffects();

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

    await flushAppEffects();

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
