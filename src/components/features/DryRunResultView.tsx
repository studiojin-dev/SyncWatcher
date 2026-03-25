import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFilePlus,
  IconFileCode,
  IconPlayerStop,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../hooks/useSettings';
import { useDryRunSession } from '../../hooks/useSyncTaskStatus';
import type { DryRunSessionState, FileDiff } from '../../types/syncEngine';
import { formatBytes } from '../../utils/formatBytes';

interface DryRunResultViewProps {
  taskId: string;
  taskName: string;
  onBack: () => void;
  onRequestCancel?: () => void;
  onRequestRerun?: () => void;
}

interface DryRunTreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  children: DryRunTreeNode[];
  diff?: FileDiff;
}

function buildDiffTree(diffs: FileDiff[]): DryRunTreeNode[] {
  interface InternalNode extends DryRunTreeNode {
    childrenMap: Map<string, InternalNode>;
  }

  const root = new Map<string, InternalNode>();

  for (const diff of diffs) {
    const parts = diff.path.split('/').filter(Boolean);
    let current = root;
    let accum = '';

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      accum = accum ? `${accum}/${part}` : part;
      const isLast = index === parts.length - 1;
      const existing = current.get(part);
      const node: InternalNode = existing ?? {
        name: part,
        fullPath: accum,
        isDir: !isLast,
        children: [],
        childrenMap: new Map<string, InternalNode>(),
      };

      if (isLast) {
        node.isDir = false;
        node.diff = diff;
      }

      if (!existing) {
        current.set(part, node);
      }

      current = node.childrenMap;
    }
  }

  const sortNodes = (nodes: InternalNode[]): DryRunTreeNode[] =>
    [...nodes]
      .sort((left, right) => {
        if (left.isDir !== right.isDir) {
          return left.isDir ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((node) => {
        const { childrenMap, ...rest } = node;
        return {
          ...rest,
          children: sortNodes(Array.from(childrenMap.values())),
        };
      });

  return sortNodes(Array.from(root.values()));
}

function renderTree(
  nodes: DryRunTreeNode[],
  depth: number,
  collapsedPaths: Set<string>,
  toggleNode: (path: string) => void,
  unitSystem: 'binary' | 'decimal',
  t: (key: string, options?: Record<string, unknown>) => string,
): ReactElement[] {
  const rows: ReactElement[] = [];

  for (const node of nodes) {
    const diff = node.diff;
    const isFile = !node.isDir && diff !== undefined;
    const isCollapsed = node.isDir && collapsedPaths.has(node.fullPath);

    rows.push(
      <div key={node.fullPath}>
        <div className="grid grid-cols-[minmax(0,1fr)_90px_120px_120px] gap-2 px-3 py-2 text-xs font-mono border-b border-dashed border-[var(--border-main)]">
          <div
            className={`min-w-0 flex items-center gap-2 ${node.isDir ? 'cursor-pointer' : ''}`}
            style={{ paddingLeft: `${depth * 16}px` }}
            onClick={node.isDir ? () => toggleNode(node.fullPath) : undefined}
          >
            {node.isDir ? (
              <button
                type="button"
                aria-label={t(isCollapsed ? 'common.expandDirectory' : 'common.collapseDirectory', { name: node.name, defaultValue: isCollapsed ? 'Expand {{name}}' : 'Collapse {{name}}' })}
                className="shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleNode(node.fullPath);
                }}
              >
                {isCollapsed ? (
                  <IconChevronRight size={14} className="mt-0.5" />
                ) : (
                  <IconChevronDown size={14} className="mt-0.5" />
                )}
              </button>
            ) : (
              <span className="w-[14px] shrink-0" />
            )}
            {node.isDir ? (
              <IconFolder size={14} className="mt-0.5 shrink-0" />
            ) : diff?.kind === 'New' ? (
              <IconFilePlus size={14} className="mt-0.5 shrink-0" />
            ) : (
              <IconFileCode size={14} className="mt-0.5 shrink-0" />
            )}
            <span className="break-all">{node.name}</span>
          </div>
          <div className="truncate text-[var(--text-secondary)]">
            {isFile
              ? diff.kind === 'New'
                ? t('dryRun.newFile')
                : t('dryRun.modifiedFile')
              : '-'}
          </div>
          <div className="truncate text-[var(--text-secondary)]">
            {isFile && diff.source_size !== null
              ? formatBytes(diff.source_size, unitSystem)
              : '-'}
          </div>
          <div className="truncate text-[var(--text-secondary)]">
            {isFile && diff.target_size !== null
              ? formatBytes(diff.target_size, unitSystem)
              : '-'}
          </div>
        </div>
        {node.children.length > 0 && !isCollapsed
          ? renderTree(
              node.children,
              depth + 1,
              collapsedPaths,
              toggleNode,
              unitSystem,
              t,
            )
          : null}
      </div>,
    );
  }

  return rows;
}

