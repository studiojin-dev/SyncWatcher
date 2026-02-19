import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPlus, IconPlayerPlay, IconEye, IconFolder, IconList, IconPlayerStop, IconFlask, IconDisc, IconSearch } from '@tabler/icons-react';
import { MultiSelect, Select } from '@mantine/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, ask } from '@tauri-apps/plugin-dialog';
import { SyncTask } from '../hooks/useSyncTasks';
import { useSyncTasksContext } from '../context/SyncTasksContext';
import { useExclusionSetsContext } from '../context/ExclusionSetsContext';
import { useSyncTaskStatusStore } from '../hooks/useSyncTaskStatus';
import { useSettings } from '../hooks/useSettings';
import { toRuntimeTask } from '../types/runtime';
import { CardAnimation, FadeIn } from '../components/ui/Animations';
import { useToast } from '../components/ui/Toast';
import YamlEditorModal from '../components/ui/YamlEditorModal';
import TaskLogsModal from '../components/features/TaskLogsModal';
import OrphanFilesModal from '../components/features/OrphanFilesModal';
import DryRunResultView from '../components/features/DryRunResultView';
import ConflictSessionListPanel from '../components/features/ConflictSessionListPanel';
import CancelConfirmModal from '../components/ui/CancelConfirmModal';
import { formatBytes } from '../utils/formatBytes';
import type {
    ConflictReviewQueueChangedEvent,
    ConflictSessionSummary,
    DryRunResult,
    SyncExecutionResult,
} from '../types/syncEngine';

/** Volume information from backend */
interface VolumeInfo {
    name: string;
    mount_point: string;
    total_bytes: number | null;
    available_bytes: number | null;
    is_network: boolean;
    is_removable: boolean;
    volume_uuid?: string;
    disk_uuid?: string;
}

const WATCH_STATE_TIMEOUT_MS = 3000;

type SubView =
    | { kind: 'list' }
    | { kind: 'logs'; taskId: string; taskName: string }
    | { kind: 'orphans'; taskId: string; source: string; target: string; excludePatterns: string[] }
    | { kind: 'dryRun'; taskName: string; result: DryRunResult };

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

async function waitForWatchState(taskId: string, watching: boolean, timeoutMs: number = WATCH_STATE_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const current = useSyncTaskStatusStore.getState().watchingTaskIds.has(taskId);
        if (current === watching) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return useSyncTaskStatusStore.getState().watchingTaskIds.has(taskId) === watching;
}

/**
 * Sync Tasks View - Manage sync tasks
 * CRUD operations with localStorage persistence
 */
