import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppShell from './components/layout/AppShell';
import { useSettings } from './hooks/useSettings';
import { useSyncTaskStatusStore } from './hooks/useSyncTaskStatus';
import { SettingsProvider } from './context/SettingsContext';
import { useSyncTasksContext, SyncTasksProvider } from './context/SyncTasksContext';
import { useExclusionSetsContext, ExclusionSetsProvider } from './context/ExclusionSetsContext';
import StartupProgressOverlay from './components/ui/StartupProgressOverlay';
import { PageTransition } from './components/ui/Animations';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ui/ErrorBoundary';
import UpdateChecker from './components/features/UpdateChecker';
import AutoUnmountConfirmModal from './components/ui/AutoUnmountConfirmModal';
import BackendRuntimeBridge, { type InitialRuntimeSyncState } from './components/runtime/BackendRuntimeBridge';
import ConflictReviewWindow from './components/features/ConflictReviewWindow';
// SyncTasksView는 기본 탭이므로 lazy loading 제외 - 즉시 로드
import SyncTasksView from './views/SyncTasksView';
import type {
  CloseRequestedEventPayload,
  RuntimeAutoUnmountRequestEvent,
  RuntimeState,
} from './types/runtime';
const DashboardView = lazy(() => import('./views/DashboardView'));
const ActivityLogView = lazy(() => import('./views/ActivityLogView'));
const SettingsView = lazy(() => import('./views/SettingsView'));
const HelpView = lazy(() => import('./views/HelpView'));
const AboutView = lazy(() => import('./views/AboutView'));

const BACKGROUND_INTRO_STORAGE_KEY = 'syncwatcher_bg_intro_shown';
type CloseIntent = 'window-close' | 'cmd-quit' | 'tray-quit';

function getCurrentWindowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return 'main';
  }
}

/**
 * SyncWatcher App - Main application component
 * State-based page routing with AppShell layout
 */
