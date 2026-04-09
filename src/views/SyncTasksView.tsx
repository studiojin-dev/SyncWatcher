import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@tabler/icons-react';
import { SyncTask } from '../hooks/useSyncTasks';
import { useSyncTasksContext } from '../context/SyncTasksContext';
import { useExclusionSetsContext } from '../context/ExclusionSetsContext';
import { useSyncTaskStatusStore } from '../hooks/useSyncTaskStatus';
import { useSettings } from '../hooks/useSettings';
import { FadeIn } from '../components/ui/Animations';
import { useToast } from '../components/ui/Toast';
import YamlEditorModal from '../components/ui/YamlEditorModal';
import TaskLogsModal from '../components/features/TaskLogsModal';
import OrphanFilesModal from '../components/features/OrphanFilesModal';
import DryRunResultView from '../components/features/DryRunResultView';
import SyncResultView from '../components/features/SyncResultView';
import CancelConfirmModal from '../components/ui/CancelConfirmModal';
import SyncTaskValidationErrorModal from '../components/features/SyncTaskValidationErrorModal';
import type { RuntimeTaskValidationIssue } from '../types/runtime';
import SyncTaskFormModal from './sync-tasks/SyncTaskFormModal';
import SyncTaskList from './sync-tasks/SyncTaskList';
import {
  getValidationRuleDescription,
  getValidationSummary,
  type SubView,
} from './sync-tasks/helpers';
import { useSyncTaskActions } from './sync-tasks/useSyncTaskActions';
import { useSyncTaskFormController } from './sync-tasks/useSyncTaskFormController';

interface SyncTasksViewProps {
  requestedEditTaskId?: string | null;
  onRequestedEditTaskHandled?: () => void;
  onRequestSourceRecommendationReview?: (taskId: string) => void;
}

