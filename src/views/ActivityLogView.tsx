import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  taskId?: string;
}

function ActivityLogView() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter] = useState<'all' | 'system' | 'task'>('all');

  const loadLogs = async () => {
    const result = await invoke<LogEntry[]>('get_system_logs');
    setLogs(result);
  };

  const getLevelIcon = (level: LogEntry['level']) => {
    switch (level) {
      case 'info':
        return <div style={{ color: 'var(--status-success-text)' }}>ℹ️</div>;
      case 'warning':
        return <div style={{ color: 'var(--status-warning-text)' }}>⚠️</div>;
      case 'error':
        return <div style={{ color: 'var(--status-error-text)' }}>❌</div>;
    }
  };

  return (
    <div>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 className="text-xl">{t('activityLog.title')}</h1>
        <p className="text-secondary text-sm">
          {logs.length > 0 ? `${logs.length} entries` : t('activityLog.noLogs')}
        </p>
      </header>

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <button
          onClick={loadLogs}
          className={filter === 'all' ? 'btn-primary' : 'btn-ghost'}
        >
          All Logs
        </button>
        <button
          onClick={loadLogs}
          className={filter === 'system' ? 'btn-primary' : 'btn-ghost'}
        >
          System Logs
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {logs.map((log) => (
          <div key={log.id} className="card">
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '40px' }}>
                {getLevelIcon(log.level)}
              </div>
              <div style={{ flex: 1 }}>
                <div className="text-xs text-tertiary">{log.timestamp}</div>
                <div className="text-sm">{log.message}</div>
                {log.taskId && (
                  <div className="text-xs text-tertiary">Task: {log.taskId}</div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ActivityLogView;
