import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { IconX, IconRefresh, IconArrowDown } from '@tabler/icons-react';
import { CardAnimation } from '../ui/Animations';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

interface LogEntry {
    id: string;
    timestamp: string;
    level: string;
    message: string;
    task_id?: string;
}

interface LogBatchEvent {
    task_id?: string;
    entries: LogEntry[];
}

interface TaskLogsModalProps {
    taskId: string;
    taskName: string;
    onClose: () => void;
}

export default function TaskLogsModal({ taskId, taskName, onClose }: TaskLogsModalProps) {
    const { t } = useTranslation();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const virtuoso = useRef<VirtuosoHandle>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const data = await invoke<LogEntry[]>('get_task_logs', { taskId });
            // Sort by timestamp ascending (oldest first) for log view usually
            const sorted = data.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            setLogs(sorted);

            // Scroll to bottom after load
            setTimeout(() => virtuoso.current?.scrollToIndex({ index: sorted.length - 1, align: 'end' }), 100);
        } catch (error) {
            console.error('Failed to fetch logs:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // Initial fetch
        fetchLogs();

        // Listen for new log events (Single)
        const unlistenSinglePromise = listen<{ task_id?: string; entry: LogEntry }>('new-log-task', (event) => {
            if (event.payload.task_id === taskId) {
                setLogs(prevLogs => {
                    const newLogs = [...prevLogs, event.payload.entry];
                    // Keep max 10000 logs (matches backend)
                    if (newLogs.length > 10000) {
                        return newLogs.slice(newLogs.length - 10000);
                    }
                    return newLogs;
                });
            }
        });

        // Listen for new log events (Batch)
        const unlistenBatchPromise = listen<LogBatchEvent>('new-logs-batch', (event) => {
            if (event.payload.task_id === taskId) {
                setLogs(prevLogs => {
                    const newLogs = [...prevLogs, ...event.payload.entries];
                    if (newLogs.length > 10000) {
                        return newLogs.slice(newLogs.length - 10000);
                    }
                    return newLogs;
                });
            }
        });

        // Cleanup listener on unmount
        return () => {
            unlistenSinglePromise.then(unlisten => unlisten());
            unlistenBatchPromise.then(unlisten => unlisten());
        };
    }, [taskId]);

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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <CardAnimation>
                <div className="neo-box w-full max-w-4xl h-[700px] flex flex-col bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
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
                                className={`p-2 rounded-full transition-colors border-2 ${autoScroll ? 'bg-[var(--accent-main)] text-white border-black' : 'bg-transparent border-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]'}`}
                                title="Auto Scroll"
                            >
                                <IconArrowDown size={20} />
                            </button>
                            <button
                                onClick={fetchLogs}
                                className="p-2 hover:bg-[var(--bg-tertiary)] rounded-full transition-colors"
                                title={t('common.refresh', { defaultValue: 'Refresh' })}
                            >
                                <IconRefresh size={20} />
                            </button>
                            <button
                                onClick={onClose}
                                className="p-2 hover:bg-[var(--accent-error)] hover:text-white rounded-full transition-colors"
                            >
                                <IconX size={20} />
                            </button>
                        </div>
                    </div>

                    {/* Logs Content - Virtual List */}
                    <div className="flex-1 p-0 font-mono text-xs bg-[var(--bg-primary)] overflow-hidden relative">
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
