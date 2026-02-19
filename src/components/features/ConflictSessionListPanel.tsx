import { IconExternalLink, IconRefresh, IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ConflictSessionSummary } from '../../types/syncEngine';

interface ConflictSessionListPanelProps {
  sessions: ConflictSessionSummary[];
  loading: boolean;
  onRefresh: () => void;
  onOpenSession: (sessionId: string) => void;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

export default function ConflictSessionListPanel({
  sessions,
  loading,
  onRefresh,
  onOpenSession,
}: ConflictSessionListPanelProps) {
  const { t } = useTranslation();

  return (
    <section className="neo-box p-4 bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-lg font-heading font-bold uppercase">
            {t('conflict.queueTitle', { defaultValue: '확인이 필요한 목록' })}
          </h3>
          <p className="text-xs font-mono text-[var(--text-secondary)]">
            {sessions.length === 0
              ? t('conflict.queueEmpty', { defaultValue: '대기 중인 충돌 세션이 없습니다.' })
              : t('conflict.queueCount', {
                count: sessions.length,
                defaultValue: `${sessions.length} session(s)`,
              })}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          <IconRefresh size={14} className={loading ? 'animate-spin' : ''} />
          {t('common.refresh', { defaultValue: 'Refresh' })}
        </button>
      </div>

      <p className="text-[11px] font-mono text-[var(--text-secondary)] mb-3 border-2 border-dashed border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
        <IconAlertTriangle size={12} className="inline-block mr-1" />
        {t('conflict.queuePersistenceNote', {
          defaultValue: '세션은 앱이 종료되면 초기화됩니다.',
        })}
      </p>

      <div className="space-y-2">
        {sessions.length === 0 ? (
          <div className="text-sm font-mono text-[var(--text-secondary)] p-2">
            {t('conflict.queueNoItems', { defaultValue: '검토할 항목이 없습니다.' })}
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className="border-2 border-[var(--border-main)] p-3 bg-[var(--bg-secondary)] flex flex-col md:flex-row md:items-center gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs break-all">
                  {session.taskName} · {session.taskId}
                </div>
                <div className="text-[10px] font-mono text-[var(--text-secondary)] break-all">
                  {session.sourceRoot} → {session.targetRoot}
                </div>
                <div className="text-[10px] font-mono text-[var(--text-secondary)]">
                  {formatDate(session.createdAtUnixMs)} · pending {session.pendingCount}/
                  {session.totalCount}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenSession(session.id)}
                className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
              >
                <IconExternalLink size={14} />
                {t('conflict.openReview', { defaultValue: '검토 창 열기' })}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
