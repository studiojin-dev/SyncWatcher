import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from '../../hooks/useSettings';

/**
 * 라이선스 활성화 상태
 */
type ActivationState = 'idle' | 'activating' | 'success' | 'error';

/**
 * LicenseActivation — 라이선스 키 입력 및 활성화 모달 컴포넌트.
 * Lemon Squeezy API를 통해 라이선스 키를 활성화합니다.
 *
 * @param props.open - 모달 표시 여부
 * @param props.onClose - 모달 닫기 콜백
 * @returns JSX
 */
function LicenseActivation({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { updateSettings } = useSettings();
    const [licenseKey, setLicenseKey] = useState('');
    const [state, setState] = useState<ActivationState>('idle');
    const [errorMessage, setErrorMessage] = useState('');

    const handleActivate = useCallback(async () => {
        if (!licenseKey.trim()) return;

        try {
            setState('activating');
            setErrorMessage('');

            const result = await invoke<{ valid: boolean; error: string | null }>('activate_license_key', {
                licenseKey: licenseKey.trim(),
            });

            if (result.valid) {
                setState('success');
                updateSettings({ isRegistered: true });
            } else {
                setState('error');
                setErrorMessage(result.error ?? t('license.invalid'));
            }
        } catch (err) {
            console.error('[LicenseActivation] Activation failed:', err);
            setState('error');
            setErrorMessage(String(err));
        }
    }, [licenseKey, t, updateSettings]);

    const handleClose = useCallback(() => {
        setState('idle');
        setLicenseKey('');
        setErrorMessage('');
        onClose();
    }, [onClose]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-[440px] border-4 border-[var(--border-main)] bg-[var(--bg-primary)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                {/* Header */}
                <div className="flex items-center justify-between border-b-4 border-[var(--border-main)] bg-[var(--accent-warning)] px-5 py-3">
                    <h2 className="text-sm font-black uppercase tracking-wider text-black">
                        {t('license.title')}
                    </h2>
                    <button
                        onClick={handleClose}
                        className="text-black font-black text-lg hover:opacity-70 transition-opacity"
                    >
                        ✕
                    </button>
                </div>

                {/* Body */}
                <div className="space-y-4 p-5">
                    {state === 'success' ? (
                        <div className="flex flex-col items-center gap-3 py-4">
                            <div className="text-4xl">✨</div>
                            <p className="text-sm font-bold text-[var(--accent-success)]">
                                {t('license.activated')}
                            </p>
                        </div>
                    ) : (
                        <>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('license.enterKeyDescription')}
                            </p>
                            <input
                                type="text"
                                value={licenseKey}
                                onChange={(e) => setLicenseKey(e.target.value)}
                                placeholder={t('license.keyPlaceholder')}
                                disabled={state === 'activating'}
                                className="w-full border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] px-4 py-3 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:shadow-[4px_4px_0_0_var(--shadow-color)] transition-shadow disabled:opacity-50"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void handleActivate();
                                }}
                            />
                            {state === 'error' && errorMessage && (
                                <div className="border-2 border-[var(--accent-error)] bg-[var(--accent-error)]/10 p-3">
                                    <p className="text-xs font-bold text-[var(--accent-error)]">
                                        {errorMessage}
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 border-t-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-5 py-3">
                    {state === 'success' ? (
                        <button
                            onClick={handleClose}
                            className="border-2 border-[var(--border-main)] bg-[var(--accent-success)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all"
                        >
                            {t('common.ok')}
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={handleClose}
                                disabled={state === 'activating'}
                                className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                            >
                                {t('common.cancel')}
                            </button>
                            <button
                                onClick={() => void handleActivate()}
                                disabled={state === 'activating' || !licenseKey.trim()}
                                className="border-2 border-[var(--border-main)] bg-black px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--accent-warning)] shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all disabled:opacity-50"
                            >
                                {state === 'activating' ? t('license.activating') : t('license.activate')}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default LicenseActivation;
