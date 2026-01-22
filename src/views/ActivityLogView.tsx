import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconX, IconLoader2 } from '@tabler/icons-react';

interface ActivityEntry {
    id: string;
    date: string;
    source: string;
    target: string;
    status: 'success' | 'failed' | 'inProgress';
    filesCopied: number;
    bytesCopied: number;
    errors: number;
}

const STORAGE_KEY = 'syncwatcher_activity';

/**
 * Activity Log View - Sync history
 * Shows past sync operations with status
 */
function ActivityLogView() {
    const { t } = useTranslation();
    const [logs, setLogs] = useState<ActivityEntry[]>([]);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                setLogs(JSON.parse(stored));
            }
        } catch (err) {
            console.error('Failed to load activity logs:', err);
        }
    }, []);

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    };

    const formatDate = (dateStr: string): string => {
        const date = new Date(dateStr);
        return date.toLocaleString();
    };

    const getStatusIcon = (status: ActivityEntry['status']) => {
        switch (status) {
            case 'success':
                return <IconCheck size={16} className="text-primary" style={{ color: 'var(--status-success-text)' }} />;
            case 'failed':
                return <IconX size={16} style={{ color: 'var(--status-error-text)' }} />;
            case 'inProgress':
                return <IconLoader2 size={16} className="text-secondary" style={{ animation: 'spin 1s linear infinite' }} />;
        }
    };

    const getStatusBg = (status: ActivityEntry['status']) => {
        switch (status) {
            case 'success':
                return 'var(--status-success-bg)';
            case 'failed':
                return 'var(--status-error-bg)';
            case 'inProgress':
                return 'var(--status-warning-bg)';
        }
    };

    return (
        <div className="fade-in">
            <header style={{ marginBottom: 'var(--space-8)' }}>
                <h1 className="text-xl" style={{ fontWeight: 'var(--weight-normal)', marginBottom: 'var(--space-2)' }}>
                    {t('activityLog.title')}
                </h1>
                <p className="text-secondary text-sm">
                    {logs.length > 0 ? `${logs.length} entries` : t('activityLog.noLogs')}
                </p>
            </header>

            {logs.length === 0 ? (
                <div className="card text-center text-secondary" style={{ padding: 'var(--space-10)' }}>
                    <p>{t('activityLog.noLogs')}</p>
                    <p className="text-xs text-tertiary" style={{ marginTop: 'var(--space-2)' }}>
                        Activity will appear here after sync operations
                    </p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                    {logs.map((log) => (
                        <div
                            key={log.id}
                            className="card"
                            style={{ background: getStatusBg(log.status) }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                                    {getStatusIcon(log.status)}
                                    <div>
                                        <div className="text-sm" style={{ marginBottom: 'var(--space-1)' }}>
                                            {formatDate(log.date)}
                                        </div>
                                        <div className="text-xs text-tertiary font-mono">
                                            {log.source} → {log.target}
                                        </div>
                                    </div>
                                </div>
                                <div className="text-right text-xs text-secondary">
                                    <div>{log.filesCopied} files</div>
                                    <div>{formatBytes(log.bytesCopied)}</div>
                                    {log.errors > 0 && (
                                        <div style={{ color: 'var(--status-error-text)' }}>
                                            {log.errors} errors
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
        </div>
    );
}

export default ActivityLogView;
