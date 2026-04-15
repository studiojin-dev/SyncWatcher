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
  savingTask: boolean;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  t: TranslateFn;
}

function SyncTaskFormModal({
  opened,
  editingTask,
  form,
  sets,
  savingTask,
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
        <div
          aria-busy={savingTask}
          className={`neo-box p-6 w-full max-w-lg bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)] my-auto ${
            savingTask ? 'cursor-progress opacity-85' : ''
          }`}
        >
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
              disabled={savingTask}
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
                  disabled={savingTask}
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
                  disabled={savingTask}
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
                  onChange={(event) => {
                    form.setSourcePath(event.target.value);
                    form.setSourceBookmark(null);
                    form.setSourceNetworkMount(null);
                    form.setSourceNetworkPassword('');
                  }}
                  required={form.sourceType === 'path'}
                  disabled={savingTask}
                  className="neo-input font-mono text-sm flex-1"
                  placeholder="/path/to/source"
                />
                <button
                  type="button"
                  onClick={() => {
                    void form.browseDirectory('source');
                  }}
                  disabled={savingTask}
                  className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                  title="Browse..."
                >
                  <IconFolder size={18} />
                </button>
              </div>
            ) : null}

            {form.sourceType === 'path' && form.sourceNetworkMount?.enabled ? (
              <div className="mt-2 space-y-2 border-l-2 border-[var(--accent-main)] pl-3">
                <div className="text-xs font-mono text-[var(--text-secondary)]">
                  {t('syncTasks.smbAutoMountEnabled', {
                    defaultValue: 'SMB auto-mount enabled',
                  })}
                </div>
                <input
                  value={form.sourceNetworkMount.username ?? ''}
                  onChange={(event) =>
                    form.setSourceNetworkMount({
                      ...form.sourceNetworkMount!,
                      username: event.target.value || null,
                    })
                  }
                  disabled={savingTask}
                  className="neo-input font-mono text-sm"
                  placeholder={t('syncTasks.smbUsernamePlaceholder', {
                    defaultValue: 'SMB username',
                  })}
                />
                <input
                  type="password"
                  value={form.sourceNetworkPassword}
                  onChange={(event) =>
                    form.setSourceNetworkPassword(event.target.value)
                  }
                  disabled={savingTask}
                  className="neo-input font-mono text-sm"
                  placeholder={t('syncTasks.smbPasswordPlaceholder', {
                    defaultValue: 'Password (optional, stored in Keychain)',
                  })}
                />
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
                  disabled={savingTask}
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
                      {form.sourceTokenType === 'volume'
                        ? 'Volume UUID'
                        : form.sourceTokenType === 'legacy'
                          ? 'Legacy UUID'
                        : 'Disk UUID'}
                      :
                    </span>{' '}
                    {form.sourceUuid}
                  </div>
                ) : null}
                {form.selectedUuidOption && !form.selectedUuidOption.mounted ? (
                  <div className="text-xs font-mono text-[var(--text-secondary)] border-l-2 border-[var(--accent-warning)] pl-2">
                    {t('syncTasks.savedUuidSourceHint', {
                      defaultValue:
                        'This task keeps its saved UUID source. Mount the media again to browse inside it or pick a different volume.',
                    })}
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
                      disabled={savingTask}
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
                      disabled={savingTask || !form.selectedUuidOption?.mounted}
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
                onChange={(event) => {
                  form.setTargetPath(event.target.value);
                  form.setTargetBookmark(null);
                  form.setTargetNetworkMount(null);
                  form.setTargetNetworkPassword('');
                }}
                required
                disabled={savingTask}
                className="neo-input font-mono text-sm flex-1"
                placeholder="/path/to/target"
              />
              <button
                type="button"
                onClick={() => {
                  void form.browseDirectory('target');
                }}
                disabled={savingTask}
                className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                title="Browse..."
              >
                <IconFolder size={18} />
              </button>
            </div>
            {form.targetNetworkMount?.enabled ? (
              <div className="mt-2 space-y-2 border-l-2 border-[var(--accent-main)] pl-3">
                <div className="text-xs font-mono text-[var(--text-secondary)]">
                  {t('syncTasks.smbAutoMountEnabled', {
                    defaultValue: 'SMB auto-mount enabled',
                  })}
                </div>
                <input
                  value={form.targetNetworkMount.username ?? ''}
                  onChange={(event) =>
                    form.setTargetNetworkMount({
                      ...form.targetNetworkMount!,
                      username: event.target.value || null,
                    })
                  }
                  disabled={savingTask}
                  className="neo-input font-mono text-sm"
                  placeholder={t('syncTasks.smbUsernamePlaceholder', {
                    defaultValue: 'SMB username',
                  })}
                />
                <input
                  type="password"
                  value={form.targetNetworkPassword}
                  onChange={(event) =>
                    form.setTargetNetworkPassword(event.target.value)
                  }
                  disabled={savingTask}
                  className="neo-input font-mono text-sm"
                  placeholder={t('syncTasks.smbPasswordPlaceholder', {
                    defaultValue: 'Password (optional, stored in Keychain)',
                  })}
                />
              </div>
            ) : null}
          </div>
          <div className="space-y-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  name="checksumMode"
                  defaultChecked={editingTask?.checksumMode}
                  disabled={savingTask}
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
                  disabled={savingTask}
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
                    disabled={savingTask}
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
              disabled={savingTask}
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
              disabled={savingTask}
              onClick={onClose}
            >
              {t('syncTasks.cancel')}
            </button>
            <button
              type="submit"
              disabled={savingTask}
              className={`bg-[var(--text-primary)] text-[var(--bg-primary)] px-6 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold uppercase transition-all ${
                savingTask
                  ? 'cursor-progress opacity-70'
                  : 'hover:shadow-[3px_3px_0_0_var(--shadow-color)]'
              }`}
            >
              {savingTask ? t('common.loading') : t('syncTasks.save')}
            </button>
          </div>
          </form>
        </div>
      </CardAnimation>
    </div>
  );
}

export default SyncTaskFormModal;
