import { IconArrowLeft, IconFilePlus, IconFileCode } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import { useSettings } from '../../hooks/useSettings';
import type { DryRunResult } from '../../types/syncEngine';
import { formatBytes } from '../../utils/formatBytes';

interface DryRunResultViewProps {
  taskName: string;
  result: DryRunResult;
  onBack: () => void;
}

export default function DryRunResultView({ taskName, result, onBack }: DryRunResultViewProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();

  return (
    <div className="neo-box p-5 bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-heading font-bold uppercase">{t('syncTasks.dryRun')} · {taskName}</h2>
          <p className="text-xs font-mono text-[var(--text-secondary)]">
            {result.diffs.length} {result.diffs.length === 1 ? 'DIFF' : 'DIFFS'}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)] inline-flex items-center gap-1"
        >
          <IconArrowLeft size={14} />
          {t('common.back', { defaultValue: 'Back' })}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">{t('dryRun.totalFiles')}</p>
          <p className="font-bold text-lg">{result.total_files}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">{t('dryRun.filesToCopy')}</p>
          <p className="font-bold text-lg">{result.files_to_copy}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">{t('dryRun.filesModified')}</p>
          <p className="font-bold text-lg">{result.files_modified}</p>
        </div>
        <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
          <p className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">{t('dryRun.bytesToCopy')}</p>
          <p className="font-bold text-lg">{formatBytes(result.bytes_to_copy, settings.dataUnitSystem)}</p>
        </div>
      </div>

      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_140px_130px_130px] gap-2 px-3 py-2 border-b-2 border-[var(--border-main)] text-[10px] font-mono uppercase bg-[var(--bg-tertiary)]">
          <span>{t('dryRun.colPath', { defaultValue: 'Path' })}</span>
          <span>{t('dryRun.colType', { defaultValue: 'Type' })}</span>
          <span>{t('dryRun.colSourceSize', { defaultValue: 'Source Size' })}</span>
          <span>{t('dryRun.colTargetSize', { defaultValue: 'Target Size' })}</span>
        </div>

        {result.diffs.length === 0 ? (
          <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">{t('dryRun.noChanges')}</div>
        ) : (
          <Virtuoso
            style={{ height: 420 }}
            data={result.diffs}
            itemContent={(_index, diff) => (
              <div className="grid grid-cols-[minmax(0,1fr)_140px_130px_130px] gap-2 px-3 py-2 border-b border-dashed border-[var(--border-main)] text-xs font-mono">
                <span className="break-all">{diff.path}</span>
                <span className="inline-flex items-center gap-1">
                  {diff.kind === 'New' ? <IconFilePlus size={14} /> : <IconFileCode size={14} />}
                  {diff.kind === 'New' ? t('dryRun.newFile') : t('dryRun.modifiedFile')}
                </span>
                <span>{diff.source_size === null ? '-' : formatBytes(diff.source_size, settings.dataUnitSystem)}</span>
                <span>{diff.target_size === null ? '-' : formatBytes(diff.target_size, settings.dataUnitSystem)}</span>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