function getStatusLabel(
  status: DryRunSessionState['status'],
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (status) {
    case 'running':
      return t('dryRun.statusRunning', { defaultValue: 'Running' });
    case 'completed':
      return t('dryRun.statusCompleted', { defaultValue: 'Completed' });
    case 'cancelled':
      return t('dryRun.statusCancelled', { defaultValue: 'Cancelled' });
    case 'failed':
      return t('dryRun.statusFailed', { defaultValue: 'Failed' });
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
      return t('dryRun.phaseScanningSource', { defaultValue: 'Scanning source' });
    case 'scanningTarget':
      return t('dryRun.phaseScanningTarget', { defaultValue: 'Scanning target' });
    case 'comparing':
      return t('dryRun.phaseComparing', { defaultValue: 'Comparing' });
    default:
      return phase || t('dryRun.phasePending', { defaultValue: 'Preparing' });
  }
}

export default function DryRunResultView({
  taskId,
  taskName,
  onBack,
  onRequestCancel,
  onRequestRerun,
}: DryRunResultViewProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const session = useDryRunSession(taskId);
  const result = session?.result ?? {
    diffs: [],
    total_files: 0,
    files_to_copy: 0,
    files_modified: 0,
    bytes_to_copy: 0,
    targetPreflight: null,
  };
  const status = session?.status ?? 'running';
  const progress = session?.progress;
  const showTargetPreviewWarning =
    result.targetPreflight?.kind === 'willCreateDirectory';
  const isRunning = status === 'running';
  const isFinished =
    status === 'completed' || status === 'cancelled' || status === 'failed';
  const showEmptyState = result.diffs.length === 0 && !isRunning;
  const diffTree = useMemo(() => buildDiffTree(result.diffs), [result.diffs]);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCollapsedPaths(new Set());
  }, [result.diffs]);

  const toggleNode = (path: string) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const overallPercent =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round(((progress.processedBytes || 0) / progress.totalBytes) * 100),
        )
      : progress?.total && progress.total > 0
        ? Math.min(100, Math.round(((progress.current || 0) / progress.total) * 100))
        : null;

  return (
    <div className="neo-box p-5 bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-heading font-bold uppercase">
              {t('syncTasks.dryRun')} · {taskName}
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
            {result.diffs.length} {result.diffs.length === 1 ? 'DIFF' : 'DIFFS'}
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

      {showTargetPreviewWarning ? (
        <div className="flex items-start gap-2 border-2 border-[var(--border-main)] bg-[var(--color-accent-warning)]/20 px-3 py-3 text-sm">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>
            {t('dryRun.targetWillBeCreatedBanner', {
              path: result.targetPreflight?.path ?? '',
              defaultValue:
                "Target directory doesn't exist yet. Dry Run is previewing it as empty, so items can appear as New and Target Size stays blank until sync creates {{path}}.",
            })}
          </p>
        </div>
      ) : null}

      {session?.error && isFinished ? (
        <div className="flex items-start gap-2 border-2 border-[var(--border-main)] bg-[var(--color-accent-error)]/15 px-3 py-3 text-sm">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>{session.error}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('dryRun.totalFiles')}
          </p>
          <p className="font-bold text-lg">{result.total_files}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('dryRun.filesToCopy')}
          </p>
          <p className="font-bold text-lg">{result.files_to_copy}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('dryRun.filesModified')}
          </p>
          <p className="font-bold text-lg">{result.files_modified}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
            {t('dryRun.bytesToCopy')}
          </p>
          <p className="font-bold text-lg">
            {formatBytes(result.bytes_to_copy, settings.dataUnitSystem)}
          </p>
        </div>
      </div>

      {isRunning && progress ? (
        <div className="space-y-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
          <div className="flex items-center justify-between gap-3 text-xs font-mono text-[var(--text-secondary)]">
            <span>{getPhaseLabel(progress.phase, t)}</span>
            <span>
              {overallPercent !== null
                ? `${overallPercent}%`
                : t('dryRun.statusRunning', { defaultValue: 'Running' })}
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

      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] overflow-auto max-h-[420px]">
        {showEmptyState ? (
          <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">
            {t('dryRun.noChanges')}
          </div>
        ) : result.diffs.length === 0 ? (
          <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">
            {isRunning
              ? t('dryRun.scanning', { defaultValue: 'Scanning...' })
              : t('dryRun.noChanges')}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[minmax(0,1fr)_90px_120px_120px] gap-2 px-3 py-2 border-b-2 border-[var(--border-main)] text-[10px] font-mono uppercase bg-[var(--bg-tertiary)]">
              <span>{t('dryRun.colPath', { defaultValue: 'Path' })}</span>
              <span>{t('dryRun.colType', { defaultValue: 'Type' })}</span>
              <span>{t('dryRun.colSourceSize', { defaultValue: 'Source Size' })}</span>
              <span>{t('dryRun.colTargetSize', { defaultValue: 'Target Size' })}</span>
            </div>
            {renderTree(
              diffTree,
              0,
              collapsedPaths,
              toggleNode,
              settings.dataUnitSystem,
              t,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
