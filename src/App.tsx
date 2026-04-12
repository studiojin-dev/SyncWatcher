import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppShell from './components/layout/AppShell';
import { DistributionProvider, useDistribution } from './context/DistributionContext';
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
import FirstRunIntroModal from './components/ui/FirstRunIntroModal';
import InlineDialogModal, {
  type InlineDialogAction,
} from './components/ui/InlineDialogModal';
import BackendRuntimeBridge, { type InitialRuntimeSyncState } from './components/runtime/BackendRuntimeBridge';
import SyncTaskSourceRecommendationBridge from './components/runtime/SyncTaskSourceRecommendationBridge';
import ConflictReviewWindow from './components/features/ConflictReviewWindow';
import {
  assertSupporterProviderMatchesPolicy,
  getDistributionPolicy,
} from './utils/distributionPolicy';
// SyncTasksView는 기본 탭이므로 lazy loading 제외 - 즉시 로드
import SyncTasksView from './views/SyncTasksView';
import type {
  CloseRequestedEventPayload,
  RuntimeAutoUnmountRequestEvent,
  RuntimeState,
} from './types/runtime';
const DashboardView = lazy(() => import('./views/DashboardView'));
const ActivityLogView = lazy(() => import('./views/ActivityLogView'));
const RecurringSchedulesView = lazy(() => import('./views/RecurringSchedulesView'));
const SettingsView = lazy(() => import('./views/SettingsView'));
const HelpView = lazy(() => import('./views/HelpView'));
const AboutView = lazy(() => import('./views/AboutView'));

const LEGACY_BACKGROUND_INTRO_STORAGE_KEY = 'syncwatcher_bg_intro_shown';
const FIRST_RUN_INTRO_STORAGE_KEY = 'syncwatcher_first_run_intro_seen';
const APP_STORE_IMPORT_PROMPT_STORAGE_KEY = 'syncwatcher_app_store_legacy_import_prompted';
type CloseIntent = 'window-close' | 'cmd-quit' | 'tray-quit';
type InlineDialogTone = 'primary' | 'warning' | 'danger' | 'neutral';

interface InlineDialogRequest {
  title: string;
  message: string;
  actions: InlineDialogAction[];
}

interface QueuedInlineDialogRequest extends InlineDialogRequest {
  id: number;
  timeoutMs?: number;
  timeoutValue?: string;
  resolve: (value: string) => void;
}

interface OwnerLicenseRefreshSnapshot {
  ok: boolean;
  status?: {
    isRegistered: boolean;
    provider: 'lemon_squeezy' | 'app_store';
  } | null;
  error?: string | null;
}