function SyncTasksView({
  requestedEditTaskId,
  onRequestedEditTaskHandled,
  onRequestSourceRecommendationReview,
}: SyncTasksViewProps) {
  const { t } = useTranslation();
  const { tasks, addTask, updateTask, deleteTask, error, reload } =
    useSyncTasksContext();
  const { sets, getPatternsForSets } = useExclusionSetsContext();
  const { settings } = useSettings();
  const { showToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<SyncTask | null>(null);
  const [validationErrorModal, setValidationErrorModal] =
    useState<RuntimeTaskValidationIssue | null>(null);
  const [subView, setSubView] = useState<SubView>({ kind: 'list' });

  const {
    statuses,
    watchingTaskIds,
    queuedTaskIds,
    dryRunSessions,
    syncSessions,
    clearDryRunSession,
    clearSyncSession,
  } = useSyncTaskStatusStore();

  const form = useSyncTaskFormController({
    editingTask,
    showForm,
    dataUnitSystem: settings.dataUnitSystem,
    showToast,
    t,
  });

  const actions = useSyncTaskActions({
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
  });
  const {
    cancelConfirm,
    cancelPendingSync,
    cancelPendingDryRun,
    clearCancelConfirm,
    closeForm,
    confirmPendingSync,
    confirmPendingDryRun,
    conflictSessions,
    conflictSessionsLoading,
    handleCancelConfirm,
    handleDelete,
    handleDryRun,
    handleEditorClose,
    handleOpenConflictSession,
    handleSubmit,
    handleSync,
    handleToggleWatchMode,
    loadConflictSessions,
    openCreateForm,
    openEditTask,
    openLogsView,
    openOrphansView,
    pendingSyncRequest,
    pendingDryRunTask,
    requestCancel,
    savingTask,
    startSync,
    startSyncFromDryRun,
    startDryRun,
    syncing,
    watchTogglePendingIds,
  } = actions;

  useEffect(() => {
    const taskIds = new Set(tasks.map((task) => task.id));

    for (const taskId of dryRunSessions.keys()) {
      if (!taskIds.has(taskId)) {
        clearDryRunSession(taskId);
      }
    }

    for (const taskId of syncSessions.keys()) {
      if (!taskIds.has(taskId)) {
        clearSyncSession(taskId);
      }
    }

    if (
      (subView.kind === 'dryRun' || subView.kind === 'sync') &&
      !taskIds.has(subView.taskId)
    ) {
      setSubView({ kind: 'list' });
    }
  }, [
    clearDryRunSession,
    clearSyncSession,
    dryRunSessions,
    subView,
    syncSessions,
    tasks,
  ]);

  useEffect(() => {
    if (!requestedEditTaskId) {
      return;
    }

    const requestedTask =
      tasks.find((task) => task.id === requestedEditTaskId) ?? null;
    if (requestedTask) {
      setSubView({ kind: 'list' });
      openEditTask(requestedTask);
    }
    onRequestedEditTaskHandled?.();
  }, [
    openEditTask,
    onRequestedEditTaskHandled,
    requestedEditTaskId,
    tasks,
  ]);

  const activeDryRunTask = useMemo(
    () =>
      subView.kind === 'dryRun'
        ? tasks.find((task) => task.id === subView.taskId) ?? null
        : null,
    [subView, tasks],
  );

  const activeSyncTask = useMemo(
    () =>
      subView.kind === 'sync'
        ? tasks.find((task) => task.id === subView.taskId) ?? null
        : null,
    [subView, tasks],
  );

  return (
    <div className="space-y-8">
      {error ? (
        <YamlEditorModal
          opened={!!error}
          onClose={handleEditorClose}
          error={error}
        />
      ) : null}

      <CancelConfirmModal
        opened={!!cancelConfirm}
        onConfirm={handleCancelConfirm}
        onCancel={clearCancelConfirm}
        title={
          cancelConfirm?.type === 'sync'
            ? t('syncTasks.cancelSync', { defaultValue: '동기화 취소' })
            : t('syncTasks.cancelDryRun', { defaultValue: 'Dry Run 취소' })
        }
        message={t('syncTasks.cancelConfirm', {
          defaultValue: '정말로 작업을 취소하시겠습니까?',
        })}
      />

      <CancelConfirmModal
        opened={!!pendingDryRunTask}
        onConfirm={() => {
          void confirmPendingDryRun();
        }}
        onCancel={cancelPendingDryRun}
        title={t('syncTasks.dryRun')}
        message={t('syncTasks.confirmDryRun', {
          defaultValue: 'Dry Run을 시작할까요?',
        })}
        confirmLabel={t('common.confirm', { defaultValue: '확인' })}
        cancelLabel={t('common.cancel', { defaultValue: '취소' })}
      />

      <CancelConfirmModal
        opened={!!pendingSyncRequest}
        onConfirm={() => {
          void confirmPendingSync();
        }}
        onCancel={cancelPendingSync}
        title={
          pendingSyncRequest?.mode === 'dryRunArtifact'
            ? t('syncTasks.syncNowFromDryRun', {
                defaultValue: 'Sync Now',
              })
            : t('syncTasks.startSync')
        }
        message={
          pendingSyncRequest?.mode === 'dryRunArtifact'
            ? t('syncTasks.confirmSyncNowFromDryRun', {
                defaultValue:
                  'Use the latest Dry Run result and start syncing now?',
              })
            : t('syncTasks.confirmStartSync', {
                defaultValue: '지금 동기화를 시작할까요?',
              })
        }
        confirmLabel={t('common.confirm', { defaultValue: '확인' })}
        cancelLabel={t('common.cancel', { defaultValue: '취소' })}
      />

      <SyncTaskValidationErrorModal
        opened={!!validationErrorModal}
        issue={validationErrorModal}
        summary={
          validationErrorModal
            ? getValidationSummary(validationErrorModal, t)
            : ''
        }
        ruleDescription={
          validationErrorModal
            ? getValidationRuleDescription(validationErrorModal, t)
            : ''
        }
        onClose={() => setValidationErrorModal(null)}
      />

      <FadeIn>
        <header className="flex justify-between items-center mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
          <div>
            <h1 className="text-2xl font-heading font-bold uppercase mb-1">
              {t('syncTasks.title')}
            </h1>
            <p className="text-[var(--text-secondary)] font-mono text-sm">
              {tasks.length > 0
                ? `// ${tasks.length} ACTIVE_TASKS`
                : '// NO_TASKS_DEFINED'}
            </p>
          </div>
          <button
            className="bg-[var(--accent-main)] text-white px-4 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold flex items-center gap-2 active:shadow-[2px_2px_0_0_var(--shadow-color)] transition-all"
            onClick={openCreateForm}
          >
            <IconPlus size={20} stroke={3} />
            {t('syncTasks.addTask')}
          </button>
        </header>
      </FadeIn>

      <SyncTaskFormModal
        opened={showForm}
        editingTask={editingTask}
        form={form}
        sets={sets}
        savingTask={savingTask}
        onClose={closeForm}
        onSubmit={handleSubmit}
        t={t}
      />

      {subView.kind === 'logs' ? (
        <TaskLogsModal
          taskId={subView.taskId}
          taskName={subView.taskName}
          onBack={() => setSubView({ kind: 'list' })}
        />
      ) : null}

      {subView.kind === 'orphans' ? (
        <OrphanFilesModal
          taskId={subView.taskId}
          source={subView.source}
          target={subView.target}
          excludePatterns={subView.excludePatterns}
          onBack={() => setSubView({ kind: 'list' })}
        />
      ) : null}

      {subView.kind === 'dryRun' ? (
        <DryRunResultView
          taskId={subView.taskId}
          taskName={subView.taskName}
          onBack={() => setSubView({ kind: 'list' })}
          onRequestCancel={() => requestCancel('dryRun', subView.taskId)}
          onRequestSyncNow={
            activeDryRunTask
              ? () => {
                  startSyncFromDryRun(activeDryRunTask);
                }
              : undefined
          }
          onRequestRerun={
            activeDryRunTask
              ? () => {
                  void startDryRun(activeDryRunTask);
                }
              : undefined
          }
        />
      ) : null}

      {subView.kind === 'sync' ? (
        <SyncResultView
          taskId={subView.taskId}
          taskName={subView.taskName}
          onBack={() => setSubView({ kind: 'list' })}
          onRequestCancel={() => requestCancel('sync', subView.taskId)}
          onRequestRerun={
            activeSyncTask
              ? () => {
                  void startSync(activeSyncTask);
                }
              : undefined
          }
        />
      ) : null}

      {subView.kind === 'list' ? (
        <SyncTaskList
          tasks={tasks}
          statuses={statuses}
          dryRunSessions={dryRunSessions}
          watchingTaskIds={watchingTaskIds}
          queuedTaskIds={queuedTaskIds}
          watchTogglePendingIds={watchTogglePendingIds}
          syncing={syncing}
          conflictSessions={conflictSessions}
          conflictSessionsLoading={conflictSessionsLoading}
          dataUnitSystem={settings.dataUnitSystem}
          getPatternsForSets={getPatternsForSets}
          t={t}
          onRefreshConflictSessions={() => {
            void loadConflictSessions();
          }}
          onOpenConflictSession={(sessionId) => {
            void handleOpenConflictSession(sessionId);
          }}
          onDryRun={(task) => {
            void handleDryRun(task);
          }}
          onSync={(task) => {
            void handleSync(task);
          }}
          onToggleWatchMode={(task) => {
            void handleToggleWatchMode(task);
          }}
          onEditTask={openEditTask}
          onDeleteTask={(task) => {
            void handleDelete(task);
          }}
          onShowOrphans={(task, excludePatterns) => {
            void openOrphansView(task, excludePatterns);
          }}
          onShowLogs={openLogsView}
        />
      ) : null}
    </div>
  );
}

export default SyncTasksView;
