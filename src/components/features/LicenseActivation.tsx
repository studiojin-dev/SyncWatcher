import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from '../../hooks/useSettings';
import { useDistribution } from '../../hooks/useDistribution';
import {
    assertSupporterProviderMatchesPolicy,
    getDistributionPolicy,
    type SupporterProvider,
} from '../../utils/distributionPolicy';

type ActivationState =
    | 'idle'
    | 'loading'
    | 'activating'
    | 'deactivating'
    | 'restoring'
    | 'success'
    | 'error';

interface LicenseStatus {
    isRegistered: boolean;
    licenseKey: string | null;
    provider: SupporterProvider;
}

interface SupporterStatus {
    isRegistered: boolean;
    provider: SupporterProvider;
}

interface SupporterPurchaseResponse {
    success: boolean;
    isRegistered: boolean;
    cancelled: boolean;
    pending: boolean;
    error?: string | null;
}

function LicenseActivation({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const {
        info: distribution,
        loaded: distributionLoaded,
        resolve: resolveDistribution,
    } = useDistribution();
    const { updateSettings } = useSettings();
    const [licenseKey, setLicenseKey] = useState('');
    const [state, setState] = useState<ActivationState>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [status, setStatus] = useState<LicenseStatus | null>(null);
    const [lastAction, setLastAction] = useState<'activate' | 'deactivate' | 'purchase' | 'restore' | null>(null);

    const resolvePolicy = useCallback(async () => {
        const resolvedDistribution = distributionLoaded
            ? distribution
            : await resolveDistribution();
        return getDistributionPolicy(resolvedDistribution);
    }, [distribution, distributionLoaded, resolveDistribution]);

    const loadStatus = useCallback(async (options?: { silent?: boolean }) => {
        if (!options?.silent) {
            setState('loading');
            setErrorMessage('');
        }

        try {
            const policy = await resolvePolicy();
            const supporterStatus = await invoke<SupporterStatus>('get_supporter_status');
            assertSupporterProviderMatchesPolicy(policy, supporterStatus.provider);

            let licenseKey: string | null = null;
            if (policy.supportsLicenseKeys) {
                const licenseStatus = await invoke<Omit<LicenseStatus, 'provider'>>('get_license_status');
                licenseKey = licenseStatus.licenseKey;
            }

            const nextStatus = {
                isRegistered: supporterStatus.isRegistered,
                licenseKey,
                provider: supporterStatus.provider,
            };
            setStatus(nextStatus);
            updateSettings({ isRegistered: supporterStatus.isRegistered });

            if (!options?.silent) {
                setState('idle');
            }
        } catch (err) {
            console.error('[LicenseActivation] Failed to load status:', err);
            setStatus({ isRegistered: false, licenseKey: null, provider: distribution.purchaseProvider });
            updateSettings({ isRegistered: false });
            setState('error');
            setErrorMessage(String(err));
        }
    }, [distribution.purchaseProvider, resolvePolicy, updateSettings]);

    useEffect(() => {
        if (!open) {
            return;
        }

        void loadStatus();
    }, [loadStatus, open]);

    const handleActivate = useCallback(async () => {
        if (!licenseKey.trim()) return;

        try {
            const policy = await resolvePolicy();
            if (!policy.supportsLicenseKeys) {
                setState('error');
                setErrorMessage('License keys are not available on this build.');
                return;
            }
            setState('activating');
            setErrorMessage('');
            setLastAction(null);

            const result = await invoke<{ valid: boolean; error: string | null }>('activate_license_key', {
                licenseKey: licenseKey.trim(),
            });

            if (result.valid) {
                await loadStatus({ silent: true });
                setState('success');
                setLastAction('activate');
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
    }, [licenseKey, loadStatus, resolvePolicy, t, updateSettings]);

    const handleDeactivate = useCallback(async () => {
        try {
            const policy = await resolvePolicy();
            if (!policy.supportsLicenseKeys) {
                setState('error');
                setErrorMessage('License keys are not available on this build.');
                return;
            }
            setState('deactivating');
            setErrorMessage('');
            setLastAction(null);

            const result = await invoke<{ success: boolean; error: string | null }>('deactivate_license_key');

            if (result.success) {
                setState('success');
                setLastAction('deactivate');
                setStatus({ isRegistered: false, licenseKey: null, provider: policy.purchaseProvider });
                updateSettings({ isRegistered: false });
            } else {
                setState('error');
                setErrorMessage(result.error ?? t('license.removeFailed'));
            }
        } catch (err) {
            console.error('[LicenseActivation] Deactivation failed:', err);
            setState('error');
            setErrorMessage(String(err));
        }
    }, [resolvePolicy, t, updateSettings]);

    const handlePurchase = useCallback(async () => {
        try {
            const policy = await resolvePolicy();
            if (!policy.supportsStoreKitPurchase) {
                setState('error');
                setErrorMessage('In-app purchase is not available on this build.');
                return;
            }
            setState('activating');
            setErrorMessage('');
            setLastAction(null);

            const result = await invoke<SupporterPurchaseResponse>('purchase_lifetime_supporter');
            if (result.success && result.isRegistered) {
                await loadStatus({ silent: true });
                setState('success');
                setLastAction('purchase');
                updateSettings({ isRegistered: true });
                return;
            }

            if (result.cancelled) {
                setState('idle');
                return;
            }

            if (result.pending) {
                setState('error');
                setErrorMessage(t('license.appStorePending'));
                return;
            }

            setState('error');
            setErrorMessage(result.error ?? t('license.appStorePurchaseFailed'));
        } catch (err) {
            console.error('[LicenseActivation] Purchase failed:', err);
            setState('error');
            setErrorMessage(String(err));
        }
    }, [loadStatus, resolvePolicy, t, updateSettings]);

    const handleRestore = useCallback(async () => {
        try {
            const policy = await resolvePolicy();
            if (!policy.supportsStoreKitRestore) {
                setState('error');
                setErrorMessage('Restore is not available on this build.');
                return;
            }
            setState('restoring');
            setErrorMessage('');
            setLastAction(null);

            const result = await invoke<SupporterPurchaseResponse>('restore_lifetime_supporter');
            if (result.success && result.isRegistered) {
                await loadStatus({ silent: true });
                setState('success');
                setLastAction('restore');
                updateSettings({ isRegistered: true });
                return;
            }

            setState('error');
            setErrorMessage(result.error ?? t('license.appStoreRestoreFailed'));
        } catch (err) {
            console.error('[LicenseActivation] Restore failed:', err);
            setState('error');
            setErrorMessage(String(err));
        }
    }, [loadStatus, resolvePolicy, t, updateSettings]);

    const handleClose = useCallback(() => {
        setState('idle');
        setLicenseKey('');
        setErrorMessage('');
        setStatus(null);
        setLastAction(null);
        onClose();
    }, [onClose]);

    if (!open) return null;

    const policy = getDistributionPolicy(distribution);
    const isAppStoreBuild = distributionLoaded && policy.supportsStoreKitPurchase;
    const isBusy = state === 'activating' || state === 'deactivating' || state === 'loading' || state === 'restoring';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-[440px] border-4 border-[var(--border-main)] bg-[var(--bg-primary)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                <div className="flex items-center justify-between border-b-4 border-[var(--border-main)] bg-[var(--accent-warning)] px-5 py-3">
                    <h2 className="text-sm font-black uppercase tracking-wider text-black">
                        {isAppStoreBuild ? t('license.appStoreTitle') : t('license.title')}
                    </h2>
                    <button
                        onClick={handleClose}
                        className="text-black font-black text-lg hover:opacity-70 transition-opacity"
                    >
                        ✕
                    </button>
                </div>

                <div className="space-y-4 p-5">
                    {state === 'loading' || !distributionLoaded ? (
                        <p className="text-sm font-bold text-[var(--text-primary)]">
                            {t('common.loading')}
                        </p>
                    ) : state === 'success' ? (
                        <div className="flex flex-col items-center gap-3 py-4">
                            <div className="text-4xl">✨</div>
                            <p className="text-sm font-bold text-[var(--accent-success)]">
                                {lastAction === 'deactivate'
                                    ? t('license.removed')
                                    : lastAction === 'restore'
                                        ? t('license.appStoreRestored')
                                        : lastAction === 'purchase'
                                            ? t('license.appStorePurchased')
                                            : t('license.activated')}
                            </p>
                        </div>
                    ) : isAppStoreBuild ? (
                        <>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('license.appStoreDescription')}
                            </p>
                            <div className="border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] px-4 py-3">
                                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">
                                    {t('license.appStoreSupportStatus')}
                                </div>
                                <div className="mt-2 text-sm font-bold text-[var(--text-primary)]">
                                    {status?.isRegistered ? t('about.registered') : t('about.unregistered')}
                                </div>
                            </div>
                            {state === 'error' && errorMessage && (
                                <div className="border-2 border-[var(--accent-error)] bg-[var(--accent-error)]/10 p-3">
                                    <p className="text-xs font-bold text-[var(--accent-error)]">
                                        {errorMessage}
                                    </p>
                                </div>
                            )}
                        </>
                    ) : status?.isRegistered ? (
                        <>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('license.manageDescription')}
                            </p>
                            <div className="border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] px-4 py-3">
                                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">
                                    {t('license.currentKey')}
                                </div>
                                <div className="mt-2 font-mono text-sm font-bold text-[var(--text-primary)]">
                                    {status.licenseKey ?? '****'}
                                </div>
                            </div>
                            {state === 'error' && errorMessage && (
                                <div className="border-2 border-[var(--accent-error)] bg-[var(--accent-error)]/10 p-3">
                                    <p className="text-xs font-bold text-[var(--accent-error)]">
                                        {errorMessage}
                                    </p>
                                </div>
                            )}
                        </>
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

                <div className="flex justify-end gap-3 border-t-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-5 py-3">
                    {state === 'success' ? (
                        <button
                            onClick={handleClose}
                            className="border-2 border-[var(--border-main)] bg-[var(--accent-success)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all"
                        >
                            {t('common.ok')}
                        </button>
                    ) : isAppStoreBuild ? (
                        <>
                            <button
                                onClick={handleClose}
                                disabled={isBusy}
                                className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                            >
                                {t('common.cancel')}
                            </button>
                            {!status?.isRegistered ? (
                                <button
                                    onClick={() => void handleRestore()}
                                    disabled={isBusy}
                                    className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                                >
                                    {state === 'restoring' ? t('license.appStoreRestoring') : t('license.restore')}
                                </button>
                            ) : null}
                            {!status?.isRegistered ? (
                                <button
                                    onClick={() => void handlePurchase()}
                                    disabled={isBusy}
                                    className="border-2 border-[var(--border-main)] bg-black px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--accent-warning)] shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all disabled:opacity-50"
                                >
                                    {state === 'activating' ? t('license.appStorePurchasing') : t('license.appStorePurchase')}
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <button
                                onClick={handleClose}
                                disabled={isBusy}
                                className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                            >
                                {t('common.cancel')}
                            </button>
                            {status?.isRegistered ? (
                                <button
                                    onClick={() => void handleDeactivate()}
                                    disabled={state === 'deactivating' || state === 'loading'}
                                    className="border-2 border-[var(--border-main)] bg-[var(--accent-error)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all disabled:opacity-50"
                                >
                                    {state === 'deactivating' ? t('license.removing') : t('license.remove')}
                                </button>
                            ) : (
                                <button
                                    onClick={() => void handleActivate()}
                                    disabled={state === 'activating' || state === 'loading' || !licenseKey.trim()}
                                    className="border-2 border-[var(--border-main)] bg-black px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--accent-warning)] shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all disabled:opacity-50"
                                >
                                    {state === 'activating' ? t('license.activating') : t('license.activate')}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default LicenseActivation;
