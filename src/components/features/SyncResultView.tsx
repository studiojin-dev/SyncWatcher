import { useMemo } from 'react';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconPlayerStop,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../hooks/useSettings';
import { useSyncSession } from '../../hooks/useSyncTaskStatus';
import ResultTreeTable, { type ResultTreeEntry } from './ResultTreeTable';
import { formatBytes } from '../../utils/formatBytes';

interface SyncResultViewProps {
  taskId: string;
  taskName: string;
  onBack: () => void;
  onRequestCancel?: () => void;
  onRequestRerun?: () => void;
}

function getStatusLabel(
  status: 'running' | 'completed' | 'cancelled' | 'failed',
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (status) {
    case 'running':
      return t('sync.statusRunning', { defaultValue: 'Running' });
    case 'completed':
      return t('sync.statusCompleted', { defaultValue: 'Completed' });
    case 'cancelled':
      return t('sync.statusCancelled', { defaultValue: 'Cancelled' });
    case 'failed':
      return t('sync.statusFailed', { defaultValue: 'Failed' });
    default:
      return status;
  }
}

function getPhaseLabel(
  phase: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (phase) {
    case 'scanningSource':
      return t('sync.phaseScanningSource', {
        defaultValue: 'Scanning source',
      });
    case 'scanningTarget':
      return t('sync.phaseScanningTarget', {
        defaultValue: 'Scanning target',
      });
    case 'comparing':
      return t('sync.phaseComparing', {
        defaultValue: 'Comparing',
      });
    case 'validatingDryRun':
      return t('sync.phaseValidatingDryRun', {
        defaultValue: 'Validating cached Dry Run',
      });
    case 'copying':
      return t('sync.phaseCopying', {
        defaultValue: 'Copying',
      });
    default:
      return t('sync.phasePending', {
        defaultValue: 'Preparing',
      });
  }
}

