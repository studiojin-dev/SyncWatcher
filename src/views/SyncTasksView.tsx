import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus, IconTrash, IconPlayerPlay, IconEye } from '@tabler/icons-react';
import { invoke } from '@tauri-apps/api/core';
import { useSyncTasks, SyncTask } from '../hooks/useSyncTasks';

/**
 * Sync Tasks View - Manage sync tasks
 * CRUD operations with localStorage persistence
 */
function SyncTasksView() {
    const { t } = useTranslation();
    const { tasks, addTask, updateTask, deleteTask, toggleTask } = useSyncTasks();
    const [showForm, setShowForm] = useState(false);
    const [editingTask, setEditingTask] = useState<SyncTask | null>(null);
    const [syncing, setSyncing] = useState<string | null>(null);

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
        };

        if (editingTask) {
            updateTask(editingTask.id, taskData);
        } else {
            addTask(taskData);
        }

        setShowForm(false);
        setEditingTask(null);
    };

    const handleSync = async (task: SyncTask) => {
        try {
            setSyncing(task.id);
            await invoke('start_sync', {
                source: task.source,
                target: task.target,
                deleteMissing: task.deleteMissing,
                checksumMode: task.checksumMode,
                verifyAfterCopy: true,
            });
        } catch (err) {
            console.error('Sync failed:', err);
        } finally {
            setSyncing(null);
        }
    };

    const handleDryRun = async (task: SyncTask) => {
        try {
            const result = await invoke('sync_dry_run', {
                source: task.source,
                target: task.target,
                deleteMissing: task.deleteMissing,
                checksumMode: task.checksumMode,
            });
            console.log('Dry run result:', result);
            alert(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error('Dry run failed:', err);
        }
    };

    return (
        <div className="fade-in">
            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-8)' }}>
                <div>
                    <h1 className="text-xl" style={{ fontWeight: 'var(--weight-normal)', marginBottom: 'var(--space-2)' }}>
                        {t('syncTasks.title')}
                    </h1>
                    <p className="text-secondary text-sm">
                        {tasks.length > 0 ? `${tasks.length} ${t('syncTasks.title')}` : t('syncTasks.noTasks')}
                    </p>
                </div>
                <button
                    className="btn-primary"
                    onClick={() => { setShowForm(true); setEditingTask(null); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                    <IconPlus size={16} />
                    {t('syncTasks.addTask')}
                </button>
            </header>

            {/* Task Form Modal */}
            {showForm && (
                <div className="card" style={{ marginBottom: 'var(--space-6)', maxWidth: '480px' }}>
                    <h3 className="text-base" style={{ marginBottom: 'var(--space-4)' }}>
                        {editingTask ? t('syncTasks.editTask') : t('syncTasks.addTask')}
                    </h3>
                    <form onSubmit={handleSubmit}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                            <div>
                                <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
                                    {t('syncTasks.taskName')}
                                </label>
                                <input
                                    name="name"
                                    defaultValue={editingTask?.name || ''}
                                    required
                                    className="btn-ghost"
                                    style={{ width: '100%', background: 'var(--bg-secondary)' }}
                                />
                            </div>
                            <div>
                                <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
                                    {t('syncTasks.source')}
                                </label>
                                <input
                                    name="source"
                                    defaultValue={editingTask?.source || ''}
                                    required
                                    className="btn-ghost font-mono"
                                    style={{ width: '100%', background: 'var(--bg-secondary)' }}
                                />
                            </div>
                            <div>
                                <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
                                    {t('syncTasks.target')}
                                </label>
                                <input
                                    name="target"
                                    defaultValue={editingTask?.target || ''}
                                    required
                                    className="btn-ghost font-mono"
                                    style={{ width: '100%', background: 'var(--bg-secondary)' }}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                    <input type="checkbox" name="deleteMissing" defaultChecked={editingTask?.deleteMissing} />
                                    <span className="text-sm">{t('syncTasks.deleteMissing')}</span>
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                    <input type="checkbox" name="checksumMode" defaultChecked={editingTask?.checksumMode} />
                                    <span className="text-sm">{t('syncTasks.checksumMode')}</span>
                                </label>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
                                <button type="submit" className="btn-primary">{t('syncTasks.save')}</button>
                                <button type="button" className="btn-ghost" onClick={() => { setShowForm(false); setEditingTask(null); }}>
                                    {t('syncTasks.cancel')}
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
            )}

            {/* Task List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {tasks.map((task) => (
                    <div key={task.id} className="card" style={{ opacity: task.enabled ? 1 : 0.6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <h3 className="text-base" style={{ marginBottom: 'var(--space-1)' }}>{task.name}</h3>
                                <div className="text-xs text-tertiary font-mono" style={{ marginBottom: 'var(--space-1)' }}>
                                    {task.source} → {task.target}
                                </div>
                                <div className="text-xs text-secondary">
                                    {task.deleteMissing && <span style={{ marginRight: 'var(--space-2)' }}>🗑️ Delete</span>}
                                    {task.checksumMode && <span>🔏 Checksum</span>}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                                <button
                                    className="btn-ghost"
                                    onClick={() => handleDryRun(task)}
                                    title={t('syncTasks.dryRun')}
                                >
                                    <IconEye size={16} />
                                </button>
                                <button
                                    className="btn-primary"
                                    onClick={() => handleSync(task)}
                                    disabled={syncing === task.id}
                                    title={t('syncTasks.startSync')}
                                >
                                    <IconPlayerPlay size={16} />
                                </button>
                                <button
                                    className="btn-ghost"
                                    onClick={() => { setEditingTask(task); setShowForm(true); }}
                                >
                                    {t('common.edit')}
                                </button>
                                <button
                                    className="btn-ghost"
                                    onClick={() => toggleTask(task.id)}
                                >
                                    {task.enabled ? t('syncTasks.enabled') : t('common.add')}
                                </button>
                                <button
                                    className="btn-ghost"
                                    onClick={() => deleteTask(task.id)}
                                    style={{ color: 'var(--status-error-text)' }}
                                >
                                    <IconTrash size={16} />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default SyncTasksView;
