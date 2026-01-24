import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus, IconPlayerPlay, IconEye, IconFolder, IconList, IconPlayerStop } from '@tabler/icons-react';
import { MultiSelect } from '@mantine/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useSyncTasks, SyncTask } from '../hooks/useSyncTasks';
import { useExclusionSets } from '../hooks/useExclusionSets';
import { useSyncTaskStatusStore } from '../hooks/useSyncTaskStatus';
import { CardAnimation, FadeIn } from '../components/ui/Animations';
import { useToast } from '../components/ui/Toast';
import YamlEditorModal from '../components/ui/YamlEditorModal';
import TaskLogsModal from '../components/features/TaskLogsModal';
import CancelConfirmModal from '../components/ui/CancelConfirmModal';

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

    const [logsTask, setLogsTask] = useState<SyncTask | null>(null);

    // 상태 스토어 연동
    const { statuses, setLastLog } = useSyncTaskStatusStore();

    // sync-progress 이벤트 리스닝
    useEffect(() => {
        const unlisten = listen<{ taskId?: string; message?: string; current?: number; total?: number }>('sync-progress', (event) => {
            if (event.payload.taskId) {
                setLastLog(event.payload.taskId, {
                    message: event.payload.message || 'Syncing...',
                    timestamp: new Date().toLocaleTimeString(),
                    level: 'info',
                });
            }
        });
        return () => {
            unlisten.then(fn => fn());
        };
    }, [setLastLog]);

    // Changing the logic: adding state for selected sets in form
    const [selectedSets, setSelectedSets] = useState<string[]>([]);

    // Directory paths state
    const [sourcePath, setSourcePath] = useState('');
    const [targetPath, setTargetPath] = useState('');

    // Delete Missing state with warning
    const [deleteMissing, setDeleteMissing] = useState(false);
    const [showDeleteWarning, setShowDeleteWarning] = useState(false);

    // Watch Mode state
    const [watchMode, setWatchMode] = useState(false);
    const [autoUnmount, setAutoUnmount] = useState(false);

    // Dry Run state
    const [dryRunning, setDryRunning] = useState<string | null>(null);

    // Cancel confirmation state
    const [cancelConfirm, setCancelConfirm] = useState<{ type: 'sync' | 'dryRun'; taskId: string } | null>(null);

    useEffect(() => {
        if (editingTask) {
            setSelectedSets(editingTask.exclusionSets || []);
            setSourcePath(editingTask.source || '');
            setTargetPath(editingTask.target || '');
            setDeleteMissing(editingTask.deleteMissing || false);
            setWatchMode(editingTask.watchMode || false);
            setAutoUnmount(editingTask.autoUnmount || false);
        } else {
            setSelectedSets([]);
            setSourcePath('');
            setTargetPath('');
            setDeleteMissing(false);
            setWatchMode(false);
            setAutoUnmount(false);
        }
    }, [editingTask, showForm]);

    const browseDirectory = async (type: 'source' | 'target') => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: type === 'source' ? 'Select Source Directory' : 'Select Target Directory',
            });

            if (selected && typeof selected === 'string') {
                if (type === 'source') {
                    setSourcePath(selected);
                } else {
                    setTargetPath(selected);
                }
            }
        } catch (err) {
            console.error('Failed to open directory picker:', err);
            showToast('Failed to open directory picker', 'error');
        }
    };





    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        const taskData = {
            name: formData.get('name') as string,
            source: sourcePath || formData.get('source') as string,
            target: targetPath || formData.get('target') as string,
            enabled: true,
            deleteMissing: watchMode ? false : deleteMissing, // 감시 모드에서는 deleteMissing 비활성화
            checksumMode: formData.get('checksumMode') === 'on',
            exclusionSets: selectedSets,
            watchMode: watchMode,
            autoUnmount: autoUnmount,
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
        if (syncing === task.id) {
            // 이미 실행 중이면 취소 확인 모달 표시
            setCancelConfirm({ type: 'sync', taskId: task.id });
            return;
        }

        if (syncing) return; // 다른 태스크가 실행 중이면 무시

        try {
            setSyncing(task.id);
            showToast(t('syncTasks.startSync') + ': ' + task.name, 'info');
            await invoke('start_sync', {
                taskId: task.id,
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
        if (dryRunning === task.id) {
            // 이미 실행 중이면 취소 확인 모달 표시
            setCancelConfirm({ type: 'dryRun', taskId: task.id });
            return;
        }

        try {
            setDryRunning(task.id);
            showToast(t('syncTasks.dryRun') + '...', 'info');
            const result = await invoke('sync_dry_run', {
                taskId: task.id,
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
        } finally {
            setDryRunning(null);
        }
    };

    const handleDelete = (task: SyncTask) => {
        if (window.confirm(t('syncTasks.confirmDelete', { defaultValue: 'Are you sure you want to delete this task?' }))) {
            deleteTask(task.id);
            showToast(t('syncTasks.deleteTask') + ': ' + task.name, 'warning');
        }
    };

    const handleEditorClose = async () => {
        // Reload data after fixing errors
        await reload();
    };

    const handleCancelConfirm = async () => {
        if (!cancelConfirm) return;

        try {
            await invoke('cancel_operation', { taskId: cancelConfirm.taskId });
            showToast(t('syncTasks.cancelled', { defaultValue: '작업이 취소되었습니다.' }), 'warning');
        } catch (err) {
            console.error('Cancel failed:', err);
            showToast(String(err), 'error');
        } finally {
            if (cancelConfirm.type === 'sync') {
                setSyncing(null);
            } else {
                setDryRunning(null);
            }
            setCancelConfirm(null);
        }
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

            {/* Cancel Confirmation Modal */}
            <CancelConfirmModal
                opened={!!cancelConfirm}
                onConfirm={handleCancelConfirm}
                onCancel={() => setCancelConfirm(null)}
                title={cancelConfirm?.type === 'sync' ? t('syncTasks.cancelSync', { defaultValue: '동기화 취소' }) : t('syncTasks.cancelDryRun', { defaultValue: 'Dry Run 취소' })}
                message={t('syncTasks.cancelConfirm', { defaultValue: '정말로 작업을 취소하시겠습니까?' })}
            />

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
                        className="bg-[var(--accent-main)] text-white px-4 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold flex items-center gap-2 active:shadow-[2px_2px_0_0_var(--shadow-color)] transition-all"
                        onClick={() => { setShowForm(true); setEditingTask(null); }}
                    >
                        <IconPlus size={20} stroke={3} />
                        {t('syncTasks.addTask')}
                    </button>
                </header>
            </FadeIn>

            {/* Task Form Modal */}
            {showForm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
                    <CardAnimation>
                        <div className="neo-box p-6 w-full max-w-lg bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)] my-auto">
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
                                    <div className="flex gap-2">
                                        <input
                                            name="source"
                                            value={sourcePath}
                                            onChange={(e) => setSourcePath(e.target.value)}
                                            required
                                            className="neo-input font-mono text-sm flex-1"
                                            placeholder="/path/to/source"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => browseDirectory('source')}
                                            className="px-3 py-2 border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex items-center"
                                            title="Browse..."
                                        >
                                            <IconFolder size={18} />
                                        </button>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold mb-1 uppercase font-mono">
                                        {t('syncTasks.target')}
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            name="target"
                                            value={targetPath}
                                            onChange={(e) => setTargetPath(e.target.value)}
                                            required
                                            className="neo-input font-mono text-sm flex-1"
                                            placeholder="/path/to/target"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => browseDirectory('target')}
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
                                                name="deleteMissing"
                                                checked={deleteMissing}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setDeleteMissing(checked);
                                                    if (checked) {
                                                        setShowDeleteWarning(true);
                                                    } else {
                                                        setShowDeleteWarning(false);
                                                    }
                                                }}
                                                className="peer sr-only"
                                            />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--color-accent-error)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.deleteMissing')}</span>
                                    </label>
                                    {showDeleteWarning && (
                                        <div className="ml-8 p-2 bg-[var(--color-accent-error)]/10 border-2 border-[var(--color-accent-error)] text-sm text-[var(--color-accent-error)] font-mono">
                                            ⚠️ {t('syncTasks.deleteMissingWarning', { defaultValue: '주의: 원본 디렉토리에서 삭제된 파일을 대상 디렉토리에서 삭제합니다.' })}
                                        </div>
                                    )}
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <div className="relative">
                                            <input type="checkbox" name="checksumMode" defaultChecked={editingTask?.checksumMode} className="peer sr-only" />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.checksumMode')}</span>
                                    </label>

                                    {/* 구분선 */}
                                    <div className="border-t-2 border-dashed border-[var(--border-main)] pt-3 mt-2">
                                        <div className="text-xs font-mono text-[var(--text-secondary)] mb-2 uppercase">Watch Mode Options</div>
                                    </div>

                                    {/* 감시 모드 */}
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <div className="relative">
                                            <input
                                                type="checkbox"
                                                checked={watchMode}
                                                onChange={(e) => {
                                                    setWatchMode(e.target.checked);
                                                    if (e.target.checked) {
                                                        // 감시 모드 활성화 시 deleteMissing 해제
                                                        setDeleteMissing(false);
                                                        setShowDeleteWarning(false);
                                                    }
                                                }}
                                                className="peer sr-only"
                                            />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-success)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.watchMode', { defaultValue: '감시 모드' })}</span>
                                    </label>
                                    {watchMode && (
                                        <div className="ml-8 p-2 bg-[var(--accent-success)]/10 border-2 border-[var(--accent-success)] text-sm text-[var(--text-primary)] font-mono">
                                            ℹ️ {t('syncTasks.watchModeDesc', { defaultValue: '소스 디렉토리를 감시하고 변경 시 자동 복사합니다. Delete Missing은 비활성화됩니다.' })}
                                        </div>
                                    )}

                                    {/* 자동 unmount (감시 모드에서만 표시) */}
                                    {watchMode && (
                                        <label className="flex items-center gap-2 cursor-pointer select-none ml-4">
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    checked={autoUnmount}
                                                    onChange={(e) => setAutoUnmount(e.target.checked)}
                                                    className="peer sr-only"
                                                />
                                                <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-main)] transition-colors"></div>
                                                <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                            </div>
                                            <span className="font-bold text-sm uppercase">{t('syncTasks.autoUnmount', { defaultValue: '자동 Unmount' })}</span>
                                        </label>
                                    )}

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
                                        maxDropdownHeight={200}
                                        comboboxProps={{ position: 'bottom', middlewares: { flip: true, shift: true }, withinPortal: true }}
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
                                        className="bg-[var(--text-primary)] text-[var(--bg-primary)] px-6 py-2 border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] font-bold uppercase hover:shadow-[3px_3px_0_0_var(--shadow-color)] transition-all"
                                    >
                                        {t('syncTasks.save')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </CardAnimation>
                </div>
            )}

            {/* Task Logs Modal */}
            {logsTask && (
                <TaskLogsModal
                    taskId={logsTask.id}
                    taskName={logsTask.name}
                    onClose={() => setLogsTask(null)}
                />
            )}

            {/* Task List */}
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

                                    {/* 최종 로그 표시 영역 */}
                                    {(() => {
                                        const taskStatus = statuses.get(task.id);
                                        if (taskStatus?.lastLog) {
                                            return (
                                                <div className="mt-2 p-2 border-2 border-dashed border-[var(--border-main)] bg-[var(--bg-tertiary)] font-mono text-xs">
                                                    <span className="text-[var(--text-secondary)]">[{taskStatus.lastLog.timestamp}]</span>{' '}
                                                    <span className={
                                                        taskStatus.lastLog.level === 'success' ? 'text-[var(--accent-success)]' :
                                                            taskStatus.lastLog.level === 'error' ? 'text-[var(--color-accent-error)]' :
                                                                taskStatus.lastLog.level === 'warning' ? 'text-[var(--color-accent-warning)]' :
                                                                    'text-[var(--text-primary)]'
                                                    }>
                                                        {taskStatus.lastLog.message}
                                                    </span>
                                                </div>
                                            );
                                        }
                                        return null;
                                    })()}
                                </div>

                                <div className="flex gap-2 shrink-0 md:self-start self-end mt-2 md:mt-0">
                                    <button
                                        className={`p-2 border-2 border-[var(--border-main)] transition-all ${dryRunning === task.id ? 'bg-[var(--color-accent-warning)] animate-pulse' : 'hover:bg-[var(--bg-tertiary)]'}`}
                                        onClick={() => handleDryRun(task)}
                                        title={dryRunning === task.id ? t('common.cancel', { defaultValue: '취소' }) : t('syncTasks.dryRun')}
                                    >
                                        {dryRunning === task.id ? (
                                            <IconPlayerStop size={20} stroke={2} />
                                        ) : (
                                            <IconEye size={20} stroke={2} />
                                        )}
                                    </button>
                                    <button
                                        className={`p-2 border-2 border-[var(--border-main)] transition-all ${syncing === task.id ? 'bg-[var(--color-accent-error)] animate-pulse text-white' : 'bg-[var(--accent-main)] text-white hover:shadow-[2px_2px_0_0_black]'}`}
                                        onClick={() => handleSync(task)}
                                        disabled={syncing !== null && syncing !== task.id}
                                        title={syncing === task.id ? t('common.cancel', { defaultValue: '취소' }) : t('syncTasks.startSync')}
                                    >
                                        {syncing === task.id ? (
                                            <IconPlayerStop size={20} stroke={2} />
                                        ) : (
                                            <IconPlayerPlay size={20} stroke={2} />
                                        )}
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
                                    <div className="w-[2px] h-auto bg-[var(--border-main)] mx-1"></div>
                                    <button
                                        className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                                        onClick={() => setLogsTask(task)}
                                        title="View Logs"
                                    >
                                        <IconList size={20} stroke={2} />
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