function SyncTasksView() {
    const { t } = useTranslation();
    const { tasks, addTask, updateTask, deleteTask, error, reload } = useSyncTasksContext();
    const { sets, getPatternsForSets } = useExclusionSetsContext();
    const { settings } = useSettings();
    const { showToast } = useToast();
    const [showForm, setShowForm] = useState(false);
    const [editingTask, setEditingTask] = useState<SyncTask | null>(null);
    const [syncing, setSyncing] = useState<string | null>(null);
    const [subView, setSubView] = useState<SubView>({ kind: 'list' });

    // 상태 스토어 연동
    const { statuses, watchingTaskIds, queuedTaskIds } = useSyncTaskStatusStore();

    // Changing the logic: adding state for selected sets in form
    const [selectedSets, setSelectedSets] = useState<string[]>([]);

    // Directory paths state
    const [sourcePath, setSourcePath] = useState('');
    const [targetPath, setTargetPath] = useState('');

    // Watch Mode state
    const [watchMode, setWatchMode] = useState(false);
    const [autoUnmount, setAutoUnmount] = useState(false);

    // Dry Run state
    const [dryRunning, setDryRunning] = useState<string | null>(null);
    const [watchTogglePendingIds, setWatchTogglePendingIds] = useState<Set<string>>(new Set());

    // UUID source selection state
    const [sourceType, setSourceType] = useState<'path' | 'uuid'>('path');
    const [sourceUuid, setSourceUuid] = useState<string>('');
    const [sourceSubPath, setSourceSubPath] = useState<string>('');
    const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
    const [loadingVolumes, setLoadingVolumes] = useState(false);

    // Cancel confirmation state
    const [cancelConfirm, setCancelConfirm] = useState<{ type: 'sync' | 'dryRun'; taskId: string } | null>(null);
    const [conflictSessions, setConflictSessions] = useState<ConflictSessionSummary[]>([]);
    const [conflictSessionsLoading, setConflictSessionsLoading] = useState(false);

    const loadConflictSessions = useCallback(async () => {
        try {
            setConflictSessionsLoading(true);
            const sessions = await invoke<ConflictSessionSummary[]>('list_conflict_review_sessions');
            setConflictSessions(sessions);
        } catch (error) {
            console.error('Failed to load conflict sessions:', error);
        } finally {
            setConflictSessionsLoading(false);
        }
    }, []);

    const formatVolumeSize = useCallback((volume: VolumeInfo): string => {
        if (typeof volume.total_bytes !== 'number') {
            return t('dashboard.networkCapacityUnavailable', { defaultValue: 'N/A - 네트워크 연결' });
        }
        return formatBytes(volume.total_bytes, settings.dataUnitSystem);
    }, [settings.dataUnitSystem, t]);

    // 볼륨 목록 로드
    const loadVolumes = async () => {
        try {
            setLoadingVolumes(true);
            const result = await invoke<VolumeInfo[]>('get_removable_volumes');
            setVolumes(result);
        } catch (err) {
            console.error('Failed to load volumes:', err);
        } finally {
            setLoadingVolumes(false);
        }
    };

    useEffect(() => {
        if (editingTask) {
            setSelectedSets(editingTask.exclusionSets || []);
            setSourcePath(editingTask.source || '');
            setTargetPath(editingTask.target || '');
            setWatchMode(editingTask.watchMode || false);
            setAutoUnmount(editingTask.autoUnmount || false);
            // UUID 관련 상태 복원
            setSourceType(editingTask.sourceType || 'path');
            setSourceUuid(editingTask.sourceUuid || '');
            setSourceSubPath(editingTask.sourceSubPath || '');
        } else {
            setSelectedSets([]);
            setSourcePath('');
            setTargetPath('');
            setWatchMode(false);
            setAutoUnmount(false);
            // UUID 관련 상태 초기화
            setSourceType('path');
            setSourceUuid('');
            setSourceSubPath('');
        }
    }, [editingTask, showForm]);

    // 폼이 열릴 때 볼륨 목록 로드
    useEffect(() => {
        if (showForm) {
            loadVolumes();
        }
    }, [showForm]);

    useEffect(() => {
        void loadConflictSessions();

        const unlistenPromise = listen<ConflictReviewQueueChangedEvent>(
            'conflict-review-queue-changed',
            (event) => {
                setConflictSessions(event.payload.sessions);
            }
        );

        return () => {
            void unlistenPromise
                .then((unlisten) => unlisten())
                .catch((error) => {
                    console.warn('Failed to unlisten conflict-review-queue-changed', error);
                });
        };
    }, [loadConflictSessions]);

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

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);

        // UUID 모드일 때 source 경로 결정
        let finalSource = sourcePath || formData.get('source') as string;
        if (sourceType === 'uuid' && sourceUuid) {
            // UUID 모드에서는 placeholder 값 저장 (실제 경로는 동기화 시 resolve)
            finalSource = `[UUID:${sourceUuid}]${sourceSubPath}`;
        }

        const taskData = {
            name: formData.get('name') as string,
            source: finalSource,
            target: targetPath || formData.get('target') as string,
            checksumMode: formData.get('checksumMode') === 'on',
            exclusionSets: selectedSets,
            watchMode: watchMode,
            autoUnmount: autoUnmount,
            // UUID 관련 필드
            sourceType: sourceType,
            sourceUuid: sourceType === 'uuid' ? sourceUuid : undefined,
            sourceSubPath: sourceType === 'uuid' ? sourceSubPath : undefined,
        };

        try {
            const provisionalTask: SyncTask = editingTask
                ? { ...editingTask, ...taskData }
                : { id: crypto.randomUUID(), ...taskData };
            const allTasks = editingTask
                ? tasks.map((task) => (task.id === editingTask.id ? provisionalTask : task))
                : [...tasks, provisionalTask];

            await invoke('runtime_validate_tasks', {
                tasks: allTasks.map(toRuntimeTask),
            });

            if (editingTask) {
                await updateTask(editingTask.id, taskData);
                showToast(t('syncTasks.editTask') + ': ' + taskData.name, 'success');
            } else {
                await addTask(taskData);
                showToast(t('syncTasks.addTask') + ': ' + taskData.name, 'success');
            }

            setShowForm(false);
            setEditingTask(null);
        } catch (error) {
            showToast(getErrorMessage(error), 'error');
        }
    };

    const handleSync = useCallback(async (task: SyncTask) => {
        if (syncing === task.id) {
            // 이미 실행 중이면 취소 확인 모달 표시
            setCancelConfirm({ type: 'sync', taskId: task.id });
            return;
        }

        if (syncing) return; // 다른 태스크가 실행 중이면 무시

        try {
            setSyncing(task.id);
            showToast(t('syncTasks.startSync') + ': ' + task.name, 'info');

            const execution = await invoke<SyncExecutionResult>('start_sync', {
                taskId: task.id,
                taskName: task.name,
                source: task.source,
                target: task.target,
                checksumMode: task.checksumMode,
                verifyAfterCopy: true,
                excludePatterns: getPatternsForSets(task.exclusionSets || []),
            });

            if (execution.hasPendingConflicts) {
                showToast(
                    t('conflict.detectedAfterSync', {
                        count: execution.conflictCount,
                        defaultValue: `동기화 완료. ${execution.conflictCount}개 항목은 타겟이 더 최신하여 검토가 필요합니다.`,
                    }),
                    'warning'
                );
                await loadConflictSessions();

                if (execution.conflictSessionId) {
                    const openNow = await ask(
                        t('conflict.openNowPrompt', {
                            defaultValue: '지금 검토 창을 열어 처리하시겠습니까?',
                        }),
                        {
                            title: t('conflict.queueTitle', { defaultValue: '확인이 필요한 목록' }),
                            kind: 'warning',
                        }
                    );
                    if (openNow) {
                        await invoke('open_conflict_review_window', {
                            sessionId: execution.conflictSessionId,
                        });
                    }
                }
            } else {
                showToast(t('sync.syncComplete'), 'success');
            }

            // 동기화 성공 후 autoUnmount 처리
            if (task.autoUnmount) {
                if (execution.hasPendingConflicts) {
                    showToast(
                        t('conflict.autoUnmountSkipped', {
                            defaultValue: '충돌 검토가 남아 있어 자동 unmount를 생략했습니다.',
                        }),
                        'warning'
                    );
                } else {
                    try {
                        await invoke('unmount_volume', { path: task.source });
                        showToast(t('syncTasks.unmountSuccess', { defaultValue: '볼륨이 안전하게 제거되었습니다.' }), 'success');
                    } catch (unmountErr) {
                        console.error('Auto unmount failed:', unmountErr);
                        // unmount 실패는 동기화 실패는 아니므로 경고만 표시
                        showToast(t('syncTasks.unmountFailed', { defaultValue: '볼륨 제거 실패' }), 'warning');
                    }
                }
            }
        } catch (err) {
            console.error('Sync failed:', err);
            showToast(getErrorMessage(err), 'error');
        } finally {
            setSyncing(null);
        }
    }, [getPatternsForSets, loadConflictSessions, showToast, syncing, t]);

    const handleToggleWatchMode = useCallback(async (task: SyncTask) => {
        if (watchTogglePendingIds.has(task.id)) {
            return;
        }

        const previousWatchMode = task.watchMode ?? false;
        const nextWatchMode = !previousWatchMode;

        setWatchTogglePendingIds((prev) => {
            const next = new Set(prev);
            next.add(task.id);
            return next;
        });

        try {
            await updateTask(task.id, { watchMode: nextWatchMode });
            const reflected = await waitForWatchState(task.id, nextWatchMode);

            if (!reflected) {
                await updateTask(task.id, { watchMode: previousWatchMode });
                showToast(t('syncTasks.watchToggleFailed'), 'error');
                return;
            }

            showToast(nextWatchMode ? t('syncTasks.watchStarting') : t('syncTasks.watchStopping'), 'success');
        } catch (error) {
            try {
                await updateTask(task.id, { watchMode: previousWatchMode });
            } catch (rollbackError) {
                console.error('Watch toggle rollback failed:', rollbackError);
            }

            console.error('Watch toggle failed:', error);
            showToast(getErrorMessage(error), 'error');
        } finally {
            setWatchTogglePendingIds((prev) => {
                const next = new Set(prev);
                next.delete(task.id);
                return next;
            });
        }
    }, [showToast, t, updateTask, watchTogglePendingIds]);

    const handleDryRun = async (task: SyncTask) => {
        if (dryRunning === task.id) {
            // 이미 실행 중이면 취소 확인 모달 표시
            setCancelConfirm({ type: 'dryRun', taskId: task.id });
            return;
        }

        try {
            setDryRunning(task.id);
            showToast(t('syncTasks.dryRun') + '...', 'info');
            const result = await invoke<DryRunResult>('sync_dry_run', {
                taskId: task.id,
                source: task.source,
                target: task.target,
                checksumMode: task.checksumMode,
                excludePatterns: getPatternsForSets(task.exclusionSets || []),
            });
            showToast(t('syncTasks.dryRun') + ' ' + t('common.success'), 'success');
            setSubView({
                kind: 'dryRun',
                taskName: task.name,
                result,
            });
        } catch (err) {
            console.error('Dry run failed:', err);
            showToast(String(err), 'error');
        } finally {
            setDryRunning(null);
        }
    };

    const handleDelete = async (task: SyncTask) => {
        const confirmed = await ask(
            t('syncTasks.confirmDelete', { defaultValue: 'Are you sure you want to delete this task?' }),
            {
                title: t('syncTasks.deleteTask', { defaultValue: 'Delete Task' }),
                kind: 'warning',
            }
        );

        if (confirmed) {
            try {
                await deleteTask(task.id);
                showToast(t('syncTasks.deleteTask') + ': ' + task.name, 'warning');
            } catch (error) {
                showToast(getErrorMessage(error), 'error');
            }
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

    const handleOpenConflictSession = useCallback(async (sessionId: string) => {
        try {
            await invoke('open_conflict_review_window', { sessionId });
        } catch (error) {
            showToast(getErrorMessage(error), 'error');
        }
    }, [showToast]);

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

                                    {/* 소스 타입 선택 */}
                                    <div className="flex gap-4 mb-2">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="sourceType"
                                                checked={sourceType === 'path'}
                                                onChange={() => setSourceType('path')}
                                                className="w-4 h-4"
                                            />
                                            <span className="text-sm font-mono">📁 {t('syncTasks.sourceTypePath', { defaultValue: '디렉토리 경로' })}</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="sourceType"
                                                checked={sourceType === 'uuid'}
                                                onChange={() => setSourceType('uuid')}
                                                className="w-4 h-4"
                                            />
                                            <span className="text-sm font-mono">💾 {t('syncTasks.sourceTypeUuid', { defaultValue: '볼륨 UUID' })}</span>
                                        </label>
                                    </div>

                                    {/* 경로 모드 */}
                                    {sourceType === 'path' && (
                                        <div className="flex gap-2">
                                            <input
                                                name="source"
                                                value={sourcePath}
                                                onChange={(e) => setSourcePath(e.target.value)}
                                                required={sourceType === 'path'}
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
                                    )}

                                    {/* UUID 모드 */}
                                    {sourceType === 'uuid' && (
                                        <div className="space-y-2">
                                            <Select
                                                placeholder={loadingVolumes ? '로딩 중...' : t('syncTasks.selectVolume', { defaultValue: '볼륨 선택' })}
                                                data={volumes.map(v => ({
                                                    value: v.disk_uuid || '',
                                                    label: `${v.name} (${formatVolumeSize(v)})`,
                                                    disabled: !v.disk_uuid,
                                                }))}
                                                value={sourceUuid}
                                                onChange={(value) => {
                                                    setSourceUuid(value || '');
                                                    // 선택된 볼륨의 마운트 포인트를 sourcePath에도 저장
                                                    const vol = volumes.find(v => v.disk_uuid === value);
                                                    if (vol) {
                                                        setSourcePath(vol.mount_point);
                                                    }
                                                }}
                                                searchable
                                                required={sourceType === 'uuid'}
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
                                                    }
                                                }}
                                            />
                                            {sourceUuid && (
                                                <div className="text-xs font-mono text-[var(--text-secondary)] bg-[var(--bg-secondary)] p-2 border-2 border-dashed border-[var(--border-main)]">
                                                    <span className="font-bold">UUID:</span> {sourceUuid}
                                                </div>
                                            )}
                                            <div>
                                                <label className="block text-xs font-bold mb-1 uppercase font-mono text-[var(--text-secondary)]">
                                                    {t('syncTasks.subPath', { defaultValue: '하위 경로' })}
                                                </label>
                                                <input
                                                    name="sourceSubPath"
                                                    value={sourceSubPath}
                                                    onChange={(e) => setSourceSubPath(e.target.value)}
                                                    className="neo-input font-mono text-sm"
                                                    placeholder={t('syncTasks.subPathPlaceholder', { defaultValue: '/DCIM/100MSDCF' })}
                                                />
                                            </div>
                                        </div>
                                    )}
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
                                                }}
                                                className="peer sr-only"
                                            />
                                            <div className="w-6 h-6 border-3 border-[var(--border-main)] bg-white peer-checked:bg-[var(--accent-success)] transition-colors"></div>
                                            <div className="absolute inset-0 hidden peer-checked:flex items-center justify-center text-white pointer-events-none">✓</div>
                                        </div>
                                        <span className="font-bold text-sm uppercase">{t('syncTasks.watchMode')}</span>
                                    </label>
                                    {watchMode && (
                                        <div className="ml-8 p-2 bg-[var(--accent-success)]/10 border-2 border-[var(--accent-success)] text-sm text-[var(--text-primary)] font-mono">
                                            ℹ️ {t('syncTasks.watchModeDesc')}
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

            {subView.kind === 'logs' ? (
                <TaskLogsModal
                    taskId={subView.taskId}
                    taskName={subView.taskName}
                    onBack={() => setSubView({ kind: 'list' })}
                />
            ) : null}

            {subView.kind === 'orphans' ? (
                <OrphanFilesModal
                    taskId={subView.taskId}
                    source={subView.source}
                    target={subView.target}
                    excludePatterns={subView.excludePatterns}
                    onBack={() => setSubView({ kind: 'list' })}
                />
            ) : null}

            {subView.kind === 'dryRun' ? (
                <DryRunResultView
                    taskName={subView.taskName}
                    result={subView.result}
                    onBack={() => setSubView({ kind: 'list' })}
                />
            ) : null}

            {/* Task List */}
            {subView.kind === 'list' ? (
                <div className="grid gap-6">
                <ConflictSessionListPanel
                    sessions={conflictSessions}
                    loading={conflictSessionsLoading}
                    onRefresh={() => {
                        void loadConflictSessions();
                    }}
                    onOpenSession={(sessionId) => {
                        void handleOpenConflictSession(sessionId);
                    }}
                />
                {tasks.map((task, index) => (
                    <CardAnimation key={task.id} index={index}>
                        <div className="neo-box p-5 relative transition-opacity">
                            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                                <div className="min-w-0 flex-1 w-full"> {/* min-w-0 ensures truncation works */}
                                    <div className="flex items-center gap-3 mb-2">
                                        <h3 className="text-lg font-heading font-black uppercase tracking-tight truncate">
                                            {task.name}
                                        </h3>
                                        <div className="flex gap-1.5 items-center">
                                            {/* CHK Badge */}
                                            <span className={`px-1.5 py-0.5 text-[10px] font-bold border-2 transition-colors ${task.checksumMode
                                                ? 'border-black bg-[var(--color-accent-warning)] text-black'
                                                : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                                                }`} title="Checksum Mode">
                                                CHK
                                            </span>

                                            {/* WATCH Badge (Icon) */}
                                            <span className={`p-0.5 border-2 transition-colors flex items-center justify-center ${task.watchMode
                                                ? 'border-black bg-[var(--accent-success)] text-white'
                                                : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                                                }`} title="Watch Mode">
                                                <IconEye size={12} stroke={3} />
                                            </span>

                                            {/* UNMNT Badge (Icon) */}
                                            <span className={`p-0.5 border-2 transition-colors flex items-center justify-center ${task.autoUnmount
                                                ? 'border-black bg-[var(--accent-main)] text-white'
                                                : 'border-[var(--border-main)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-40 grayscale'
                                                }`} title="Auto Unmount">
                                                <IconDisc size={12} stroke={3} />
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex gap-2 pb-2 shrink-0 md:self-start self-end mt-2 md:mt-0">
                                        <button
                                            className={`p-2 border-2 border-[var(--border-main)] transition-all ${dryRunning === task.id ? 'bg-[var(--color-accent-warning)] animate-pulse' : 'hover:bg-[var(--bg-tertiary)]'}`}
                                            onClick={() => handleDryRun(task)}
                                            title={dryRunning === task.id ? t('common.cancel', { defaultValue: '취소' }) : t('syncTasks.dryRun')}
                                        >
                                            {dryRunning === task.id ? (
                                                <IconPlayerStop size={20} stroke={2} />
                                            ) : (
                                                <IconFlask size={20} stroke={2} />
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
                                        <button
                                            className={`p-2 border-2 border-[var(--border-main)] transition-all ${watchTogglePendingIds.has(task.id)
                                                ? 'opacity-60 cursor-not-allowed'
                                                : watchingTaskIds.has(task.id)
                                                    ? 'bg-[var(--accent-success)] text-white'
                                                    : 'hover:bg-[var(--bg-tertiary)]'
                                                }`}
                                            onClick={() => handleToggleWatchMode(task)}
                                            disabled={watchTogglePendingIds.has(task.id)}
                                            title={(task.watchMode ?? false)
                                                ? t('syncTasks.watchToggleOff')
                                                : t('syncTasks.watchToggleOn')}
                                        >
                                            <IconEye size={20} stroke={2} />
                                        </button>
                                        {queuedTaskIds.has(task.id) && (
                                            <span className="px-2 py-1 text-[10px] font-bold border-2 border-[var(--border-main)] bg-[var(--color-accent-warning)] text-black">
                                                QUEUED
                                            </span>
                                        )}
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
                                        <button
                                            className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                                            onClick={() => setSubView({
                                                kind: 'orphans',
                                                taskId: task.id,
                                                source: task.source,
                                                target: task.target,
                                                excludePatterns: getPatternsForSets(task.exclusionSets || []),
                                            })}
                                            title={t('orphan.title', { defaultValue: 'Orphan Files' })}
                                        >
                                            <IconSearch size={20} stroke={2} />
                                        </button>
                                        <div className="w-[2px] h-auto bg-[var(--border-main)] mx-1"></div>
                                        <button
                                            className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                                            onClick={() => setSubView({
                                                kind: 'logs',
                                                taskId: task.id,
                                                taskName: task.name,
                                            })}
                                            title="View Logs"
                                        >
                                            <IconList size={20} stroke={2} />
                                        </button>
                                    </div>
                                    {/* Path Display with Overflow Protection */}
                                    <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] mb-1 break-all">
                                        <span className="font-bold text-[var(--accent-main)]">SRC:</span> {task.source}
                                    </div>
                                    <div className="font-mono text-xs bg-[var(--bg-secondary)] p-2 border-2 border-[var(--border-main)] break-all">
                                        <span className="font-bold text-[var(--accent-success)]">DST:</span> {task.target}
                                    </div>

                                    {/* 최종 로그 표시 영역 */}
                                    {/* 최종 로그 표시 영역 - Fixed height and truncation to prevent jitter */}
                                    {/* 최종 로그 표시 영역 - Fixed height and truncation to prevent jitter */}
                                    <div className="mt-2 h-8 px-2 border-2 border-dashed border-[var(--border-main)] bg-[var(--bg-tertiary)] font-mono text-xs flex items-center min-w-0 w-full overflow-hidden">
                                        {(() => {
                                            const taskStatus = statuses.get(task.id);
                                            if (taskStatus?.lastLog) {
                                                return (
                                                    <div className="flex-1 min-w-0 flex items-center">
                                                        <span className="text-[var(--text-secondary)] mr-2 shrink-0 whitespace-nowrap">
                                                            [{taskStatus.lastLog.timestamp}]
                                                        </span>
                                                        <span
                                                            className={`block truncate flex-1 min-w-0 ${taskStatus.lastLog.level === 'success' ? 'text-[var(--accent-success)]' :
                                                                taskStatus.lastLog.level === 'error' ? 'text-[var(--color-accent-error)]' :
                                                                    taskStatus.lastLog.level === 'warning' ? 'text-[var(--color-accent-warning)]' :
                                                                        'text-[var(--text-primary)]'
                                                                }`}
                                                            title={taskStatus.lastLog.message}
                                                        >
                                                            {taskStatus.lastLog.message}
                                                        </span>
                                                    </div>
                                                );
                                            }
                                            return <span className="text-[var(--text-secondary)] opacity-50 shrink-0">Waiting for logs...</span>;
                                        })()}
                                    </div>
                                </div>


                            </div>
                        </div>
                    </CardAnimation>
                ))}
                </div>
            ) : null}
        </div >
    );
}

export default SyncTasksView;
