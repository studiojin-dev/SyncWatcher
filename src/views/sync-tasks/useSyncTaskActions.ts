import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import type { SyncTask } from '../../hooks/useSyncTasks';
import { useSyncTaskStatusStore, type TaskStatus } from '../../hooks/useSyncTaskStatus';
import { toRuntimeTask } from '../../types/runtime';
import { shouldEnableAutoUnmount } from '../../utils/autoUnmount';
import { isUuidSourceResolutionError } from '../../utils/syncTaskSourceRecommendations';
import type {
  ConflictReviewQueueChangedEvent,
  ConflictSessionSummary,
  DryRunResult,
  DryRunSessionState,
  SyncExecutionResult,
} from '../../types/syncEngine';
import type {
  RuntimeTaskValidationIssue,
  RuntimeTaskValidationResult,
} from '../../types/runtime';
import {
  buildUuidSourceToken,
  inferUuidTypeFromVolumes,
  normalizeUuidSubPath,
  type SourceUuidType,
} from '../syncTaskUuid';
import {
  getErrorMessage,
  getValidationSummary,
  showTargetPreflightToast,
  waitForWatchState,
  type CancelConfirmState,
  type ShowToastFn,
  type SubView,
  type TranslateFn,
} from './helpers';
import type { SyncTaskFormController } from './useSyncTaskFormController';

interface UseSyncTaskActionsOptions {
  tasks: SyncTask[];
  statuses: Map<string, TaskStatus>;
  dryRunSessions: Map<string, DryRunSessionState>;
  clearDryRunSession: (taskId: string) => void;
  addTask: (task: Omit<SyncTask, 'id'>) => Promise<unknown>;
  updateTask: (id: string, updates: Partial<SyncTask>) => Promise<unknown>;
  deleteTask: (id: string) => Promise<unknown>;
  reload: () => Promise<unknown> | unknown;
  editingTask: SyncTask | null;
  setEditingTask: Dispatch<SetStateAction<SyncTask | null>>;
  setShowForm: Dispatch<SetStateAction<boolean>>;
  setValidationErrorModal: Dispatch<
    SetStateAction<RuntimeTaskValidationIssue | null>
  >;
  setSubView: Dispatch<SetStateAction<SubView>>;
  getPatternsForSets: (setIds: string[]) => string[];
  form: SyncTaskFormController;
  showToast: ShowToastFn;
  t: TranslateFn;
  onRequestSourceRecommendationReview?: (taskId: string) => void;
}