export default function SyncResultView({
  taskId,
  taskName,
  onBack,
  onRequestCancel,
  onRequestRerun,
}: SyncResultViewProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const session = useSyncSession(taskId);
  const result = session?.result ?? {
    entries: [],
    files_copied: 0,
    bytes_copied: 0,
    errors: [],
    conflictCount: 0,
    hasPendingConflicts: false,
    targetPreflight: null,
  };
  const status = session?.status ?? 'running';
  const progress = session?.progress;
  const isRunning = status === 'running';
  const isFinished =
    status === 'completed' || status === 'cancelled' || status === 'failed';
  const showEmptyState = result.entries.length === 0 && !isRunning;
  const overallPercent =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round(((progress.processedBytes || 0) / progress.totalBytes) * 100),
        )
      : progress?.total && progress.total > 0
        ? Math.min(100, Math.round(((progress.current || 0) / progress.total) * 100))
        : null;
  const entries = useMemo<ResultTreeEntry[]>(
    () =>
      result.entries.map((entry) => ({
        path: entry.path,
        typeLabel:
          entry.status === 'failed'
            ? t('sync.fileFailed', { defaultValue: 'Failed' })
            : entry.kind === 'New'
              ? t('sync.fileCopiedNew', { defaultValue: 'Copied (New)' })
              : t('sync.fileCopiedModified', { defaultValue: 'Copied (Modified)' }),
        sourceSize: entry.source_size,
        targetSize: entry.target_size,
        icon:
          entry.status === 'failed'
            ? 'failed'
            : entry.kind === 'New'
              ? 'new'
              : 'modified',
        tone: entry.status === 'failed' ? 'error' : 'default',
      })),
    [result.entries, t],
  );

  return (
    <div className="neo-box p-5 bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-heading font-bold uppercase">
              {t('syncTasks.startSync')} · {taskName}
            </h2>
            <span
              className={`px-2 py-1 border-2 text-[10px] font-mono uppercase ${
                status === 'running'
                  ? 'bg-[var(--color-accent-warning)] border-[var(--border-main)]'
                  : status === 'completed'
                    ? 'bg-[var(--accent-success)] text-white border-[var(--border-main)]'
                    : status === 'cancelled'
                      ? 'bg-[var(--bg-tertiary)] border-[var(--border-main)]'
                      : 'bg-[var(--color-accent-error)] text-white border-[var(--border-main)]'
              }`}
            >
              {getStatusLabel(status, t)}
            </span>
          </div>
          <p className="text-xs font-mono text-[var(--text-secondary)]">
            {result.entries.length} {result.entries.length === 1 ? 'ENTRY' : 'ENTRIES'}
          </p>
          {isRunning && progress ? (
            <p className="text-xs font-mono text-[var(--text-secondary)]">
              {getPhaseLabel(progress.phase, t)}
              {progress.message ? ` · ${progress.message}` : ''}
              {overallPercent !== null ? ` · ${overallPercent}%` : ''}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isRunning && onRequestCancel ? (
            <button
              type="button"
              onClick={onRequestCancel}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs bg-[var(--color-accent-warning)] hover:opacity-90 inline-flex items-center gap-1"
            >
              <IconPlayerStop size={14} />
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
          ) : null}
          {isFinished && onRequestRerun ? (
            <button
              type="button"
              onClick={onRequestRerun}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs bg-[var(--accent-main)] text-white hover:opacity-90 inline-flex items-center gap-1"
            >
              {t('common.retry', { defaultValue: 'Run Again' })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onBack}
            className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)] inline-flex items-center gap-1"
          >
            <IconArrowLeft size={14} />
            {t('common.back', { defaultValue: 'Back' })}
          </button>
        </div>
      </div>

      {session?.error && isFinished ? (
        <div className="flex items-start gap-2 border-2 border-[var(--border-main)] bg-[var(--color-accent-error)]/15 px-3 py-3 text-sm">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>{session.error}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('sync.filesCopied', { defaultValue: 'Files Copied' })}
          </p>
          <p className="font-bold text-lg">{result.files_copied}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('sync.bytesCopied', { defaultValue: 'Bytes Copied' })}
          </p>
          <p className="font-bold text-lg">
            {formatBytes(result.bytes_copied, settings.dataUnitSystem)}
          </p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('sync.errorCount', { defaultValue: 'Errors' })}
          </p>
          <p className="font-bold text-lg">{result.errors.length}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('sync.conflictCount', { defaultValue: 'Conflicts' })}
          </p>
          <p className="font-bold text-lg">{result.conflictCount}</p>
        </div>
      </div>

      {isRunning && progress ? (
        <div className="space-y-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
          <div className="flex items-center justify-between gap-3 text-xs font-mono text-[var(--text-secondary)]">
            <span>{getPhaseLabel(progress.phase, t)}</span>
            <span>
              {overallPercent !== null
                ? `${overallPercent}%`
                : t('sync.statusRunning', { defaultValue: 'Running' })}
            </span>
          </div>
          <div className="h-2 border border-[var(--border-main)] bg-[var(--bg-primary)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent-main)] transition-[width] duration-300"
              style={{ width: `${overallPercent ?? 12}%` }}
            />
          </div>
          {progress.message ? (
            <div className="text-xs font-mono text-[var(--text-secondary)] break-all">
              {progress.message}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
        {showEmptyState ? (
          <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">
            {t('sync.noEntries', { defaultValue: 'No copied files recorded.' })}
          </div>
        ) : result.entries.length === 0 ? (
          <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">
            {isRunning
              ? getPhaseLabel(progress?.phase, t)
              : t('sync.noEntries', { defaultValue: 'No copied files recorded.' })}
          </div>
        ) : (
          <ResultTreeTable
            entries={entries}
            unitSystem={settings.dataUnitSystem}
            t={t}
          />
        )}
      </div>
    </div>
  );
}
