import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask } from '@tauri-apps/plugin-dialog';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppShell from './components/layout/AppShell';
import { useSettings } from './hooks/useSettings';
import { SettingsProvider } from './context/SettingsContext';
import { useSyncTasksContext, SyncTasksProvider } from './context/SyncTasksContext';
import { useExclusionSetsContext, ExclusionSetsProvider } from './context/ExclusionSetsContext';
import StartupProgressOverlay from './components/ui/StartupProgressOverlay';
import { PageTransition } from './components/ui/Animations';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ui/ErrorBoundary';
import UpdateChecker from './components/features/UpdateChecker';
import BackendRuntimeBridge, { type InitialRuntimeSyncState } from './components/runtime/BackendRuntimeBridge';
import ConflictReviewWindow from './components/features/ConflictReviewWindow';
// SyncTasksView는 기본 탭이므로 lazy loading 제외 - 즉시 로드
import SyncTasksView from './views/SyncTasksView';
import type { RuntimeState } from './types/runtime';
const DashboardView = lazy(() => import('./views/DashboardView'));
const ActivityLogView = lazy(() => import('./views/ActivityLogView'));
const SettingsView = lazy(() => import('./views/SettingsView'));
const HelpView = lazy(() => import('./views/HelpView'));
const AboutView = lazy(() => import('./views/AboutView'));

const BACKGROUND_INTRO_STORAGE_KEY = 'syncwatcher_bg_intro_shown';
type CloseIntent = 'window-close' | 'tray-quit';

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
  const isHandlingCloseRef = useRef(false);
  const pendingCloseIntentRef = useRef<CloseIntent | null>(null);
  const isLifecycleReady = settingsLoaded && tasksLoaded;
  const { updateSettings } = useSettings();

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
    const currentIntent = pendingCloseIntentRef.current;
    if (intent === 'tray-quit' || currentIntent === null) {
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

  const executeCloseIntent = useCallback(async (intent: CloseIntent) => {
    try {
      if (intent === 'window-close' && settings.closeAction === 'background') {
        await hideToBackground();
        return;
      }

      await handleQuitWithConfirmation();
    } catch (err) {
      console.error('Failed to process close action:', err);
    }
  }, [handleQuitWithConfirmation, hideToBackground, settings.closeAction]);

  const requestCloseIntent = useCallback(async (intent: CloseIntent) => {
    if (!isLifecycleReady) {
      queueCloseIntent(intent);
      return;
    }

    await runExclusiveCloseAction(async () => {
      await executeCloseIntent(intent);
    });
  }, [executeCloseIntent, isLifecycleReady, queueCloseIntent, runExclusiveCloseAction]);

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
    const unlistenPromise = listen('close-requested', async () => {
      await requestCloseIntent('window-close');
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
    const unlistenPromise = listen('tray-quit-requested', async () => {
      await requestCloseIntent('tray-quit');
    });

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => {
          console.warn('[App] Failed to unlisten tray-quit-requested', err);
        });
    };
  }, [requestCloseIntent]);

  useEffect(() => {
    if (!isLifecycleReady || pendingCloseIntentRef.current === null) {
      return;
    }

    const pendingIntent = pendingCloseIntentRef.current;
    pendingCloseIntentRef.current = null;

    void runExclusiveCloseAction(async () => {
      await executeCloseIntent(pendingIntent);
    });
  }, [executeCloseIntent, isLifecycleReady, runExclusiveCloseAction]);

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
