import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { IconRefresh } from '@tabler/icons-react';

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
  const [loading, setLoading] = useState(false);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const result = await invoke<LogEntry[]>('get_system_logs');
      // 최신 로그가 상단에 오도록 정렬
      setLogs(result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

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
      <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-heading font-black uppercase mb-1">
              {t('activityLog.title')}
            </h1>
            <div className="font-mono text-xs border-l-4 border-[var(--accent-main)] pl-3">
              {logs.length > 0 ? `// ${logs.length} ENTRIES_LOGGED` : '// SYSTEM_IDLE'}
            </div>
          </div>
          <button
            onClick={loadLogs}
            disabled={loading}
            className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] flex items-center gap-2 transition-all shadow-[2px_2px_0_0_var(--shadow-color)] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
          >
            <IconRefresh size={18} className={loading ? 'animate-spin' : ''} />
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>
      </header>

      <div className="neo-box p-4 min-h-[400px] max-h-[600px] overflow-y-auto font-mono text-sm bg-[var(--bg-primary)]">
        {logs.map((log) => (
          <div key={log.id} className="border-b border-[var(--border-main)] last:border-0 py-3 flex gap-4 hover:bg-[var(--bg-secondary)] px-2 transition-colors">
            <div className="min-w-[40px] pt-1 shrink-0">
              {getLevelIcon(log.level)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
                  [{log.timestamp}]
                </span>
                {log.taskId && (
                  <span className="px-1 py-0 text-[10px] border border-[var(--border-main)] bg-[var(--bg-tertiary)]">
                    TASK:{log.taskId}
                  </span>
                )}
              </div>
              <div className="text-[var(--text-primary)] font-medium break-words whitespace-pre-wrap overflow-wrap-anywhere">
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