export function useSyncTaskActions({
  tasks,
  statuses,
  dryRunSessions,
  clearDryRunSession,
  addTask,
  updateTask,
  deleteTask,
  reload,
  editingTask,
  setEditingTask,
  setShowForm,
  setValidationErrorModal,
  setSubView,
  getPatternsForSets,
  form,
  showToast,
  t,
  onRequestSourceRecommendationReview,
}: UseSyncTaskActionsOptions) {
  const [syncing, setSyncing] = useState<string | null>(null);
  const [watchTogglePendingIds, setWatchTogglePendingIds] = useState<
    Set<string>
  >(new Set());
  const [cancelConfirm, setCancelConfirm] =
    useState<CancelConfirmState | null>(null);
  const [conflictSessions, setConflictSessions] = useState<
    ConflictSessionSummary[]
  >([]);
  const [conflictSessionsLoading, setConflictSessionsLoading] = useState(false);

  const clearCancelConfirm = useCallback(() => {
    setCancelConfirm(null);
  }, []);

  const requestCancel = useCallback(
    (type: CancelConfirmState['type'], taskId: string) => {
      setCancelConfirm({ type, taskId });
    },
    [],
  );

  const closeForm = useCallback(() => {
    setValidationErrorModal(null);
    setShowForm(false);
    setEditingTask(null);
  }, [setEditingTask, setShowForm, setValidationErrorModal]);

  const openCreateForm = useCallback(() => {
    setValidationErrorModal(null);
    setShowForm(true);
    setEditingTask(null);
  }, [setEditingTask, setShowForm, setValidationErrorModal]);

  const openEditTask = useCallback(
    (task: SyncTask) => {
      setValidationErrorModal(null);
      setEditingTask(task);
      setShowForm(true);
    },
    [setEditingTask, setShowForm, setValidationErrorModal],
  );

  const openLogsView = useCallback(
    (task: SyncTask) => {
      setSubView({
        kind: 'logs',
        taskId: task.id,
        taskName: task.name,
      });
    },
    [setSubView],
  );

  const openOrphansView = useCallback(
    (task: SyncTask, excludePatterns: string[]) => {
      setSubView({
        kind: 'orphans',
        taskId: task.id,
        source: task.source,
        target: task.target,
        excludePatterns,
      });
    },
    [setSubView],
  );

  const openDryRunSession = useCallback(
    (task: SyncTask) => {
      setSubView({
        kind: 'dryRun',
        taskId: task.id,
        taskName: task.name,
      });
    },
    [setSubView],
  );

  const loadConflictSessions = useCallback(async () => {
    try {
      setConflictSessionsLoading(true);
      const sessions = await invoke<ConflictSessionSummary[]>(
        'list_conflict_review_sessions',
      );
      setConflictSessions(sessions);
    } catch (error) {
      console.error('Failed to load conflict sessions:', error);
    } finally {
      setConflictSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConflictSessions();

    const unlistenPromise = listen<ConflictReviewQueueChangedEvent>(
      'conflict-review-queue-changed',
      (event) => {
        setConflictSessions(event.payload.sessions);
      },
    );

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((error) => {
          console.warn(
            'Failed to unlisten conflict-review-queue-changed',
            error,
          );
        });
    };
  }, [loadConflictSessions]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);

      let finalSource = form.sourcePath || (formData.get('source') as string);
      const resolvedSourceUuidType: SourceUuidType | undefined =
        form.sourceType === 'uuid'
          ? form.sourceUuidType ||
            inferUuidTypeFromVolumes(form.sourceUuid, form.volumes) ||
            'disk'
          : undefined;
      const normalizedSourceSubPath = normalizeUuidSubPath(form.sourceSubPath);

      if (form.sourceType === 'uuid') {
        if (!form.sourceUuid) {
          showToast(
            t('syncTasks.selectVolume', { defaultValue: '볼륨 선택' }),
            'warning',
          );
          return;
        }

        finalSource = buildUuidSourceToken(
          resolvedSourceUuidType || 'disk',
          form.sourceUuid,
          normalizedSourceSubPath,
        );
      }

      const taskData = {
        name: formData.get('name') as string,
        source: finalSource,
        target: form.targetPath || (formData.get('target') as string),
        checksumMode: formData.get('checksumMode') === 'on',
        exclusionSets: form.selectedSets,
        watchMode: form.watchMode,
        autoUnmount: shouldEnableAutoUnmount({
          source: finalSource,
          sourceType: form.sourceType,
          watchMode: form.watchMode,
          autoUnmount: form.autoUnmount,
        }),
        sourceType: form.sourceType,
        sourceUuid: form.sourceType === 'uuid' ? form.sourceUuid : undefined,
        sourceUuidType:
          form.sourceType === 'uuid' ? resolvedSourceUuidType : undefined,
        sourceSubPath:
          form.sourceType === 'uuid' ? normalizedSourceSubPath : undefined,
      };

      try {
        const provisionalTask: SyncTask = editingTask
          ? { ...editingTask, ...taskData }
          : { id: crypto.randomUUID(), ...taskData };
        const allTasks = editingTask
          ? tasks.map((task) =>
              task.id === editingTask.id ? provisionalTask : task,
            )
          : [...tasks, provisionalTask];

        const validation = await invoke<RuntimeTaskValidationResult>(
          'runtime_validate_tasks',
          {
            tasks: allTasks.map(toRuntimeTask),
          },
        );

        if (!validation.ok && validation.issue) {
          if (editingTask) {
            useSyncTaskStatusStore.getState().setLastLog(editingTask.id, {
              message: getValidationSummary(validation.issue, t),
              timestamp: new Date().toLocaleTimeString(),
              level: 'error',
            });
          }
          setValidationErrorModal(validation.issue);
          return;
        }

        if (editingTask) {
          await updateTask(editingTask.id, taskData);
          showToast(t('syncTasks.editTask') + ': ' + taskData.name, 'success');
        } else {
          await addTask(taskData);
          showToast(t('syncTasks.addTask') + ': ' + taskData.name, 'success');
        }

        closeForm();
      } catch (error) {
        showToast(getErrorMessage(error), 'error');
      }
    },
    [
      addTask,
      closeForm,
      editingTask,
      form,
      setValidationErrorModal,
      showToast,
      t,
      tasks,
      updateTask,
    ],
  );

  const handleSync = useCallback(
    async (task: SyncTask) => {
      if (syncing === task.id) {
        requestCancel('sync', task.id);
        return;
      }

      if (syncing) {
        return;
      }

      const confirmed = await ask(
        t('syncTasks.confirmStartSync', {
          defaultValue: '지금 동기화를 시작할까요?',
        }),
        {
          title: t('syncTasks.startSync'),
          kind: 'warning',
        },
      );
      if (!confirmed) {
        return;
      }

      try {
        setSyncing(task.id);
        showToast(t('syncTasks.startSync') + ': ' + task.name, 'info');

        const execution = await invoke<SyncExecutionResult>('start_sync', {
          taskId: task.id,
          taskName: task.name,
          source: task.source,
          target: task.target,
          checksumMode: task.checksumMode,
          verifyAfterCopy: true,
          excludePatterns: getPatternsForSets(task.exclusionSets || []),
        });
        showTargetPreflightToast(execution.targetPreflight, showToast, t);

        if (execution.hasPendingConflicts) {
          showToast(
            t('conflict.detectedAfterSync', {
              count: execution.conflictCount,
              defaultValue: `동기화 완료. ${execution.conflictCount}개 항목은 타겟이 더 최신하여 검토가 필요합니다.`,
            }),
            'warning',
          );
          await loadConflictSessions();

          if (execution.conflictSessionId) {
            const openNow = await ask(
              t('conflict.openNowPrompt', {
                defaultValue: '지금 검토 창을 열어 처리하시겠습니까?',
              }),
              {
                title: t('conflict.queueTitle', {
                  defaultValue: '확인이 필요한 목록',
                }),
                kind: 'warning',
              },
            );
            if (openNow) {
              await invoke('open_conflict_review_window', {
                sessionId: execution.conflictSessionId,
              });
            }
          }
        } else {
          showToast(t('sync.syncComplete'), 'success');
        }

        if (shouldEnableAutoUnmount(task)) {
          if (execution.hasPendingConflicts) {
            showToast(
              t('conflict.autoUnmountSkipped', {
                defaultValue:
                  '충돌 검토가 남아 있어 자동 unmount를 생략했습니다.',
              }),
              'warning',
            );
          } else {
            const isSessionDisabled = await invoke<boolean>(
              'is_auto_unmount_session_disabled',
              {
                taskId: task.id,
              },
            );
            if (isSessionDisabled) {
              const suppressedMessage = t(
                'syncTasks.autoUnmountSuppressedStatus',
                {
                  defaultValue:
                    '이번 세션에서는 auto-unmount가 비활성화되어 마운트를 유지합니다.',
                },
              );
              useSyncTaskStatusStore.getState().setLastLog(task.id, {
                message: suppressedMessage,
                timestamp: new Date().toLocaleTimeString(),
                level: 'warning',
              });
              showToast(suppressedMessage, 'info');
              return;
            }

            try {
              await invoke('unmount_volume', { path: task.source });
              useSyncTaskStatusStore.getState().setLastLog(task.id, {
                message: t('syncTasks.autoUnmountConfirmedStatus', {
                  defaultValue: 'Unmount 확인 완료',
                }),
                timestamp: new Date().toLocaleTimeString(),
                level: 'success',
              });
              showToast(
                t('syncTasks.unmountSuccess', {
                  defaultValue: '볼륨이 안전하게 제거되었습니다.',
                }),
                'success',
              );
            } catch (unmountError) {
              console.error('Auto unmount failed:', unmountError);
              useSyncTaskStatusStore.getState().setLastLog(task.id, {
                message: t('syncTasks.autoUnmountFailedStatus', {
                  defaultValue: 'Unmount 실패',
                }),
                timestamp: new Date().toLocaleTimeString(),
                level: 'warning',
              });
              showToast(
                t('syncTasks.unmountFailed', {
                  defaultValue: '볼륨 제거 실패',
                }),
                'warning',
              );
            }
          }
        }
      } catch (error) {
        console.error('Sync failed:', error);
        const errorMessage = getErrorMessage(error);
        showToast(errorMessage, 'error');
        if (isUuidSourceResolutionError(errorMessage)) {
          onRequestSourceRecommendationReview?.(task.id);
        }
      } finally {
        setSyncing(null);
      }
    },
    [
      getPatternsForSets,
      loadConflictSessions,
      onRequestSourceRecommendationReview,
      requestCancel,
      showToast,
      syncing,
      t,
    ],
  );

  const handleToggleWatchMode = useCallback(
    async (task: SyncTask) => {
      if (watchTogglePendingIds.has(task.id)) {
        return;
      }

      const previousWatchMode = task.watchMode ?? false;
      const nextWatchMode = !previousWatchMode;

      if (previousWatchMode && !nextWatchMode) {
        const confirmed = await ask(
          t('syncTasks.confirmWatchDisable', {
            defaultValue: 'Watch Mode를 끄시겠습니까?',
          }),
          {
            title: t('syncTasks.watchToggleOff'),
            kind: 'warning',
          },
        );
        if (!confirmed) {
          return;
        }
      }

      setWatchTogglePendingIds((previous) => {
        const next = new Set(previous);
        next.add(task.id);
        return next;
      });

      try {
        await updateTask(task.id, { watchMode: nextWatchMode });
        const reflected = await waitForWatchState(task.id, nextWatchMode);

        if (!reflected) {
          await updateTask(task.id, { watchMode: previousWatchMode });
          showToast(t('syncTasks.watchToggleFailed'), 'error');
          return;
        }

        showToast(
          nextWatchMode
            ? t('syncTasks.watchStarting')
            : t('syncTasks.watchStopping'),
          'success',
        );
      } catch (error) {
        try {
          await updateTask(task.id, { watchMode: previousWatchMode });
        } catch (rollbackError) {
          console.error('Watch toggle rollback failed:', rollbackError);
        }

        console.error('Watch toggle failed:', error);
        showToast(getErrorMessage(error), 'error');
      } finally {
        setWatchTogglePendingIds((previous) => {
          const next = new Set(previous);
          next.delete(task.id);
          return next;
        });
      }
    },
    [showToast, t, updateTask, watchTogglePendingIds],
  );

  const startDryRun = useCallback(
    async (task: SyncTask) => {
      const confirmed = await ask(
        t('syncTasks.confirmDryRun', {
          defaultValue: 'Dry Run을 시작할까요?',
        }),
        {
          title: t('syncTasks.dryRun'),
          kind: 'warning',
        },
      );
      if (!confirmed) {
        return;
      }

      const store = useSyncTaskStatusStore.getState();
      store.beginDryRunSession(task.id, task.name);
      store.setDryRunning(task.id, true);
      openDryRunSession(task);
      showToast(t('syncTasks.dryRun') + '...', 'info');

      try {
        const result = await invoke<DryRunResult>('sync_dry_run', {
          taskId: task.id,
          source: task.source,
          target: task.target,
          checksumMode: task.checksumMode,
          excludePatterns: getPatternsForSets(task.exclusionSets || []),
        });
        store.completeDryRunSession(task.id, result);
        showTargetPreflightToast(result.targetPreflight, showToast, t);
        showToast(t('syncTasks.dryRun') + ' ' + t('common.success'), 'success');
      } catch (error) {
        console.error('Dry run failed:', error);
        const errorMessage = getErrorMessage(error);
        store.failDryRunSession(task.id, errorMessage);
        if (errorMessage.toLowerCase().includes('cancel')) {
          return;
        }
        showToast(errorMessage, 'error');
        if (isUuidSourceResolutionError(errorMessage)) {
          onRequestSourceRecommendationReview?.(task.id);
        }
      } finally {
        store.setDryRunning(task.id, false);
      }
    },
    [
      getPatternsForSets,
      onRequestSourceRecommendationReview,
      openDryRunSession,
      showToast,
      t,
    ],
  );

  const handleDryRun = useCallback(
    async (task: SyncTask) => {
      const taskStatus = statuses.get(task.id);
      const existingSession = dryRunSessions.get(task.id);

      if (existingSession) {
        openDryRunSession(task);
        return;
      }

      if (taskStatus?.status === 'dryRunning') {
        requestCancel('dryRun', task.id);
        return;
      }

      await startDryRun(task);
    },
    [dryRunSessions, openDryRunSession, requestCancel, startDryRun, statuses],
  );

  const handleDelete = useCallback(
    async (task: SyncTask) => {
      const confirmed = await ask(
        t('syncTasks.confirmDelete', {
          defaultValue: 'Are you sure you want to delete this task?',
        }),
        {
          title: t('syncTasks.deleteTask', { defaultValue: 'Delete Task' }),
          kind: 'warning',
        },
      );

      if (!confirmed) {
        return;
      }

      try {
        await deleteTask(task.id);
        clearDryRunSession(task.id);
        showToast(t('syncTasks.deleteTask') + ': ' + task.name, 'warning');
      } catch (error) {
        showToast(getErrorMessage(error), 'error');
      }
    },
    [clearDryRunSession, deleteTask, showToast, t],
  );

  const handleEditorClose = useCallback(async () => {
    await reload();
  }, [reload]);

  const handleCancelConfirm = useCallback(async () => {
    if (!cancelConfirm) {
      return;
    }

    try {
      await invoke('cancel_operation', {
        taskId: cancelConfirm.taskId,
        operationType: cancelConfirm.type,
      });
      showToast(
        t('syncTasks.cancelled', { defaultValue: '작업이 취소되었습니다.' }),
        'warning',
      );
    } catch (error) {
      console.error('Cancel failed:', error);
      showToast(String(error), 'error');
    } finally {
      if (cancelConfirm.type === 'sync') {
        setSyncing(null);
      }
      setCancelConfirm(null);
    }
  }, [cancelConfirm, showToast, t]);

  const handleOpenConflictSession = useCallback(
    async (sessionId: string) => {
      try {
        await invoke('open_conflict_review_window', { sessionId });
      } catch (error) {
        showToast(getErrorMessage(error), 'error');
      }
    },
    [showToast],
  );

  return {
    syncing,
    watchTogglePendingIds,
    cancelConfirm,
    conflictSessions,
    conflictSessionsLoading,
    clearCancelConfirm,
    requestCancel,
    closeForm,
    openCreateForm,
    openEditTask,
    openLogsView,
    openOrphansView,
    loadConflictSessions,
    handleSubmit,
    handleSync,
    handleToggleWatchMode,
    startDryRun,
    handleDryRun,
    handleDelete,
    handleEditorClose,
    handleCancelConfirm,
    handleOpenConflictSession,
  };
}