function AppContent() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('sync-tasks');
  const { settings, loaded: settingsLoaded } = useSettings();
  const { tasks, loaded: tasksLoaded } = useSyncTasksContext();
  const { loaded: setsLoaded } = useExclusionSetsContext();
  const [initialRuntimeSync, setInitialRuntimeSync] = useState<InitialRuntimeSyncState>('idle');
  const [showBackgroundIntro, setShowBackgroundIntro] = useState(false);
  const [pendingAutoUnmountRequests, setPendingAutoUnmountRequests] = useState<RuntimeAutoUnmountRequestEvent[]>([]);
  const [activeAutoUnmountRequest, setActiveAutoUnmountRequest] = useState<RuntimeAutoUnmountRequestEvent | null>(null);
  const isHandlingCloseRef = useRef(false);
  const activeCloseIntentRef = useRef<CloseIntent | null>(null);
  const pendingCloseIntentRef = useRef<CloseIntent | null>(null);
  const recentCmdQAtRef = useRef(0);
  const isLifecycleReady = settingsLoaded && tasksLoaded;
  const { updateSettings } = useSettings();
  const setTaskLastLog = useCallback((
    taskId: string,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
  ) => {
    useSyncTaskStatusStore.getState().setLastLog(taskId, {
      message,
      timestamp: new Date().toLocaleTimeString(),
      level,
    });
  }, []);

  // 앱 시작 시 라이선스 검증
  useEffect(() => {
    if (!settingsLoaded) return;

    const validateLicense = async () => {
      try {
        const result = await invoke<{ valid: boolean; error: string | null }>('validate_license_key');
        updateSettings({ isRegistered: result?.valid === true });
      } catch (err) {
        console.error('[App] License validation failed:', err);
        updateSettings({ isRegistered: false });
      }
    };

    void validateLicense();
  }, [settingsLoaded, updateSettings]);

  const dismissBackgroundIntro = useCallback(() => {
    setShowBackgroundIntro(false);
    try {
      localStorage.setItem(BACKGROUND_INTRO_STORAGE_KEY, '1');
    } catch (err) {
      console.error('Failed to persist background intro state:', err);
    }
  }, []);

  const runExclusiveCloseAction = useCallback(async (action: () => Promise<void>) => {
    if (isHandlingCloseRef.current) {
      return;
    }

    isHandlingCloseRef.current = true;
    try {
      await action();
    } finally {
      isHandlingCloseRef.current = false;
    }
  }, []);

  const queueCloseIntent = useCallback((intent: CloseIntent) => {
    const currentIntent = pendingCloseIntentRef.current ?? activeCloseIntentRef.current;
    const shouldOverride =
      intent === 'tray-quit'
      || currentIntent === null
      || (intent === 'cmd-quit' && currentIntent === 'window-close');
    if (shouldOverride) {
      pendingCloseIntentRef.current = intent;
    }
  }, []);

  const hideToBackground = useCallback(async () => {
    await invoke('hide_to_background');

    if (settings.notifications) {
      try {
        await invoke('send_notification', {
          title: t('appName'),
          body: t('app.backgroundNotification'),
        });
      } catch (err) {
        console.error('Failed to send background notification:', err);
      }
    }
  }, [settings.notifications, t]);

  const askWithTimeout = useCallback(
    async (messageKey: string, timeoutMs: number): Promise<boolean> => (
      new Promise<boolean>((resolve) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(true);
        }, timeoutMs);

        ask(t(messageKey), {
          title: t('app.quitConfirmTitle'),
          kind: 'warning',
        })
          .then((confirmed) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeoutId);
            resolve(confirmed);
          })
          .catch((error) => {
            console.error('Failed to show timeout confirmation:', error);
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeoutId);
            resolve(false);
          });
      })
    ),
    [t]
  );

  const handleQuitWithConfirmation = useCallback(async () => {
    const hasWatchModeTasks = tasks.some((task) => task.watchMode ?? false);
    let hasSyncingTasks = false;
    let runtimeStateUnknown = false;

    try {
      const runtimeState = await invoke<RuntimeState>('runtime_get_state');
      hasSyncingTasks = runtimeState.syncingTasks.length > 0;
    } catch (err) {
      console.error('Failed to read runtime state before quit:', err);
      runtimeStateUnknown = true;
    }

    if (hasWatchModeTasks || hasSyncingTasks || runtimeStateUnknown) {
      const messageKey = runtimeStateUnknown
        ? 'app.quitConfirmMessageStateUnknown'
        : 'app.quitConfirmMessage';
      const confirmed = await ask(t(messageKey), {
        title: t('app.quitConfirmTitle'),
        kind: 'warning',
      });
      if (!confirmed) {
        return;
      }
    }

    await invoke('quit_app');
  }, [tasks, t]);

  const handleCmdQuitWithPolicy = useCallback(async () => {
    if (settings.closeAction === 'background') {
      const backgroundLabel = t('app.cmdQuitBackgroundOption');
      const quitLabel = t('app.cmdQuitFullQuitOption');
      const cancelLabel = t('app.cmdQuitCancelOption', { defaultValue: t('common.cancel') });
      const result = await message(t('app.cmdQuitBackgroundPrompt'), {
        title: t('app.quitConfirmTitle'),
        kind: 'warning',
        buttons: {
          yes: backgroundLabel,
          no: quitLabel,
          cancel: cancelLabel,
        },
      });

      if (result === backgroundLabel || result === 'Yes') {
        await hideToBackground();
        return;
      }

      if (result === quitLabel || result === 'No') {
        await invoke('quit_app');
      }
      return;
    }

    const confirmed = await askWithTimeout('app.cmdQuitPrompt', 10_000);
    if (confirmed) {
      await invoke('quit_app');
    }
  }, [askWithTimeout, hideToBackground, settings.closeAction, t]);

  const executeCloseIntent = useCallback(async (intent: CloseIntent) => {
    try {
      if (intent === 'cmd-quit') {
        await handleCmdQuitWithPolicy();
        return;
      }

      if (intent === 'window-close' && settings.closeAction === 'background') {
        await Promise.resolve();
        if (pendingCloseIntentRef.current === 'cmd-quit' || pendingCloseIntentRef.current === 'tray-quit') {
          return;
        }

        await hideToBackground();
        return;
      }

      await handleQuitWithConfirmation();
    } catch (err) {
      console.error('Failed to process close action:', err);
    }
  }, [handleCmdQuitWithPolicy, handleQuitWithConfirmation, hideToBackground, settings.closeAction]);

  const drainCloseIntents = useCallback(async () => {
    if (!isLifecycleReady) {
      return;
    }

    if (!pendingCloseIntentRef.current && !activeCloseIntentRef.current) {
      return;
    }

    await runExclusiveCloseAction(async () => {
      while (pendingCloseIntentRef.current) {
        const nextIntent = pendingCloseIntentRef.current;
        pendingCloseIntentRef.current = null;

        activeCloseIntentRef.current = nextIntent;
        await executeCloseIntent(nextIntent);
      }

      activeCloseIntentRef.current = null;
    });
  }, [isLifecycleReady, executeCloseIntent, runExclusiveCloseAction]);

  const requestCloseIntent = useCallback(async (intent: CloseIntent) => {
    if (!isLifecycleReady) {
      queueCloseIntent(intent);
      return;
    }

    queueCloseIntent(intent);
    await drainCloseIntents();
  }, [drainCloseIntents, isLifecycleReady, queueCloseIntent]);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    try {
      const alreadyShown = localStorage.getItem(BACKGROUND_INTRO_STORAGE_KEY);
      if (!alreadyShown) {
        setShowBackgroundIntro(true);
      }
    } catch (err) {
      console.error('Failed to read background intro state:', err);
    }
  }, [settingsLoaded]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'q') {
        recentCmdQAtRef.current = Date.now();
        event.preventDefault();
        event.stopImmediatePropagation();
        void requestCloseIntent('cmd-quit');
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [requestCloseIntent]);

  useEffect(() => {
    const unlistenPromise = listen<CloseRequestedEventPayload>('close-requested', async (event) => {
      const likelyCmdQ = Date.now() - recentCmdQAtRef.current <= 1200;
      const source = event.payload?.source === 'cmd-quit'
        ? 'cmd-quit'
        : event.payload?.source === 'window-close'
          ? 'window-close'
          : (likelyCmdQ ? 'cmd-quit' : 'window-close');

      if (source === 'cmd-quit') {
        recentCmdQAtRef.current = 0;
      }

      await requestCloseIntent(source);
    });

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => {
          console.warn('[App] Failed to unlisten close-requested', err);
        });
    };
  }, [requestCloseIntent]);

  useEffect(() => {
    let isActive = true;
    const unlistenClosePromise = getCurrentWebviewWindow().onCloseRequested(async (event) => {
      const isLikelyCmdQClose = Date.now() - recentCmdQAtRef.current <= 1200;
      if (!isLikelyCmdQClose) {
        return;
      }

      event.preventDefault();
      recentCmdQAtRef.current = 0;
      await requestCloseIntent('cmd-quit');
    });

    void unlistenClosePromise
      .then((unlisten) => {
        if (!isActive) {
          unlisten();
          return;
        }
      });

    const unlistenPromise = listen('tray-quit-requested', async () => {
      await requestCloseIntent('tray-quit');
    });

    return () => {
      isActive = false;
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => {
          console.warn('[App] Failed to unlisten tray-quit-requested', err);
      });
      void unlistenClosePromise.then((unlisten) => unlisten());
    };
  }, [requestCloseIntent]);

  useEffect(() => {
    const unlistenPromise = listen<RuntimeAutoUnmountRequestEvent>(
      'runtime-auto-unmount-request',
      (event) => {
        const payload = event.payload;
        setTaskLastLog(
          payload.taskId,
          t('syncTasks.autoUnmountPendingStatus', {
            defaultValue: 'Unmount 확인 대기',
          }),
          'warning',
        );
        void invoke('send_notification', {
          title: t('appName'),
          body: t('app.autoUnmountConfirmNotification', {
            taskName: payload.taskName,
            defaultValue: `[${payload.taskName}] 복사된 파일이 없어 unmount 전에 확인이 필요합니다.`,
          }),
        }).catch((error) => {
          console.error('Failed to send auto-unmount notification:', error);
        });

        setPendingAutoUnmountRequests((prev) => [
          ...prev.filter((item) => item.taskId !== payload.taskId),
          payload,
        ]);
      }
    );

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => {
          console.warn('[App] Failed to unlisten runtime-auto-unmount-request', err);
        });
    };
  }, [setTaskLastLog, t]);

  useEffect(() => {
    if (activeAutoUnmountRequest || pendingAutoUnmountRequests.length === 0) {
      return;
    }

    let cancelled = false;
    const tryActivate = async () => {
      const next = pendingAutoUnmountRequests[0];
      if (!next) {
        return;
      }

      let visible = true;
      try {
        visible = await getCurrentWebviewWindow().isVisible();
      } catch (error) {
        console.error('Failed to inspect window visibility:', error);
      }

      if (cancelled || !visible) {
        return;
      }

      setActiveAutoUnmountRequest(next);
      setPendingAutoUnmountRequests((prev) => prev.slice(1));
    };

    void tryActivate();
    const timer = window.setInterval(() => {
      void tryActivate();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeAutoUnmountRequest, pendingAutoUnmountRequests]);

  const confirmAutoUnmount = useCallback(async () => {
    const request = activeAutoUnmountRequest;
    if (!request) {
      return;
    }

    try {
      await invoke('unmount_volume', { path: request.source });
      setTaskLastLog(
        request.taskId,
        t('syncTasks.autoUnmountConfirmedStatus', {
          defaultValue: 'Unmount 확인 완료',
        }),
        'success',
      );
    } catch (error) {
      console.error('Failed to unmount from auto-unmount confirmation:', error);
      setTaskLastLog(
        request.taskId,
        t('syncTasks.autoUnmountFailedStatus', {
          defaultValue: 'Unmount 실패',
        }),
        'warning',
      );
    } finally {
      useSyncTaskStatusStore.getState().setQueued(request.taskId, false);
      setPendingAutoUnmountRequests((prev) =>
        prev.filter((item) => item.taskId !== request.taskId)
      );
      setActiveAutoUnmountRequest(null);
    }
  }, [activeAutoUnmountRequest, setTaskLastLog, t]);

  const cancelAutoUnmount = useCallback(async () => {
    const request = activeAutoUnmountRequest;
    if (!request) {
      return;
    }

    try {
      await invoke('set_auto_unmount_session_disabled', {
        taskId: request.taskId,
        disabled: true,
      });
      setTaskLastLog(
        request.taskId,
        t('syncTasks.autoUnmountCancelledStatus', {
          defaultValue: 'Unmount 취소(마운트 유지)',
        }),
        'warning',
      );
    } catch (error) {
      console.error('Failed to set auto-unmount session suppression:', error);
      setTaskLastLog(request.taskId, String(error), 'error');
    } finally {
      useSyncTaskStatusStore.getState().setQueued(request.taskId, false);
      setPendingAutoUnmountRequests((prev) =>
        prev.filter((item) => item.taskId !== request.taskId)
      );
      setActiveAutoUnmountRequest(null);
    }
  }, [activeAutoUnmountRequest, setTaskLastLog, t]);

  useEffect(() => {
    void drainCloseIntents();
  }, [drainCloseIntents, isLifecycleReady]);

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardView />;
      case 'sync-tasks':
        return <SyncTasksView />;
      case 'activity-log':
        return <ActivityLogView />;
      case 'settings':
        return <SettingsView />;
      case 'help':
        return <HelpView />;
      case 'about':
        return <AboutView />;
      default:
        return <DashboardView />;
    }
  };

  const startupComplete =
    settingsLoaded &&
    tasksLoaded &&
    setsLoaded &&
    (initialRuntimeSync === 'success' || initialRuntimeSync === 'error');
  const canRenderAppShell = settingsLoaded && tasksLoaded && setsLoaded;

  return (
    <>
      <BackendRuntimeBridge onInitialRuntimeSyncChange={setInitialRuntimeSync} />
      {canRenderAppShell ? (
        <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
          {showBackgroundIntro ? (
            <div className="mb-4 border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] p-4 shadow-[4px_4px_0_0_var(--shadow-color)]">
              <p className="mb-3 font-mono text-sm text-[var(--text-primary)]">
                {t('app.backgroundIntroMessage')}
              </p>
              <button
                onClick={dismissBackgroundIntro}
                className="border-2 border-[var(--border-main)] px-3 py-1 text-xs font-bold uppercase hover:bg-[var(--bg-tertiary)]"
              >
                {t('common.ok')}
              </button>
            </div>
          ) : null}
          <Suspense
            fallback={(
              <div className="neo-box p-6 bg-[var(--bg-secondary)]">
                <p className="font-mono text-sm uppercase text-[var(--text-secondary)]">
                  {t('app.loadingView')}
                </p>
              </div>
            )}
          >
            <PageTransition pageKey={activeTab}>
              {renderContent()}
            </PageTransition>
          </Suspense>
        </AppShell>
      ) : null}
      <AutoUnmountConfirmModal
        opened={activeAutoUnmountRequest !== null}
        taskName={activeAutoUnmountRequest?.taskName || ''}
        source={activeAutoUnmountRequest?.source || ''}
        filesCopied={activeAutoUnmountRequest?.filesCopied || 0}
        bytesCopied={activeAutoUnmountRequest?.bytesCopied || 0}
        onConfirm={confirmAutoUnmount}
        onCancel={cancelAutoUnmount}
      />
      <StartupProgressOverlay
        settingsLoaded={settingsLoaded}
        tasksLoaded={tasksLoaded}
        exclusionSetsLoaded={setsLoaded}
        initialRuntimeSync={initialRuntimeSync}
        visible={!startupComplete}
      />
      <UpdateChecker />
    </>
  );
}

function App() {
  const windowLabel = getCurrentWindowLabel();

  if (windowLabel === 'conflict-review') {
    return (
      <ErrorBoundary>
        <SettingsProvider>
          <ToastProvider>
            <ConflictReviewWindow />
          </ToastProvider>
        </SettingsProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SettingsProvider>
        <SyncTasksProvider>
          <ExclusionSetsProvider>
            <ToastProvider>
              <AppContent />
            </ToastProvider>
          </ExclusionSetsProvider>
        </SyncTasksProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
