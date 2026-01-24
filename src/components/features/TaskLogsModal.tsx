import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { IconX, IconRefresh } from '@tabler/icons-react';
import { CardAnimation } from '../ui/Animations';

interface LogEntry {
    id: string;
    timestamp: string;
    level: string;
    message: string;
    task_id?: string;
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

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const data = await invoke<LogEntry[]>('get_task_logs', { taskId });
            // Sort by timestamp descending (newest first)
            setLogs(data.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
        } catch (error) {
            console.error('Failed to fetch logs:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
    }, [taskId]);

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
                <div className="neo-box w-full max-w-3xl h-[600px] flex flex-col bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                    {/* Header */}
                    <div className="flex justify-between items-center p-4 border-b-3 border-[var(--border-main)] bg-[var(--bg-secondary)]">
                        <div>
                            <h3 className="text-lg font-heading font-bold uppercase">
                                {t('logs.title', { defaultValue: 'TASK LOGS' })}
                            </h3>
                            <p className="text-xs font-mono text-[var(--text-secondary)]">
                                {taskName} ({taskId})
                            </p>
                        </div>
                        <div className="flex gap-2">
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

                    {/* Logs Content */}
                    <div className="flex-1 overflow-auto p-4 font-mono text-xs bg-[var(--bg-primary)]">
                        {loading ? (
                            <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">
                                Loading...
                            </div>
                        ) : logs.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">
                                No logs found.
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {logs.map((log) => (
                                    <div key={log.id} className="flex gap-3 hover:bg-[var(--bg-secondary)] p-1 rounded">
                                        <span className="text-[var(--text-tertiary)] shrink-0 min-w-[140px]">
                                            {new Date(log.timestamp).toLocaleString()}
                                        </span>
                                        <span className={`font-bold shrink-0 min-w-[60px] uppercase ${getLevelColor(log.level)}`}>
                                            [{log.level}]
                                        </span>
                                        <span className="break-all whitespace-pre-wrap">
                                            {log.message}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </CardAnimation>
        </div>
    );
}
