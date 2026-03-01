import { useTranslation } from 'react-i18next';
import { useSettings } from '../../hooks/useSettings';
import { formatBytes } from '../../utils/formatBytes';
import { CardAnimation } from './Animations';

interface AutoUnmountConfirmModalProps {
  opened: boolean;
  taskName: string;
  source: string;
  filesCopied: number;
  bytesCopied: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function AutoUnmountConfirmModal({
  opened,
  taskName,
  source,
  filesCopied,
  bytesCopied,
  onConfirm,
  onCancel,
}: AutoUnmountConfirmModalProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();

  if (!opened) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <CardAnimation>
        <div className="neo-box p-6 w-full max-w-lg bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
          <h3 className="text-xl font-heading font-bold mb-3 uppercase text-[var(--color-accent-warning)]">
            {t('syncTasks.autoUnmountConfirmTitle', { defaultValue: '자동 Unmount 확인' })}
          </h3>
          <p className="mb-3 text-[var(--text-primary)] font-mono text-sm whitespace-pre-wrap break-all">
            {t('syncTasks.autoUnmountConfirmMessage', {
              defaultValue:
                "Watch Mode 동기화에서 이번에는 복사된 파일이 없습니다.\n이 디스크를 지금 자동으로 제거할까요?",
              taskName,
            })}
          </p>
          <div className="mb-5 text-xs font-mono text-[var(--text-secondary)] space-y-1">
            <p>{`TASK: ${taskName}`}</p>
            <p>{`SRC: ${source}`}</p>
            <p>
              {t('syncTasks.autoUnmountConfirmDetail', {
                defaultValue: '복사됨: {{files}}개 / {{bytes}}',
                files: filesCopied,
                bytes: formatBytes(bytesCopied, settings.dataUnitSystem),
              })}
            </p>
          </div>
          <div className="flex gap-3 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              {t('syncTasks.autoUnmountConfirmKeepMounted', { defaultValue: '유지(취소)' })}
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 font-bold uppercase bg-[var(--accent-main)] text-white border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none transition-all"
            >
              {t('syncTasks.autoUnmountConfirmUnmount', { defaultValue: '지금 unmount' })}
            </button>
          </div>
        </div>
      </CardAnimation>
    </div>
  );
}
