import {
  IconDisc,
  IconEye,
  IconFlask,
  IconGhost,
  IconList,
  IconPlayerPlay,
  IconPlayerStop,
} from '@tabler/icons-react';
import { CardAnimation } from '../../components/ui/Animations';
import ConflictSessionListPanel from '../../components/features/ConflictSessionListPanel';
import { formatBytes, type DataUnitSystem } from '../../utils/formatBytes';
import type { SyncTask } from '../../hooks/useSyncTasks';
import type { TaskStatus } from '../../hooks/useSyncTaskStatus';
import type {
  ConflictSessionSummary,
  DryRunSessionState,
} from '../../types/syncEngine';
import type { TranslateFn } from './helpers';

interface SyncTaskListProps {
  tasks: SyncTask[];
  statuses: Map<string, TaskStatus>;
  dryRunSessions: Map<string, DryRunSessionState>;
  watchingTaskIds: Set<string>;
  queuedTaskIds: Set<string>;
  watchTogglePendingIds: Set<string>;
  syncing: string | null;
  conflictSessions: ConflictSessionSummary[];
  conflictSessionsLoading: boolean;
  dataUnitSystem: DataUnitSystem;
  getPatternsForSets: (setIds: string[]) => string[];
  t: TranslateFn;
  onRefreshConflictSessions: () => void;
  onOpenConflictSession: (sessionId: string) => void;
  onDryRun: (task: SyncTask) => void;
  onSync: (task: SyncTask) => void;
  onToggleWatchMode: (task: SyncTask) => void;
  onEditTask: (task: SyncTask) => void;
  onDeleteTask: (task: SyncTask) => void;
  onShowOrphans: (task: SyncTask, excludePatterns: string[]) => void;
  onShowLogs: (task: SyncTask) => void;
}

function renderLastLog(
  taskStatus: TaskStatus | undefined,
  dataUnitSystem: DataUnitSystem,
) {
  const progress = taskStatus?.progress;
  let progressSuffix = '';

  if (progress) {
    const overallPercent =
      progress.totalBytes && progress.totalBytes > 0
        ? Math.min(
            100,
            Math.round(
              ((progress.processedBytes || 0) / progress.totalBytes) * 100,
            ),
          )
        : progress.total > 0
          ? Math.min(
              100,
              Math.round((progress.current / progress.total) * 100),
            )
          : 0;
    const currentFileSize = progress.currentFileTotalBytes || 0;
    const currentFilePercent =
      currentFileSize > 0
        ? Math.min(
            100,
            Math.round(
              ((progress.currentFileBytesCopied || 0) / currentFileSize) * 100,
            ),
          )
        : 0;

    if (currentFileSize > 0) {
      progressSuffix = ` | ${formatBytes(currentFileSize, dataUnitSystem)} • ${currentFilePercent}% • ${overallPercent}%`;
    } else if (overallPercent > 0) {
      progressSuffix = ` | ${overallPercent}%`;
    }
  }

  if (!taskStatus?.lastLog) {
    return (
      <span className="text-[var(--text-secondary)] opacity-50 shrink-0">
        Waiting for logs...
      </span>
    );
  }

  const renderedMessage = `${taskStatus.lastLog.message}${progressSuffix}`;
  const toneClass =
    taskStatus.lastLog.level === 'success'
      ? 'text-[var(--accent-success)]'
      : taskStatus.lastLog.level === 'error'
        ? 'text-[var(--color-accent-error)]'
        : taskStatus.lastLog.level === 'warning'
          ? 'text-[var(--color-accent-warning)]'
          : 'text-[var(--text-primary)]';

  return (
    <div className="flex-1 min-w-0 flex items-center">
      <span className="text-[var(--text-secondary)] mr-2 shrink-0 whitespace-nowrap">
        [{taskStatus.lastLog.timestamp}]
      </span>
      <span className={`block truncate flex-1 min-w-0 ${toneClass}`} title={renderedMessage}>
        {renderedMessage}
      </span>
    </div>
  );
}

