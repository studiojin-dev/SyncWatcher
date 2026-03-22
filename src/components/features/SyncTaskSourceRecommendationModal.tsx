import type { SyncTaskSourceRecommendation } from '../../utils/syncTaskSourceRecommendations';

interface SyncTaskSourceRecommendationModalProps {
  opened: boolean;
  recommendations: SyncTaskSourceRecommendation[];
  busyTaskId?: string | null;
  focusedTaskId?: string | null;
  onUpdate: (recommendation: SyncTaskSourceRecommendation) => void;
  onDismiss: (recommendation: SyncTaskSourceRecommendation) => void;
  onOpenTaskEditor: (taskId: string) => void;
  onClose: () => void;
}

function confidenceTone(label: string): string {
  if (label === 'high') {
    return 'bg-[var(--accent-success)] text-black';
  }
  if (label === 'medium') {
    return 'bg-[var(--color-accent-warning)] text-black';
  }
  return 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]';
}

function SyncTaskSourceRecommendationModal({
  opened,
  recommendations,
  busyTaskId,
  focusedTaskId,
  onUpdate,
  onDismiss,
  onOpenTaskEditor,
  onClose,
}: SyncTaskSourceRecommendationModalProps) {
  if (!opened) {
    return null;
  }

  const orderedRecommendations = [...recommendations].sort((left, right) => {
    const leftFocused = left.taskId === focusedTaskId ? 1 : 0;
    const rightFocused = right.taskId === focusedTaskId ? 1 : 0;
    return rightFocused - leftFocused;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="neo-box w-full max-w-3xl max-h-[85vh] overflow-y-auto bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
        <div className="sticky top-0 bg-[var(--bg-primary)] border-b-3 border-[var(--border-main)] p-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-heading font-black uppercase">
              SyncTask Source Review
            </h2>
            <p className="text-sm font-mono text-[var(--text-secondary)] mt-1">
              UUID가 더 이상 현재 마운트와 일치하지 않는 작업입니다. 자동 변경은 하지 않고 추천만 제공합니다.
            </p>
          </div>
          <button
            type="button"
            className="px-3 py-1 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-secondary)]"
            onClick={onClose}
          >
            CLOSE
          </button>
        </div>

        <div className="p-5 space-y-4">
          {orderedRecommendations.map((recommendation) => {
            const isBusy = busyTaskId === recommendation.taskId;
            return (
              <div
                key={`${recommendation.taskId}:${recommendation.proposedUuid}`}
                className={`border-3 border-[var(--border-main)] p-4 bg-[var(--bg-secondary)] ${
                  recommendation.taskId === focusedTaskId
                    ? 'shadow-[4px_4px_0_0_var(--accent-main)]'
                    : ''
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-heading font-black uppercase">
                        {recommendation.taskName}
                      </h3>
                      <span
                        className={`px-2 py-1 text-[10px] font-bold uppercase border-2 border-[var(--border-main)] ${confidenceTone(
                          recommendation.confidenceLabel,
                        )}`}
                      >
                        {recommendation.confidenceLabel}
                      </span>
                    </div>
                    <div className="mt-3 space-y-2 font-mono text-xs">
                      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-primary)] p-2 break-all">
                        <span className="font-bold text-[var(--color-accent-error)]">
                          CURRENT:
                        </span>{' '}
                        {recommendation.currentUuidType.toUpperCase()} {recommendation.currentUuid}
                      </div>
                      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-primary)] p-2 break-all">
                        <span className="font-bold text-[var(--accent-success)]">
                          PROPOSED:
                        </span>{' '}
                        {recommendation.proposedUuidType.toUpperCase()} {recommendation.proposedUuid}
                        <span className="block text-[var(--text-secondary)] mt-1">
                          {recommendation.proposedVolumeName} @{' '}
                          {recommendation.proposedMountPoint}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      className="px-3 py-2 bg-[var(--accent-main)] text-white border-3 border-[var(--border-main)] font-bold text-xs uppercase disabled:opacity-60"
                      onClick={() => onUpdate(recommendation)}
                      disabled={isBusy}
                    >
                      Update Task
                    </button>
                    <button
                      type="button"
                      className="px-3 py-2 border-2 border-[var(--border-main)] font-bold text-xs uppercase hover:bg-[var(--bg-primary)]"
                      onClick={() => onOpenTaskEditor(recommendation.taskId)}
                    >
                      Open Task Editor
                    </button>
                    <button
                      type="button"
                      className="px-3 py-2 border-2 border-[var(--border-main)] font-bold text-xs uppercase hover:bg-[var(--bg-primary)]"
                      onClick={() => onDismiss(recommendation)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>

                <div className="mt-3 border-t-2 border-dashed border-[var(--border-main)] pt-3">
                  <div className="text-xs font-bold uppercase mb-2">Evidence</div>
                  <ul className="space-y-1 font-mono text-xs text-[var(--text-secondary)]">
                    {recommendation.evidence.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default SyncTaskSourceRecommendationModal;