interface OwnerLicenseDebugSnapshot {
  appSupportDir: string;
  markerPath: string;
  licenseStatePath: string;
  distribution: {
    channel: 'github' | 'app_store';
    purchaseProvider: 'lemon_squeezy' | 'app_store';
    canSelfUpdate: boolean;
    appStoreAppId: string | null;
    appStoreCountry: string;
    appStoreUrl: string | null;
    legacyImportAvailable: boolean;
  };
  cachedSupporterStatus: {
    isRegistered: boolean;
    provider: 'lemon_squeezy' | 'app_store';
  };
  cachedLicenseStatus: {
    isRegistered: boolean;
    licenseKey: string | null;
  };
  cachedLicenseState?: unknown;
  refreshSupporterStatus: OwnerLicenseRefreshSnapshot;
}

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
  const { info: distribution, loaded: distributionLoaded, reload: reloadDistribution } = useDistribution();
  const [activeTab, setActiveTab] = useState('sync-tasks');
  const [manualUpdateCheckNonce, setManualUpdateCheckNonce] = useState(0);
  const {
    settings,
    loaded: settingsLoaded,
    updateSettings,
    setLaunchAtLogin,
  } = useSettings();
  const { tasks, loaded: tasksLoaded } = useSyncTasksContext();
  const { loaded: setsLoaded } = useExclusionSetsContext();
  const [initialRuntimeSync, setInitialRuntimeSync] = useState<InitialRuntimeSyncState>('idle');
  const [showFirstRunIntro, setShowFirstRunIntro] = useState(false);
  const [ownerLicenseDebugSnapshot, setOwnerLicenseDebugSnapshot] = useState<OwnerLicenseDebugSnapshot | null>(null);
  const [isEnablingLaunchAtLogin, setIsEnablingLaunchAtLogin] = useState(false);
  const [requestedTaskEditId, setRequestedTaskEditId] = useState<string | null>(null);
  const [sourceReviewRequest, setSourceReviewRequest] = useState<{
    taskId: string | null;
    nonce: number;
  } | null>(null);
  const [inlineDialog, setInlineDialog] = useState<InlineDialogRequest | null>(null);
  const [pendingAutoUnmountRequests, setPendingAutoUnmountRequests] = useState<RuntimeAutoUnmountRequestEvent[]>([]);
  const [activeAutoUnmountRequest, setActiveAutoUnmountRequest] = useState<RuntimeAutoUnmountRequestEvent | null>(null);
  const isHandlingCloseRef = useRef(false);
  const activeCloseIntentRef = useRef<CloseIntent | null>(null);
  const pendingCloseIntentRef = useRef<CloseIntent | null>(null);
  const recentCmdQAtRef = useRef(0);
  const didRunStartupSupporterRefreshRef = useRef(false);
  const didPromptLegacyImportRef = useRef(false);
  const inlineDialogQueueRef = useRef<QueuedInlineDialogRequest[]>([]);
  const activeInlineDialogRef = useRef<QueuedInlineDialogRequest | null>(null);
  const inlineDialogSeqRef = useRef(0);
  const inlineDialogTimeoutRef = useRef<number | null>(null);
  const isLifecycleReady = settingsLoaded && tasksLoaded;
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

  const requestSourceRecommendationReview = useCallback((taskId?: string | null) => {
    setSourceReviewRequest({
      taskId: taskId ?? null,
      nonce: Date.now(),
    });
  }, []);

  const openTaskEditor = useCallback((taskId: string) => {
    setRequestedTaskEditId(taskId);
    setActiveTab('sync-tasks');
  }, []);

  const clearInlineDialogTimeout = useCallback(() => {
    if (inlineDialogTimeoutRef.current !== null) {
      window.clearTimeout(inlineDialogTimeoutRef.current);
      inlineDialogTimeoutRef.current = null;
    }
  }, []);

  const promoteInlineDialog = useCallback(() => {
    if (activeInlineDialogRef.current || inlineDialogQueueRef.current.length === 0) {
      return;
    }

    const nextRequest = inlineDialogQueueRef.current.shift() ?? null;
    if (!nextRequest) {
      setInlineDialog(null);
      return;
    }

    activeInlineDialogRef.current = nextRequest;
    setInlineDialog({
      title: nextRequest.title,
      message: nextRequest.message,
      actions: nextRequest.actions,
    });

    if (nextRequest.timeoutMs !== undefined && nextRequest.timeoutValue !== undefined) {
      inlineDialogTimeoutRef.current = window.setTimeout(() => {
        if (activeInlineDialogRef.current?.id !== nextRequest.id) {
          return;
        }

        clearInlineDialogTimeout();
        activeInlineDialogRef.current = null;
        setInlineDialog(null);
        nextRequest.resolve(nextRequest.timeoutValue ?? 'cancel');
        promoteInlineDialog();
      }, nextRequest.timeoutMs);
    }
  }, [clearInlineDialogTimeout]);

  const resolveInlineDialog = useCallback((value: string) => {
    const activeRequest = activeInlineDialogRef.current;
    if (!activeRequest) {
      return;
    }

    clearInlineDialogTimeout();
    activeInlineDialogRef.current = null;
    setInlineDialog(null);
    activeRequest.resolve(value);
    promoteInlineDialog();
  }, [clearInlineDialogTimeout, promoteInlineDialog]);

  const showInlineDialog = useCallback((options: {
    title: string;
    message: string;
    actions: InlineDialogAction[];
    timeoutMs?: number;
    timeoutValue?: string;
  }) => (
    new Promise<string>((resolve) => {
      inlineDialogQueueRef.current.push({
        id: inlineDialogSeqRef.current + 1,
        title: options.title,
        message: options.message,
        actions: options.actions,
        timeoutMs: options.timeoutMs,
        timeoutValue: options.timeoutValue,
        resolve,
      });
      inlineDialogSeqRef.current += 1;
      promoteInlineDialog();
    })
  ), [promoteInlineDialog]);

  const showInlineConfirm = useCallback(async (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    confirmTone?: InlineDialogTone;
    timeoutMs?: number;
    confirmOnTimeout?: boolean;
  }) => {
    const result = await showInlineDialog({
      title: options.title,
      message: options.message,
      actions: [
        {
          key: 'cancel',
          label: options.cancelLabel ?? t('common.cancel'),
          tone: 'neutral',
        },
        {
          key: 'confirm',
          label: options.confirmLabel ?? t('common.confirm'),
          tone: options.confirmTone ?? 'warning',
        },
      ],
      timeoutMs: options.timeoutMs,
      timeoutValue: options.confirmOnTimeout ? 'confirm' : 'cancel',
    });

    return result === 'confirm';
  }, [showInlineDialog, t]);

  const showInlineNotice = useCallback(async (options: {
    title: string;
    message: string;
    closeLabel?: string;
    closeTone?: InlineDialogTone;
  }) => {
    await showInlineDialog({
      title: options.title,
      message: options.message,
      actions: [
        {
          key: 'close',
          label: options.closeLabel ?? t('common.close', { defaultValue: 'Close' }),
          tone: options.closeTone ?? 'primary',
        },
      ],
    });
  }, [showInlineDialog, t]);

  // 앱 시작 시 supporter 상태 갱신
  useEffect(() => {
    if (!settingsLoaded || !distributionLoaded || didRunStartupSupporterRefreshRef.current) {
      return;
    }

    didRunStartupSupporterRefreshRef.current = true;

    let cancelled = false;

    const refreshSupporterStatus = async () => {
      const readCachedSupporterStatus = async () => {
        const fallback = await invoke<{
          isRegistered: boolean;
          provider: 'lemon_squeezy' | 'app_store';
        }>('get_supporter_status');
        assertSupporterProviderMatchesPolicy(
          getDistributionPolicy(distribution),
          fallback.provider,
        );
        return fallback;
      };

      const applySupporterStatus = (result: {
        isRegistered: boolean;
        provider: 'lemon_squeezy' | 'app_store';
      }) => {
        assertSupporterProviderMatchesPolicy(
          getDistributionPolicy(distribution),
          result.provider,
        );
        if (!cancelled) {
          updateSettings({ isRegistered: result.isRegistered });
        }
      };

      try {
        const result = await invoke<{
          isRegistered: boolean;
          provider: 'lemon_squeezy' | 'app_store';
        }>('refresh_supporter_status');
        if (!result.isRegistered) {
          try {
            const cached = await readCachedSupporterStatus();
            if (cached.isRegistered) {
              applySupporterStatus(cached);
              return;
            }
          } catch (cachedErr) {
            console.error('[App] Cached supporter status read failed after inactive refresh:', cachedErr);
          }
        }
        applySupporterStatus(result);
      } catch (err) {
        console.error('[App] Supporter status refresh failed:', err);
        try {
          const fallback = await readCachedSupporterStatus();
          applySupporterStatus(fallback);
        } catch (fallbackErr) {
          console.error('[App] Supporter status fallback read failed:', fallbackErr);
        }
      }
    };

    void refreshSupporterStatus();

    return () => {
      cancelled = true;
    };
  }, [distribution, distributionLoaded, settingsLoaded, updateSettings]);

  useEffect(() => {
    let cancelled = false;

    const loadOwnerLicenseDebugSnapshot = async () => {
      try {
        const snapshot = await invoke<OwnerLicenseDebugSnapshot>('get_owner_license_debug_snapshot');
        if (!cancelled) {
          setOwnerLicenseDebugSnapshot(snapshot);
        }
      } catch {
        if (!cancelled) {
          setOwnerLicenseDebugSnapshot(null);
        }
      }
    };

    void loadOwnerLicenseDebugSnapshot();

    return () => {
      cancelled = true;
    };
  }, []);

  const startupComplete =
    settingsLoaded &&
    tasksLoaded &&
    setsLoaded &&
    (initialRuntimeSync === 'success' || initialRuntimeSync === 'error');

  useEffect(() => {
    if (
      !startupComplete
      || !distributionLoaded
      || didPromptLegacyImportRef.current
      || distribution.channel !== 'app_store'
      || !distribution.legacyImportAvailable
    ) {
      return;
    }

    didPromptLegacyImportRef.current = true;

    try {
      if (localStorage.getItem(APP_STORE_IMPORT_PROMPT_STORAGE_KEY) === '1') {
        return;
      }
    } catch (error) {
      console.error('Failed to read legacy import prompt state:', error);
    }

    const promptImport = async () => {
      try {
        const confirmed = await showInlineConfirm({
          title: t('app.importLegacyPromptTitle'),
          message: t('app.importLegacyPromptMessage'),
          confirmTone: 'primary',
        });
        if (!confirmed) {
          didPromptLegacyImportRef.current = false;
          return;
        }

        const result = await invoke<{ imported: boolean; message?: string | null }>('import_legacy_channel_data');
        await reloadDistribution();
        if (result?.imported) {
          try {
            localStorage.setItem(APP_STORE_IMPORT_PROMPT_STORAGE_KEY, '1');
          } catch (error) {
            console.error('Failed to persist legacy import prompt state:', error);
          }
        } else {
          didPromptLegacyImportRef.current = false;
        }
        if (result?.message) {
          await showInlineNotice({
            title: t('app.importLegacyPromptTitle'),
            message: result.message,
            closeTone: result.imported ? 'primary' : 'warning',
          });
        }
      } catch (error) {
        didPromptLegacyImportRef.current = false;
        console.error('Failed to import legacy channel data:', error);
      }
    };

    void promptImport();
  }, [distribution, distributionLoaded, reloadDistribution, showInlineConfirm, showInlineNotice, startupComplete, t]);

  const markFirstRunIntroSeen = useCallback(() => {
    try {
      localStorage.setItem(FIRST_RUN_INTRO_STORAGE_KEY, '1');
      localStorage.setItem(LEGACY_BACKGROUND_INTRO_STORAGE_KEY, '1');
    } catch (err) {
      console.error('Failed to persist first-run intro state:', err);
    }
  }, []);

  const dismissFirstRunIntro = useCallback(() => {
    setShowFirstRunIntro(false);
    markFirstRunIntroSeen();
  }, [markFirstRunIntroSeen]);

  const enableLaunchAtLoginFromIntro = useCallback(async () => {
    if (isEnablingLaunchAtLogin) {
      return;
    }

    setIsEnablingLaunchAtLogin(true);
    const updated = await setLaunchAtLogin(true);
    setIsEnablingLaunchAtLogin(false);

    if (!updated) {
      return;
    }

    setShowFirstRunIntro(false);
    markFirstRunIntroSeen();
  }, [isEnablingLaunchAtLogin, markFirstRunIntroSeen, setLaunchAtLogin]);

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
      showInlineConfirm({
        title: t('app.quitConfirmTitle'),
        message: t(messageKey),
        confirmTone: 'warning',
        timeoutMs,
        confirmOnTimeout: true,
      })
    ),
    [showInlineConfirm, t],
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
      const confirmed = await showInlineConfirm({
        title: t('app.quitConfirmTitle'),
        message: t(messageKey),
        confirmTone: 'warning',
      });
      if (!confirmed) {
        return;
      }
    }

    await invoke('quit_app');
  }, [showInlineConfirm, tasks, t]);

  const handleCmdQuitWithPolicy = useCallback(async () => {
    if (settings.closeAction === 'background') {
      const backgroundLabel = t('app.cmdQuitBackgroundOption');
      const quitLabel = t('app.cmdQuitFullQuitOption');
      const cancelLabel = t('app.cmdQuitCancelOption', { defaultValue: t('common.cancel') });
      const result = await showInlineDialog({
        title: t('app.quitConfirmTitle'),
        message: t('app.cmdQuitBackgroundPrompt'),
        actions: [
          { key: 'cancel', label: cancelLabel, tone: 'neutral' },
          { key: 'quit', label: quitLabel, tone: 'danger' },
          { key: 'background', label: backgroundLabel, tone: 'warning' },
        ],
      });

      if (result === 'background') {
        await hideToBackground();
        return;
      }

      if (result === 'quit') {
        await invoke('quit_app');
      }
      return;
    }

    const confirmed = await askWithTimeout('app.cmdQuitPrompt', 10_000);
    if (confirmed) {
      await invoke('quit_app');
    }
  }, [askWithTimeout, hideToBackground, settings.closeAction, showInlineDialog, t]);

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
      const alreadyShown = localStorage.getItem(FIRST_RUN_INTRO_STORAGE_KEY);
      const legacyShown = localStorage.getItem(LEGACY_BACKGROUND_INTRO_STORAGE_KEY);
      if (!alreadyShown && !legacyShown) {
        setShowFirstRunIntro(true);
      }
    } catch (err) {
      console.error('Failed to read first-run intro state:', err);
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
    const unlistenPromise = listen('app-check-for-updates-requested', async () => {
      setManualUpdateCheckNonce((prev) => prev + 1);
    });

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((err) => {
          console.warn('[App] Failed to unlisten app-check-for-updates-requested', err);
        });
    };
  }, []);

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

  useEffect(() => {
    return () => {
      clearInlineDialogTimeout();
      const activeRequest = activeInlineDialogRef.current;
      activeInlineDialogRef.current = null;
      setInlineDialog(null);
      activeRequest?.resolve('cancel');

      while (inlineDialogQueueRef.current.length > 0) {
        const pendingRequest = inlineDialogQueueRef.current.shift();
        pendingRequest?.resolve('cancel');
      }
    };
  }, [clearInlineDialogTimeout]);

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardView />;
      case 'sync-tasks':
        return (
          <SyncTasksView
            requestedEditTaskId={requestedTaskEditId}
            onRequestedEditTaskHandled={() => setRequestedTaskEditId(null)}
            onRequestSourceRecommendationReview={requestSourceRecommendationReview}
          />
        );
      case 'activity-log':
        return <ActivityLogView />;
      case 'recurring-schedules':
        return <RecurringSchedulesView />;
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

  const canRenderAppShell = settingsLoaded && tasksLoaded && setsLoaded;

  return (
    <>
      <BackendRuntimeBridge
        onInitialRuntimeSyncChange={setInitialRuntimeSync}
        onUuidSourceResolutionError={(taskId) => {
          requestSourceRecommendationReview(taskId);
        }}
      />
      <SyncTaskSourceRecommendationBridge
        reviewRequestTaskId={sourceReviewRequest?.taskId ?? null}
        reviewRequestNonce={sourceReviewRequest?.nonce ?? 0}
        onReviewRequestHandled={() => setSourceReviewRequest(null)}
        onOpenTaskEditor={openTaskEditor}
      />
      {canRenderAppShell ? (
        <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
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
      <FirstRunIntroModal
        opened={showFirstRunIntro}
        busy={isEnablingLaunchAtLogin}
        onDismiss={dismissFirstRunIntro}
        onEnable={() => {
          void enableLaunchAtLoginFromIntro();
        }}
      />
      <InlineDialogModal
        opened={inlineDialog !== null}
        title={inlineDialog?.title ?? ''}
        message={inlineDialog?.message ?? ''}
        actions={inlineDialog?.actions ?? []}
        onAction={resolveInlineDialog}
      />
      {ownerLicenseDebugSnapshot ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          data-testid="owner-license-debug-modal"
        >
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden border-4 border-[var(--border-main)] bg-[var(--bg-primary)] shadow-[8px_8px_0_0_var(--shadow-color)]">
            <div className="flex items-center justify-between border-b-4 border-[var(--border-main)] bg-[var(--accent-warning)] px-5 py-3">
              <div>
                <h2 className="text-sm font-black uppercase tracking-wider text-black">
                  Owner License Debug
                </h2>
                <p className="text-xs font-mono text-black/80">
                  Hidden mode unlocked by launch token + local marker file.
                </p>
              </div>
              <button
                type="button"
                className="neo-button px-3 py-2 text-xs"
                onClick={() => setOwnerLicenseDebugSnapshot(null)}
              >
                Close
              </button>
            </div>
            <div className="overflow-auto bg-black p-4">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6 text-green-300">
                {JSON.stringify(ownerLicenseDebugSnapshot, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
      <StartupProgressOverlay
        settingsLoaded={settingsLoaded}
        tasksLoaded={tasksLoaded}
        exclusionSetsLoaded={setsLoaded}
        initialRuntimeSync={initialRuntimeSync}
        visible={!startupComplete}
      />
      <UpdateChecker
        autoCheckEnabled={startupComplete}
        manualCheckRequestNonce={manualUpdateCheckNonce}
      />
    </>
  );
}

function App() {
  const windowLabel = getCurrentWindowLabel();

  if (windowLabel === 'conflict-review') {
    return (
      <ErrorBoundary>
        <DistributionProvider>
          <SettingsProvider>
            <ToastProvider>
              <ConflictReviewWindow />
            </ToastProvider>
          </SettingsProvider>
        </DistributionProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <DistributionProvider>
        <SettingsProvider>
          <SyncTasksProvider>
            <ExclusionSetsProvider>
              <ToastProvider>
                <AppContent />
              </ToastProvider>
            </ExclusionSetsProvider>
          </SyncTasksProvider>
        </SettingsProvider>
      </DistributionProvider>
    </ErrorBoundary>
  );
}

export default App;
