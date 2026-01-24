import { useTranslation } from 'react-i18next';
import { CardAnimation } from './Animations';

interface CancelConfirmModalProps {
    opened: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    message?: string;
    title?: string;
}

/**
 * 취소 확인 모달
 * 작업 취소 전 사용자 확인을 요청
 */
export default function CancelConfirmModal({
    opened,
    onConfirm,
    onCancel,
    message,
    title,
}: CancelConfirmModalProps) {
    const { t } = useTranslation();

    if (!opened) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <CardAnimation>
                <div className="neo-box p-6 w-full max-w-md bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                    <h3 className="text-xl font-heading font-bold mb-4 uppercase text-[var(--color-accent-warning)]">
                        ⚠️ {title || t('common.confirm', { defaultValue: '확인' })}
                    </h3>
                    <p className="mb-6 text-[var(--text-primary)] font-mono text-sm">
                        {message || t('syncTasks.cancelConfirm', { defaultValue: '정말로 작업을 취소하시겠습니까?' })}
                    </p>
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                        >
                            {t('common.no', { defaultValue: '아니오' })}
                        </button>
                        <button
                            onClick={onConfirm}
                            className="px-4 py-2 font-bold uppercase bg-[var(--color-accent-error)] text-white border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none transition-all"
                        >
                            {t('common.yes', { defaultValue: '예, 취소합니다' })}
                        </button>
                    </div>
                </div>
            </CardAnimation>
        </div>
    );
}
