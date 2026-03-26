import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CardAnimation } from '../ui/Animations';
import type { RuntimeTaskValidationIssue } from '../../types/runtime';

interface SyncTaskValidationErrorModalProps {
  opened: boolean;
  issue: RuntimeTaskValidationIssue | null;
  summary: string;
  ruleDescription: string;
  onClose: () => void;
}

export default function SyncTaskValidationErrorModal({
  opened,
  issue,
  summary,
  ruleDescription,
  onClose,
}: SyncTaskValidationErrorModalProps) {
  const { t } = useTranslation();

  const affectedTaskNames = useMemo(() => {
    if (!issue) {
      return [];
    }

    const names: string[] = [];

    if (issue.taskName) {
      names.push(issue.taskName);
    } else if (issue.taskId) {
      names.push(issue.taskId);
    }

    const relatedTaskCount = Math.max(
      issue.conflictingTaskNames.length,
      issue.conflictingTaskIds.length,
    );

    for (let index = 0; index < relatedTaskCount; index += 1) {
      const relatedName = issue.conflictingTaskNames[index];
      const relatedId = issue.conflictingTaskIds[index];
      if (relatedName) {
        names.push(relatedName);
      } else if (relatedId) {
        names.push(relatedId);
      }
    }

    return [...new Set(names)];
  }, [issue]);

  if (!opened || !issue) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <CardAnimation>
        <div className="neo-box p-6 w-full max-w-2xl bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
          <h3 className="text-xl font-heading font-bold mb-3 uppercase text-[var(--color-accent-error)]">
            {t('syncTasks.validationModal.title', {
              defaultValue: 'Validation Error',
            })}
          </h3>
          <p className="mb-3 text-[var(--text-primary)] font-mono text-sm whitespace-pre-wrap">
            {summary}
          </p>
          <p className="mb-5 text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
            {ruleDescription}
          </p>

          <div className="space-y-3 mb-6">
            {affectedTaskNames.length > 0 ? (
              <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
                <div className="text-[10px] font-bold uppercase mb-2">
                  {t('syncTasks.validationModal.affectedTasks', {
                    defaultValue: 'Affected Tasks',
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {affectedTaskNames.map((taskName) => (
                    <span
                      key={taskName}
                      className="px-2 py-1 text-xs border-2 border-[var(--border-main)] bg-[var(--bg-primary)] font-mono"
                    >
                      {taskName}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {issue.source ? (
              <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
                <div className="text-[10px] font-bold uppercase mb-1">
                  {t('syncTasks.validationModal.source', {
                    defaultValue: 'Source',
                  })}
                </div>
                <div className="font-mono text-xs break-all">{issue.source}</div>
              </div>
            ) : null}

            {issue.target ? (
              <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
                <div className="text-[10px] font-bold uppercase mb-1">
                  {t('syncTasks.validationModal.target', {
                    defaultValue: 'Target',
                  })}
                </div>
                <div className="font-mono text-xs break-all">{issue.target}</div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 font-bold uppercase bg-[var(--text-primary)] text-[var(--bg-primary)] border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] transition-all"
            >
              {t('syncTasks.validationModal.close', {
                defaultValue: 'Close',
              })}
            </button>
          </div>
        </div>
      </CardAnimation>
    </div>
  );
}
