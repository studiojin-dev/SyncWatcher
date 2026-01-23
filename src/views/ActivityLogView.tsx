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
      <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-b-3 border-[var(--border-main)]">
        <h1 className="text-2xl font-heading font-black uppercase mb-1">
          {t('activityLog.title')}
        </h1>
        <div className="font-mono text-xs">
          {logs.length > 0 ? `// ${logs.length} ENTRIES_LOGGED` : '// SYSTEM_IDLE'}
        </div>
      </header>

      <div className="flex gap-4 mb-6 border-b-2 border-dashed border-[var(--border-main)] pb-4">
        <button
          onClick={loadLogs}
          className={`px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] transition-all ${filter === 'all' ? 'bg-[var(--text-primary)] text-[var(--bg-primary)] shadow-[4px_4px_0_0_var(--shadow-color)]' : 'hover:bg-[var(--bg-tertiary)]'}`}
        >
          All Logs
        </button>
        <button
          onClick={loadLogs}
          className={`px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] transition-all ${filter === 'system' ? 'bg-[var(--text-primary)] text-[var(--bg-primary)] shadow-[4px_4px_0_0_var(--shadow-color)]' : 'hover:bg-[var(--bg-tertiary)]'}`}
        >
          System Logs
        </button>
      </div>

      <div className="neo-box p-4 min-h-[400px] max-h-[600px] overflow-y-auto font-mono text-sm bg-[var(--bg-primary)]">
        {logs.map((log) => (
          <div key={log.id} className="border-b border-[var(--border-main)] last:border-0 py-3 flex gap-4 hover:bg-[var(--bg-secondary)] px-2 transition-colors">
            <div className="min-w-[40px] pt-1">
              {getLevelIcon(log.level)}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
                  [{log.timestamp}]
                </span>
                {log.taskId && (
                  <span className="px-1 py-0 text-[10px] border border-[var(--border-main)] bg-[var(--bg-tertiary)]">
                    TASK:{log.taskId}
                  </span>
                )}
              </div>
              <div className="text-[var(--text-primary)] font-medium break-all">
                {log.message}
              </div>
            </div>
          </div>
        ))}
        {logs.length === 0 && (
          <div className="text-center py-12 text-[var(--text-secondary)] opacity-50">
            - NO LOG DATA AVAILABLE -
          </div>
        )}
      </div>
    </div>
  );
}

export default ActivityLogView;
