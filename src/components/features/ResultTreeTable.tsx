import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconFileCode,
  IconFilePlus,
  IconFolder,
} from '@tabler/icons-react';
import { formatBytes, type DataUnitSystem } from '../../utils/formatBytes';
import {
  appendResultTreeEntries,
  flattenVisibleRows,
  formatDisplaySize,
  rebuildResultTreeState,
  type ResultTreeEntry,
  type ResultTreeRow,
  type ResultTreeState,
} from './resultTreeState';

export type { ResultTreeEntry, ResultTreeState } from './resultTreeState';

interface ResultTreeTableProps {
  entries: ResultTreeEntry[];
  unitSystem: DataUnitSystem;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function fileIcon(icon: ResultTreeEntry['icon']) {
  switch (icon) {
    case 'new':
      return <IconFilePlus size={14} className="mt-0.5 shrink-0" />;
    case 'failed':
      return <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />;
    case 'modified':
    default:
      return <IconFileCode size={14} className="mt-0.5 shrink-0" />;
  }
}

function canAppendIncrementally(
  previousEntries: ResultTreeEntry[],
  nextEntries: ResultTreeEntry[],
): boolean {
  if (previousEntries.length === 0 || nextEntries.length < previousEntries.length) {
    return false;
  }

  for (let index = 0; index < previousEntries.length; index += 1) {
    if (previousEntries[index] !== nextEntries[index]) {
      return false;
    }
  }

  return true;
}

interface ResultTreeRowViewProps {
  row: ResultTreeRow;
  treeState: ResultTreeState;
  collapsedPaths: Set<string>;
  unitSystem: DataUnitSystem;
  t: (key: string, options?: Record<string, unknown>) => string;
  toggleNode: (path: string) => void;
}

const ResultTreeRowView = memo(function ResultTreeRowView({
  row,
  treeState,
  collapsedPaths,
  unitSystem,
  t,
  toggleNode,
}: ResultTreeRowViewProps) {
  const node = treeState.nodes.get(row.nodeId);
  if (!node) {
    return null;
  }

  const entry = node.entry;
  const isCollapsed = node.isDir && collapsedPaths.has(node.fullPath);
  const toneClass =
    entry?.tone === 'error'
      ? 'text-[var(--color-accent-error)]'
      : 'text-[var(--text-secondary)]';

  return (
    <div
      data-testid={`result-tree-row-${node.fullPath}`}
      className="grid grid-cols-[minmax(0,1fr)_90px_120px_120px] gap-2 px-3 py-2 text-xs font-mono border-b border-dashed border-[var(--border-main)]"
    >
      <div
        className={`min-w-0 flex items-center gap-2 ${node.isDir ? 'cursor-pointer' : ''}`}
        style={{ paddingLeft: `${row.depth * 16}px` }}
        onClick={node.isDir ? () => toggleNode(node.fullPath) : undefined}
      >
        {node.isDir ? (
          <button
            type="button"
            aria-label={t(
              isCollapsed ? 'common.expandDirectory' : 'common.collapseDirectory',
              {
                name: node.name,
                defaultValue: isCollapsed
                  ? 'Expand {{name}}'
                  : 'Collapse {{name}}',
              },
            )}
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
        ) : (
          fileIcon(entry?.icon ?? 'modified')
        )}
        <span className="break-all">{node.name}</span>
      </div>
      <div className="truncate text-[var(--text-secondary)]">
        {node.isDir ? node.aggregateCount : entry?.typeLabel ?? '-'}
      </div>
      <div className={node.isDir ? 'truncate text-[var(--text-secondary)]' : `truncate ${toneClass}`}>
        {node.isDir
          ? formatBytes(node.aggregateSourceSize, unitSystem)
          : formatDisplaySize(entry?.sourceSize, unitSystem, formatBytes)}
      </div>
      <div className={node.isDir ? 'truncate text-[var(--text-secondary)]' : `truncate ${toneClass}`}>
        {node.isDir
          ? formatBytes(node.aggregateTargetSize, unitSystem)
          : formatDisplaySize(entry?.targetSize, unitSystem, formatBytes)}
      </div>
    </div>
  );
});

export default function ResultTreeTable({
  entries,
  unitSystem,
  t,
}: ResultTreeTableProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const previousEntriesRef = useRef<ResultTreeEntry[]>([]);
  const [treeState, setTreeState] = useState<ResultTreeState>(() =>
    rebuildResultTreeState(entries),
  );

  useEffect(() => {
    const previousEntries = previousEntriesRef.current;

    if (entries.length === 0) {
      setTreeState(rebuildResultTreeState([]));
      setCollapsedPaths(new Set());
      previousEntriesRef.current = [];
      return;
    }

    if (canAppendIncrementally(previousEntries, entries)) {
      const appendedEntries = entries.slice(previousEntries.length);
      setTreeState((previousState) =>
        appendResultTreeEntries(previousState, appendedEntries),
      );
    } else {
      setTreeState(rebuildResultTreeState(entries));
      setCollapsedPaths(new Set());
    }

    previousEntriesRef.current = entries;
  }, [entries]);

  const visibleRows = useMemo(
    () => flattenVisibleRows(treeState, collapsedPaths),
    [treeState.treeVersion, treeState, collapsedPaths],
  );

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

  return (
    <div className="h-[420px] overflow-hidden">
      <div className="grid grid-cols-[minmax(0,1fr)_90px_120px_120px] gap-2 px-3 py-2 border-b-2 border-[var(--border-main)] text-[10px] font-mono uppercase bg-[var(--bg-tertiary)]">
        <span>{t('dryRun.colPath', { defaultValue: 'Path' })}</span>
        <span>{t('dryRun.colType', { defaultValue: 'Type' })}</span>
        <span>{t('dryRun.colSourceSize', { defaultValue: 'Source Size' })}</span>
        <span>{t('dryRun.colTargetSize', { defaultValue: 'Target Size' })}</span>
      </div>
      <Virtuoso
        style={{ height: 'calc(100% - 33px)' }}
        data={visibleRows}
        computeItemKey={(_index, row) => row.key}
        itemContent={(_index, row) => (
          <ResultTreeRowView
            row={row}
            treeState={treeState}
            collapsedPaths={collapsedPaths}
            unitSystem={unitSystem}
            t={t}
            toggleNode={toggleNode}
          />
        )}
      />
    </div>
  );
}