function SyncTaskList({
  tasks,
  statuses,
  dryRunSessions,
  watchingTaskIds,
  queuedTaskIds,
  watchTogglePendingIds,
  syncing,
  conflictSessions,
  conflictSessionsLoading,
  dataUnitSystem,
  getPatternsForSets,
  t,
  onRefreshConflictSessions,
  onOpenConflictSession,
  onDryRun,
  onSync,
  onToggleWatchMode,
  onEditTask,
  onDeleteTask,
  onShowOrphans,
  onShowLogs,
}: SyncTaskListProps) {
  return (
    <div className="grid gap-6">
      <ConflictSessionListPanel
        sessions={conflictSessions}
        loading={conflictSessionsLoading}
        onRefresh={onRefreshConflictSessions}
        onOpenSession={onOpenConflictSession}
      />
      {tasks.map((task, index) => {
        const taskStatus = statuses.get(task.id);
        const hasDryRunSession = dryRunSessions.has(task.id);
        const isDryRunning = taskStatus?.status === 'dryRunning';

        return (
          <CardAnimation key={task.id} index={index}>
            <div className="neo-box p-5 relative transition-opacity">
              <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                <div className="min-w-0 flex-1 w-full">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-heading font-black uppercase tracking-tight truncate">
                      {task.name}
                    </h3>
                    <div className="flex gap-1.5 items-center">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-bold border-2 transition-colors ${
                          task.checksumMode
                            ? 'border-black bg-[var(--color-accent-warning)] text-black'
                            : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                        }`}
                        title="Checksum Mode"
                      >
                        CHK
                      </span>
                      <span
                        className={`p-0.5 border-2 transition-colors flex items-center justify-center ${
                          task.watchMode
                            ? 'border-black bg-[var(--accent-success)] text-white'
                            : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                        }`}
                        title="Watch Mode"
                      >
                        <IconEye size={12} stroke={3} />
                      </span>
                      <span
                        className={`p-0.5 border-2 transition-colors flex items-center justify-center ${
                          task.autoUnmount
                            ? 'border-black bg-[var(--accent-main)] text-white'
                            : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                        }`}
                        title="Auto Unmount"
                      >
                        <IconDisc size={12} stroke={3} />
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 pb-2 shrink-0 md:self-start self-end mt-2 md:mt-0">
                    <button
                      className={`p-2 border-2 border-[var(--border-main)] transition-all ${
                        isDryRunning
                          ? 'bg-[var(--color-accent-warning)] animate-pulse'
                          : 'hover:bg-[var(--bg-tertiary)]'
                      }`}
                      onClick={() => onDryRun(task)}
                      title={
                        hasDryRunSession
                          ? t('syncTasks.dryRun')
                          : isDryRunning
                            ? t('common.cancel', { defaultValue: '취소' })
                            : t('syncTasks.dryRun')
                      }
                    >
                      {isDryRunning ? (
                        <IconPlayerStop size={20} stroke={2} />
                      ) : (
                        <IconFlask size={20} stroke={2} />
                      )}
                    </button>
                    <button
                      className={`p-2 border-2 border-[var(--border-main)] transition-all ${
                        syncing === task.id
                          ? 'bg-[var(--color-accent-error)] animate-pulse text-white'
                          : 'bg-[var(--accent-main)] text-white hover:shadow-[2px_2px_0_0_black]'
                      }`}
                      onClick={() => onSync(task)}
                      disabled={syncing !== null && syncing !== task.id}
                      title={
                        syncing === task.id
                          ? t('common.cancel', { defaultValue: '취소' })
                          : t('syncTasks.startSync')
                      }
                    >
                      {syncing === task.id ? (
                        <IconPlayerStop size={20} stroke={2} />
                      ) : (
                        <IconPlayerPlay size={20} stroke={2} />
                      )}
                    </button>
                    <button
                      className={`p-2 border-2 border-[var(--border-main)] transition-all ${
                        watchTogglePendingIds.has(task.id)
                          ? 'opacity-60 cursor-not-allowed'
                          : watchingTaskIds.has(task.id)
                            ? 'bg-[var(--accent-success)] text-white'
                            : 'hover:bg-[var(--bg-tertiary)]'
                      }`}
                      onClick={() => onToggleWatchMode(task)}
                      disabled={watchTogglePendingIds.has(task.id)}
                      title={
                        (task.watchMode ?? false)
                          ? t('syncTasks.watchToggleOff')
                          : t('syncTasks.watchToggleOn')
                      }
                    >
                      <IconEye size={20} stroke={2} />
                    </button>
                    {queuedTaskIds.has(task.id) ? (
                      <span className="px-2 py-1 text-[10px] font-bold border-2 border-[var(--border-main)] bg-[var(--color-accent-warning)] text-black">
                        QUEUED
                      </span>
                    ) : null}
                    <div className="w-[2px] h-auto bg-[var(--border-main)] mx-1"></div>
                    <button
                      className="px-3 py-1 font-bold font-mono text-xs border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]"
                      onClick={() => onEditTask(task)}
                    >
                      EDIT
                    </button>
                    <button
                      className="px-3 py-1 font-bold font-mono text-xs border-2 border-[var(--border-main)] hover:bg-[var(--color-accent-error)] hover:text-white transition-colors"
                      onClick={() => onDeleteTask(task)}
                    >
                      DEL
                    </button>
                    <button
                      className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                      onClick={() =>
                        onShowOrphans(
                          task,
                          getPatternsForSets(task.exclusionSets || []),
                        )
                      }
                      title={t('orphan.title', {
                        defaultValue: 'Orphan Files',
                      })}
                    >
                      <IconGhost size={20} stroke={2} />
                    </button>
                    <div className="w-[2px] h-auto bg-[var(--border-main)] mx-1"></div>
                    <button
                      className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                      onClick={() => onShowLogs(task)}
                      title="View Logs"
                    >
                      <IconList size={20} stroke={2} />
                    </button>
                  </div>
                  <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] mb-1 break-all">
                    <span className="font-bold text-[var(--accent-main)]">
                      SRC:
                    </span>{' '}
                    {task.source}
                  </div>
                  <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] break-all">
                    <span className="font-bold text-[var(--accent-success)]">
                      DST:
                    </span>{' '}
                    {task.target}
                  </div>
                  <div className="mt-2 h-8 px-2 border-2 border-dashed border-[var(--border-main)] bg-[var(--bg-tertiary)] font-mono text-xs flex items-center min-w-0 w-full overflow-hidden">
                    {renderLastLog(taskStatus, dataUnitSystem)}
                  </div>
                </div>
              </div>
            </div>
          </CardAnimation>
        );
      })}
    </div>
  );
}

export default SyncTaskList;
