import { MultiSelect, Select } from '@mantine/core';
import { IconFolder } from '@tabler/icons-react';
import type { FormEventHandler } from 'react';
import { CardAnimation } from '../../components/ui/Animations';
import type { SyncTask } from '../../hooks/useSyncTasks';
import type { TranslateFn } from './helpers';
import type { SyncTaskFormController } from './useSyncTaskFormController';

interface SyncTaskFormModalProps {
  opened: boolean;
  editingTask: SyncTask | null;
  form: SyncTaskFormController;
  sets: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  t: TranslateFn;
}

function SyncTaskFormModal({
  opened,
  editingTask,
  form,
  sets,
  onClose,
  onSubmit,
  t,
}: SyncTaskFormModalProps) {
  if (!opened) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
      <CardAnimation>
        <div className="neo-box p-6 w-full max-w-lg bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)] my-auto">
          <h3 className="text-xl font-heading font-bold mb-6 border-b-3 border-[var(--border-main)] pb-2 uppercase">
            {editingTask ? t('syncTasks.editTask') : t('syncTasks.addTask')}
          </h3>
          <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-bold mb-1 uppercase font-mono">
              {t('syncTasks.taskName')}
            </label>
            <input
              name="name"
              defaultValue={editingTask?.name || ''}
              required
              className="neo-input"
              placeholder="MY_BACKUP_TASK"
            />
          </div>
          <div>
            <label className="block text-sm font-bold mb-1 uppercase font-mono">
              {t('syncTasks.source')}
            </label>

            <div className="flex gap-4 mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="sourceType"
                  checked={form.sourceType === 'path'}
                  onChange={() => form.handleSourceTypeChange('path')}
                  className="w-4 h-4"
                />
                <span className="text-sm font-mono">
                  📁{' '}
                  {t('syncTasks.sourceTypePath', {
                    defaultValue: '디렉토리 경로',
                  })}
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="sourceType"
                  checked={form.sourceType === 'uuid'}
                  onChange={() => form.handleSourceTypeChange('uuid')}
                  className="w-4 h-4"
                />
                <span className="text-sm font-mono">
                  💾{' '}
                  {t('syncTasks.sourceTypeUuid', {
                    defaultValue: '볼륨 UUID',
                  })}
                </span>
              </label>
            </div>

            {form.sourceType === 'path' ? (
              <div className="flex gap-2">
                <input
                  name="source"
                  value={form.sourcePath}
                  onChange={(event) => form.setSourcePath(event.target.value)}
                  required={form.sourceType === 'path'}
                  className="neo-input font-mono text-sm flex-1"
                  placeholder="/path/to/source"
                />
                <button
                  type="button"
                  onClick={() => {
                    void form.browseDirectory('source');
                  }}
                  className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                  title="Browse..."
                >
                  <IconFolder size={18} />
                </button>
              </div>
            ) : null}

            {form.sourceType === 'uuid' ? (
              <div className="space-y-2">
                <Select
                  placeholder={
                    form.loadingVolumes
                      ? '로딩 중...'
                      : t('syncTasks.selectVolume', {
                          defaultValue: '볼륨 선택',
                        })
                  }
                  data={form.uuidSourceOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  value={form.selectedUuidOptionValue}
                  onChange={form.handleUuidOptionChange}
                  searchable
                  required={form.sourceType === 'uuid'}
                  styles={{
                    input: {
                      border: '3px solid var(--border-main)',
                      borderRadius: 0,
                      fontFamily: 'var(--font-mono)',
                    },
                    dropdown: {
                      border: '3px solid var(--border-main)',
                      borderRadius: 0,
                      boxShadow: '4px 4px 0 0 black',
                    },
                  }}
                />
                {form.sourceUuid ? (
                  <div className="text-xs font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] p-2 border-2 border-dashed border-[var(--border-main)]">
                    <span className="font-bold">
                      {form.sourceUuidType === 'volume'
                        ? 'Volume UUID'
                        : 'Disk UUID'}
                      :
                    </span>{' '}
                    {form.sourceUuid}
                  </div>
                ) : null}
                <div>
                  <label className="block text-xs font-bold mb-1 uppercase font-mono text-[var(--text-secondary)]">
                    {t('syncTasks.subPath', {
                      defaultValue: '하위 경로',
                    })}
                  </label>
                  <div className="flex gap-2">
                    <input
                      name="sourceSubPath"
                      value={form.sourceSubPath}
                      onChange={(event) =>
                        form.setSourceSubPath(event.target.value)
                      }
                      className="neo-input font-mono text-sm flex-1"
                      placeholder={t('syncTasks.subPathPlaceholder', {
                        defaultValue: '/DCIM/100MSDCF',
                      })}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void form.browseSourceSubPath();
                      }}
                      className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                      title={t('syncTasks.subPath', {
                        defaultValue: '하위 경로',
                      })}
                      disabled={!form.selectedUuidOption}
                    >
                      <IconFolder size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          <div>
            <label className="block text-sm font-bold mb-1 uppercase font-mono">
              {t('syncTasks.target')}
            </label>
            <div className="flex gap-2">
              <input
                name="target"
                value={form.targetPath}
                onChange={(event) => form.setTargetPath(event.target.value)}
                required
                className="neo-input font-mono text-sm flex-1"
                placeholder="/path/to/target"
              />
              <button
                type="button"
                onClick={() => {
                  void form.browseDirectory('target');
                }}
                className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                title="Browse..."
              >
                <IconFolder size={18} />
              </button>
            </div>
          </div>
          <div className="space-y-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  name="checksumMode"
                  defaultChecked={editingTask?.checksumMode}
                  className="peer sr-only"
                />
                <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">
                  ✓
                </div>
              </div>
              <span className="font-bold text-sm uppercase">
                {t('syncTasks.checksumMode')}
              </span>
            </label>

            <div className="border-t-2 border-dashed border-[var(--border-main)] pt-3 mt-2">
              <div className="text-xs font-mono text-[var(--text-secondary)] mb-2 uppercase">
                Watch Mode Options
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={form.watchMode}
                  onChange={(event) =>
                    form.handleWatchModeChange(event.target.checked)
                  }
                  className="peer sr-only"
                />
                <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-success)] transition-colors"></div>
                <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">
                  ✓
                </div>
              </div>
              <span className="font-bold text-sm uppercase">
                {t('syncTasks.watchMode')}
              </span>
            </label>
            {form.watchMode ? (
              <div className="ml-8 p-2 bg-[var(--accent-success)]/10 border-2 border-[var(--accent-success)] text-sm text-[var(--text-primary)] font-mono">
                ℹ️ {t('syncTasks.watchModeDesc')}
              </div>
            ) : null}

            {form.watchMode && form.sourceType === 'uuid' ? (
              <label className="flex items-center gap-2 cursor-pointer select-none ml-4">
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={form.autoUnmount}
                    onChange={(event) => form.setAutoUnmount(event.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                  <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">
                    ✓
                  </div>
                </div>
                <span className="font-bold text-sm uppercase">
                  {t('syncTasks.autoUnmount', {
                    defaultValue: '자동 Unmount',
                  })}
                </span>
              </label>
            ) : null}
          </div>
          <div>
            <label className="block text-sm font-bold mb-1 uppercase font-mono">
              Exclusion Sets
            </label>
            <MultiSelect
              data={sets.map((set) => ({ value: set.id, label: set.name }))}
              value={form.selectedSets}
              onChange={form.setSelectedSets}
              searchable
              clearable
              maxDropdownHeight={200}
              comboboxProps={{
                position: 'bottom',
                middlewares: { flip: true, shift: true },
                withinPortal: true,
              }}
              styles={{
                input: {
                  border: '3px solid var(--border-main)',
                  borderRadius: 0,
                  fontFamily: 'var(--font-heading)',
                  transform: 'none',
                  transition: 'background-color 0.1s ease-out',
                },
                dropdown: {
                  border: '3px solid var(--border-main)',
                  borderRadius: 0,
                  boxShadow: '4px 4px 0 0 black',
                  transform: 'none',
                },
              }}
            />
            <div className="mt-2 text-xs font-mono text-[var(--text-secondary)] border-l-2 border-[var(--accent-info)] pl-2">
              {t('syncTasks.systemMetadataAlwaysExcluded')}
            </div>
          </div>
          <div className="flex gap-3 mt-6 justify-end">
            <button
              type="button"
              className="px-4 py-2 font-bold uppercase hover:underline"
              onClick={onClose}
            >
              {t('syncTasks.cancel')}
            </button>
            <button
              type="submit"
              className="bg-[var(--text-primary)] text-[var(--bg-primary)] px-6 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold uppercase hover:shadow-[3px_3px_0_0_var(--shadow-color)] transition-all"
            >
              {t('syncTasks.save')}
            </button>
          </div>
          </form>
        </div>
      </CardAnimation>
    </div>
  );
}

export default SyncTaskFormModal;
