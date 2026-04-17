import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { IconRefresh, IconArrowDown, IconArrowLeft } from '@tabler/icons-react';
import { CardAnimation } from '../ui/Animations';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface LogEntry {
    id: string;
    timestamp: string;
    level: string;
    message: string;
    task_id?: string;
    category?: string;
}

interface LogBatchEvent {
    task_id?: string;
    entries: LogEntry[];
}

interface TaskLogsModalProps {
    taskId: string;
    taskName: string;
    onBack: () => void;
}

function appendLogEntries(previousLogs: LogEntry[], nextEntries: LogEntry[]): LogEntry[] {
    if (nextEntries.length === 0) {
        return previousLogs;
    }

    const newLogs = [...previousLogs, ...nextEntries];
    if (newLogs.length > 10000) {
        return newLogs.slice(newLogs.length - 10000);
    }

    return newLogs;
}

export default function TaskLogsModal({ taskId, taskName, onBack }: TaskLogsModalProps) {
    const { t } = useTranslation();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const virtuoso = useRef<VirtuosoHandle>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const data = await invoke<LogEntry[]>('get_task_logs', { taskId });
            // Sort by timestamp ascending (oldest first) for log view usually
            const sorted = data
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            setLogs(sorted);

            // Scroll to bottom after load
            setTimeout(() => virtuoso.current?.scrollToIndex({ index: sorted.length - 1, align: 'end' }), 100);
        } catch (error) {
            console.error('Failed to fetch logs:', error);
        } finally {
            setLoading(false);
        }
    }, [taskId]);

    useEffect(() => {
        // Initial fetch
        void fetchLogs();

        // Listen for new log events (Single)
        const unlistenSinglePromise = listen<{ task_id?: string; entry: LogEntry }>('new-log-task', (event) => {
            if (event.payload.task_id === taskId) {
                setLogs((prevLogs) => appendLogEntries(prevLogs, [event.payload.entry]));
            }
        });
        const unlistenBatchPromise = listen<LogBatchEvent>('new-logs-batch', (event) => {
            if ((event.payload.task_id ?? taskId) !== taskId) {
                return;
            }

            setLogs((prevLogs) => appendLogEntries(prevLogs, event.payload.entries));
        });

        let active = true;
        let batchSubscriptionId: string | null = null;
        const unsubscribeTaskLogBatches = async () => {
            if (!batchSubscriptionId) {
                return false;
            }

            const subscriptionId = batchSubscriptionId;
            batchSubscriptionId = null;
            return invoke<boolean>('unsubscribe_task_log_batches', {
                subscriptionId,
            });
        };
        const batchChannel = new Channel<LogBatchEvent>((batch) => {
            if ((batch.task_id ?? taskId) !== taskId) {
                return;
            }

            setLogs((prevLogs) => appendLogEntries(prevLogs, batch.entries));
        });

        const subscriptionPromise = invoke<string>('subscribe_task_log_batches', {
            taskId,
            batchChannel,
        })
            .then((subscriptionId) => {
                batchSubscriptionId = subscriptionId;
                if (!active) {
                    return unsubscribeTaskLogBatches();
                }

                return true;
            })
            .catch((error) => {
                console.error('Failed to subscribe task log batches:', error);
                return false;
            });

        // Cleanup listener on unmount
        return () => {
            active = false;
            unlistenSinglePromise.then(unlisten => unlisten());
            unlistenBatchPromise.then(unlisten => unlisten());
            void subscriptionPromise
                .then(() => unsubscribeTaskLogBatches())
                .catch((error) => {
                    console.warn('Failed to unsubscribe task log batches:', error);
                });
        };
    }, [fetchLogs, taskId]);

    useEffect(() => {
        if (autoScroll && logs.length > 0) {
            virtuoso.current?.scrollToIndex({ index: logs.length - 1, align: 'end', behavior: 'auto' });
        }
    }, [logs, autoScroll]);

    const getLevelColor = (level: string) => {
        switch (level.toLowerCase()) {
            case 'error': return 'text-[var(--accent-error)]';
            case 'warning': return 'text-[var(--accent-warning)]';
            case 'success': return 'text-[var(--accent-success)]';
            default: return 'text-[var(--text-secondary)]';
        }
    };

    return (
        <div className="w-full">
            <CardAnimation>
                <div className="neo-box w-full h-[72vh] min-h-[360px] max-h-[760px] flex flex-col bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                    {/* Header */}
                    <div className="flex justify-between items-center p-4 border-b-3 border-[var(--border-main)] bg-[var(--bg-secondary)]">
                        <div>
                            <h3 className="text-lg font-heading font-bold uppercase">
                                {t('logs.title', { defaultValue: 'TASK LOGS' })}
                            </h3>
                            <p className="text-xs font-mono text-[var(--text-secondary)]">
                                {taskName} ({taskId}) • {logs.length} Lines
                            </p>
                        </div>
                        <div className="flex gap-2 items-center">
                            <button
                                onClick={() => setAutoScroll(!autoScroll)}
                                className={`p-2 transition-colors border-2 ${autoScroll ? 'bg-[var(--accent-main)] text-white border-[var(--border-main)]' : 'border-[var(--border-main)] text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]'}`}
                                title="Auto Scroll"
                            >
                                <IconArrowDown size={20} />
                            </button>
                            <button
                                onClick={fetchLogs}
                                className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                                title={t('common.refresh', { defaultValue: 'Refresh' })}
                            >
                                <IconRefresh size={20} />
                            </button>
                            <button
                                onClick={onBack}
                                className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)] inline-flex items-center gap-1"
                            >
                                <IconArrowLeft size={14} />
                                {t('common.back', { defaultValue: 'Back' })}
                            </button>
                        </div>
                    </div>

                    {/* Logs Content - Virtual List */}
                    <div className="flex-1 min-h-0 p-0 font-mono text-xs bg-[var(--bg-primary)] overflow-hidden relative">
                        {loading ? (
                            <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">
                                Loading...
                            </div>
                        ) : logs.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">
                                No logs found.
                            </div>
                        ) : (
                            <Virtuoso
                                ref={virtuoso}
                                style={{ height: '100%' }}
                                data={logs}
                                atBottomStateChange={(atBottom) => setAutoScroll(atBottom)}
                                totalCount={logs.length}
                                itemContent={(_index, log) => (
                                    <div className="flex gap-3 hover:bg-[var(--bg-secondary)] px-4 py-1">
                                        <span className="text-[var(--text-tertiary)] shrink-0 w-[140px]">
                                            {new Date(log.timestamp).toLocaleTimeString()}
                                        </span>
                                        <span className={`font-bold shrink-0 w-[60px] uppercase ${getLevelColor(log.level)}`}>
                                            [{log.level}]
                                        </span>
                                        <span className="break-all whitespace-pre-wrap flex-1">
                                            {log.message}
                                        </span>
                                    </div>
                                )}
                                followOutput={autoScroll ? 'auto' : false}
                            />
                        )}
                    </div>
                </div>
            </CardAnimation>
        </div>
    );
}
