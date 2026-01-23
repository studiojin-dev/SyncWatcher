import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus, IconPlayerPlay, IconEye } from '@tabler/icons-react';
import { MultiSelect } from '@mantine/core';
import { invoke } from '@tauri-apps/api/core';
import { useSyncTasks, SyncTask } from '../hooks/useSyncTasks';
import { useExclusionSets } from '../hooks/useExclusionSets';
import { CardAnimation, FadeIn } from '../components/ui/Animations';
import { useToast } from '../components/ui/Toast';
import YamlEditorModal from '../components/ui/YamlEditorModal';

/**
 * Sync Tasks View - Manage sync tasks
 * CRUD operations with localStorage persistence
 */
function SyncTasksView() {
    const { t } = useTranslation();
    const { tasks, addTask, updateTask, deleteTask, error, reload } = useSyncTasks();
    const { sets, getPatternsForSets } = useExclusionSets();
    const { showToast } = useToast();
    const [showForm, setShowForm] = useState(false);
    const [editingTask, setEditingTask] = useState<SyncTask | null>(null);
    const [syncing, setSyncing] = useState<string | null>(null);

    // Changing the logic: adding state for selected sets in form
    const [selectedSets, setSelectedSets] = useState<string[]>([]);

    useEffect(() => {
        if (editingTask) {
            setSelectedSets(editingTask.exclusionSets || []);
        } else {
            setSelectedSets([]);
        }
    }, [editingTask, showForm]);



    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        const taskData = {
            name: formData.get('name') as string,
            source: formData.get('source') as string,
            target: formData.get('target') as string,
            enabled: true,
            deleteMissing: formData.get('deleteMissing') === 'on',
            checksumMode: formData.get('checksumMode') === 'on',
            exclusionSets: selectedSets,
        };

        if (editingTask) {
            updateTask(editingTask.id, taskData);
            showToast(t('syncTasks.editTask') + ': ' + taskData.name, 'success');
        } else {
            addTask(taskData);
            showToast(t('syncTasks.addTask') + ': ' + taskData.name, 'success');
        }

        setShowForm(false);
        setEditingTask(null);
    };

    const handleSync = async (task: SyncTask) => {
        try {
            setSyncing(task.id);
            showToast(t('syncTasks.startSync') + ': ' + task.name, 'info');
            await invoke('start_sync', {
                source: task.source,
                target: task.target,
                deleteMissing: task.deleteMissing,
                checksumMode: task.checksumMode,
                verifyAfterCopy: true,
                excludePatterns: getPatternsForSets(task.exclusionSets || []),
            });
            showToast(t('sync.syncComplete'), 'success');
        } catch (err) {
            console.error('Sync failed:', err);
            showToast(String(err), 'error');
        } finally {
            setSyncing(null);
        }
    };

    const handleDryRun = async (task: SyncTask) => {
        try {
            showToast(t('syncTasks.dryRun') + '...', 'info');
            const result = await invoke('sync_dry_run', {
                source: task.source,
                target: task.target,
                deleteMissing: task.deleteMissing,
                checksumMode: task.checksumMode,
                excludePatterns: getPatternsForSets(task.exclusionSets || []),
            });
            console.log('Dry run result:', result);
            showToast(t('syncTasks.dryRun') + ' ' + t('common.success'), 'success');
        } catch (err) {
            console.error('Dry run failed:', err);
            showToast(String(err), 'error');
        }
    };

    const handleDelete = (task: SyncTask) => {
        deleteTask(task.id);
        showToast(t('syncTasks.deleteTask') + ': ' + task.name, 'warning');
    };

    const handleEditorClose = async () => {
        // Reload data after fixing errors
        await reload();
    };

    return (
        <div className="space-y-8">
            {/* YAML Error Editor Modal */}
            {error && (
                <YamlEditorModal
                    opened={!!error}
                    onClose={handleEditorClose}
                    error={error}
                />
            )}

            <FadeIn>
                <header className="flex justify-between items-center mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
                    <div>
                        <h1 className="text-2xl font-heading font-bold uppercase mb-1">
                            {t('syncTasks.title')}
                        </h1>
                        <p className="text-[var(--text-secondary)] font-mono text-sm">
                            {tasks.length > 0 ? `// ${tasks.length} ACTIVE_TASKS` : '// NO_TASKS_DEFINED'}
                        </p>
                    </div>
                    <button
                        className="bg-[var(--accent-main)] text-white px-4 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold flex items-center gap-2 active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_0_var(--shadow-color)] transition-all"
                        onClick={() => { setShowForm(true); setEditingTask(null); }}
                    >
                        <IconPlus size={20} stroke={3} />
                        {t('syncTasks.addTask')}
                    </button>
                </header>
            </FadeIn>

            {/* Task Form Modal */}
            {showForm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <CardAnimation>
                        <div className="neo-box p-6 w-full max-w-lg bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                            <h3 className="text-xl font-heading font-bold mb-6 border-b-3 border-[var(--border-main)] pb-2 uppercase">
                                {editingTask ? t('syncTasks.editTask') : t('syncTasks.addTask')}
                            </h3>
                            <form onSubmit={handleSubmit} className="space-y-4">
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
                                    <input
                                        name="source"
                                        defaultValue={editingTask?.source || ''}
                                        required
                                        className="neo-input font-mono text-sm"
                                        placeholder="/path/to/source"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold mb-1 uppercase font-mono">
                                        {t('syncTasks.target')}
                                    </label>
                                    <input
                                        name="target"
                                        defaultValue={editingTask?.target || ''}
                                        required
                                        className="neo-input font-mono text-sm"
                                        placeholder="/path/to/target"
                                    />
                                </div>
                                <div className="flex gap-6 py-2">
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <div className="relative">
                                            <input type="checkbox" name="deleteMissing" defaultChecked={editingTask?.deleteMissing} className="peer sr-only" />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.deleteMissing')}</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <div className="relative">
                                            <input type="checkbox" name="checksumMode" defaultChecked={editingTask?.checksumMode} className="peer sr-only" />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.checksumMode')}</span>
                                    </label>

                                </div>
                                <div>
                                    <label className="block text-sm font-bold mb-1 uppercase font-mono">
                                        Exclusion Sets
                                    </label>
                                    <MultiSelect
                                        data={sets.map(s => ({ value: s.id, label: s.name }))}
                                        value={selectedSets}
                                        onChange={setSelectedSets}
                                        searchable
                                        clearable
                                        styles={{
                                            input: {
                                                border: '3px solid var(--border-main)',
                                                borderRadius: 0,
                                                fontFamily: 'var(--font-heading)',
                                            },
                                            dropdown: {
                                                border: '3px solid var(--border-main)',
                                                borderRadius: 0,
                                                boxShadow: '4px 4px 0 0 black',
                                            }
                                        }}
                                    />
                                </div>
                                <div className="flex gap-3 mt-6 justify-end">
                                    <button
                                        type="button"
                                        className="px-4 py-2 font-bold uppercase hover:underline"
                                        onClick={() => { setShowForm(false); setEditingTask(null); }}
                                    >
                                        {t('syncTasks.cancel')}
                                    </button>
                                    <button
                                        type="submit"
                                        className="bg-[var(--text-primary)] text-[var(--bg-primary)] px-6 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold uppercase hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[3px_3px_0_0_var(--shadow-color)] transition-all"
                                    >
                                        {t('syncTasks.save')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </CardAnimation>
                </CardAnimation>
                </div>
    )
}

{/* Task List */ }
<div className="grid gap-6">
    {tasks.map((task, index) => (
        <CardAnimation key={task.id} index={index}>
            <div className={`neo-box p-5 relative transition-opacity ${task.enabled ? 'opacity-100' : 'opacity-60 bg-[var(--bg-secondary)]'}`}>
                <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                    <div className="min-w-0 flex-1 w-full"> {/* min-w-0 ensures truncation works */}
                        <div className="flex items-center gap-3 mb-2">
                            <h3 className="text-lg font-heading font-black uppercase tracking-tight truncate">
                                {task.name}
                            </h3>
                            <div className="flex gap-2">
                                {task.deleteMissing && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold border-2 border-black bg-[var(--color-accent-error)] text-white">
                                        DEL
                                    </span>
                                )}
                                {task.checksumMode && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold border-2 border-black bg-[var(--color-accent-warning)] text-black">
                                        CHK
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Path Display with Overflow Protection */}
                        <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] mb-1 break-all">
                            <span className="font-bold text-[var(--accent-main)]">SRC:</span> {task.source}
                        </div>
                        <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] break-all">
                            <span className="font-bold text-[var(--accent-success)]">DST:</span> {task.target}
                        </div>
                    </div>

                    <div className="flex gap-2 shrink-0 md:self-start self-end mt-2 md:mt-0">
                        <button
                            className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                            onClick={() => handleDryRun(task)}
                            title={t('syncTasks.dryRun')}
                        >
                            <IconEye size={20} stroke={2} />
                        </button>
                        <button
                            className={`p-2 border-2 border-[var(--border-main)] transition-all ${syncing === task.id ? 'bg-[var(--bg-secondary)] cursor-wait' : 'bg-[var(--accent-main)] text-white hover:shadow-[2px_2px_0_0_black]'}`}
                            onClick={() => handleSync(task)}
                            disabled={syncing === task.id}
                            title={t('syncTasks.startSync')}
                        >
                            <IconPlayerPlay size={20} stroke={2} className={syncing === task.id ? 'animate-spin' : ''} />
                        </button>
                        <div className="w-[2px] h-auto bg-[var(--border-main)] mx-1"></div>
                        <button
                            className="px-3 py-1 font-bold font-mono text-xs border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]"
                            onClick={() => { setEditingTask(task); setShowForm(true); }}
                        >
                            EDIT
                        </button>
                        <button
                            className="px-3 py-1 font-bold font-mono text-xs border-2 border-[var(--border-main)] hover:bg-[var(--color-accent-error)] hover:text-white transition-colors"
                            onClick={() => handleDelete(task)}
                        >
                            DEL
                        </button>
                    </div>
                </div>
            </div>
        </CardAnimation>
    ))}
</div>
        </div >
    );
}

export default SyncTasksView;
