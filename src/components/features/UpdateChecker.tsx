import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { appStoreListingUrl } from '../../config/appLinks';
import { useDistribution } from '../../hooks/useDistribution';
import { getDistributionPolicy } from '../../utils/distributionPolicy';
import { useToast } from '../ui/Toast';

/**
 * 업데이트 상태를 나타내는 타입
 */
type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error';

/**
 * 업데이트 정보 인터페이스
 */
interface UpdateInfo {
    version: string;
    body: string | null;
    date: string | null;
    storeUrl?: string | null;
    manualOnly?: boolean;
}

interface AppStoreUpdateCheckResult {
    available: boolean;
    currentVersion: string;
    latestVersion?: string | null;
    storeUrl?: string | null;
    manualOnly: boolean;
    error?: string | null;
}

interface UpdateCheckerProps {
    autoCheckEnabled: boolean;
    manualCheckRequestNonce: number;
}

/**
 * UpdateChecker — 앱 시작 후 자동으로 업데이트를 확인하고,
 * 업데이트 발견 시 사용자에게 알림 모달을 표시하는 컴포넌트.
 *
 * @returns JSX 또는 null (업데이트 없으면 숨김)
 */
function UpdateChecker({ autoCheckEnabled, manualCheckRequestNonce }: UpdateCheckerProps) {
    const { t } = useTranslation();
    const {
        info: distribution,
        loaded: distributionLoaded,
        resolve: resolveDistribution,
    } = useDistribution();
    const { showToast } = useToast();
    const [state, setState] = useState<UpdateState>('idle');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [progress, setProgress] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const updateRef = useRef<Awaited<ReturnType<typeof check>> | null>(null);
    const autoCheckStartedRef = useRef(false);
    const lastHandledManualCheckRef = useRef(0);
    const fallbackStoreUrl = (distribution.appStoreUrl ?? appStoreListingUrl) || null;

    const checkForUpdates = useCallback(async (mode: 'auto' | 'manual') => {
        if (state === 'checking' || state === 'downloading' || state === 'installing') {
            if (mode === 'manual') {
                showToast(t('update.checkingAlready'), 'info');
            }
            return;
        }

        if (mode === 'manual' && updateRef.current && state === 'available') {
            setDismissed(false);
            return;
        }

        try {
            setState('checking');
            setErrorMessage('');
            setProgress(0);

            const resolvedDistribution = distributionLoaded
                ? distribution
                : await resolveDistribution();
            const policy = getDistributionPolicy(resolvedDistribution);
            const resolvedFallbackStoreUrl =
                (resolvedDistribution.appStoreUrl ?? appStoreListingUrl) || null;

            if (!policy.supportsSelfUpdate) {
                const update = await invoke<AppStoreUpdateCheckResult>('check_app_store_update');
                if (update.available) {
                    updateRef.current = null;
                    setUpdateInfo({
                        version: update.latestVersion ?? update.currentVersion,
                        body: null,
                        date: null,
                        storeUrl: update.storeUrl ?? resolvedFallbackStoreUrl,
                        manualOnly: false,
                    });
                    setDismissed(false);
                    setState('available');
                } else if (update.manualOnly && (update.storeUrl ?? resolvedFallbackStoreUrl)) {
                    updateRef.current = null;
                    setUpdateInfo({
                        version: update.latestVersion ?? '',
                        body: null,
                        date: null,
                        storeUrl: update.storeUrl ?? resolvedFallbackStoreUrl,
                        manualOnly: true,
                    });
                    setErrorMessage(update.error ?? '');
                    setDismissed(false);
                    setState('available');
                } else {
                    updateRef.current = null;
                    setUpdateInfo(null);
                    setState('idle');
                    if (mode === 'manual') {
                        showToast(t('update.noneAvailable'), 'success');
                    }
                }
                return;
            }

            const update = await check();

            if (update) {
                updateRef.current = update;
                setUpdateInfo({
                    version: update.version,
                    body: update.body ?? null,
                    date: update.date ?? null,
                    storeUrl: null,
                });
                setDismissed(false);
                setState('available');
            } else {
                updateRef.current = null;
                setUpdateInfo(null);
                setState('idle');
                if (mode === 'manual') {
                    showToast(t('update.noneAvailable'), 'success');
                }
            }
        } catch (err) {
            console.error('[UpdateChecker] Failed to check for updates:', err);
            updateRef.current = null;
            setUpdateInfo(null);
            setState('idle');
            if (mode === 'manual') {
                showToast(t('update.checkFailed'), 'error');
            }
        }
    }, [distribution, distributionLoaded, resolveDistribution, showToast, state, t]);

    const handleUpdate = useCallback(async () => {
        const update = updateRef.current;
        if (!update) return;

        try {
            setState('downloading');
            let downloaded = 0;
            let contentLength = 0;

            await update.downloadAndInstall((event) => {
                switch (event.event) {
                    case 'Started':
                        contentLength = event.data.contentLength ?? 0;
                        break;
                    case 'Progress':
                        downloaded += event.data.chunkLength;
                        if (contentLength > 0) {
                            setProgress(Math.round((downloaded / contentLength) * 100));
                        }
                        break;
                    case 'Finished':
                        setState('installing');
                        break;
                }
            });

            await relaunch();
        } catch (err) {
            console.error('[UpdateChecker] Update failed:', err);
            setErrorMessage(String(err));
            setState('error');
        }
    }, []);

    useEffect(() => {
        if (!autoCheckEnabled || autoCheckStartedRef.current || !distributionLoaded) {
            return;
        }

        autoCheckStartedRef.current = true;
        void checkForUpdates('auto');
    }, [autoCheckEnabled, checkForUpdates, distributionLoaded]);

    useEffect(() => {
        if (manualCheckRequestNonce === 0 || lastHandledManualCheckRef.current === manualCheckRequestNonce) {
            return;
        }

        lastHandledManualCheckRef.current = manualCheckRequestNonce;
        void checkForUpdates('manual');
    }, [checkForUpdates, manualCheckRequestNonce]);

    if (dismissed || state === 'idle' || state === 'checking') {
        return null;
    }

    const policy = getDistributionPolicy(distribution);
    const showsAppStoreUpdate = distributionLoaded && !policy.supportsSelfUpdate;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-[420px] border-4 border-[var(--border-main)] bg-[var(--bg-primary)] shadow-[8px_8px_0_0_var(--shadow-color)]">
                {/* Header */}
                <div className="flex items-center justify-between border-b-4 border-[var(--border-main)] bg-[var(--accent-warning)] px-5 py-3">
                    <h2 className="text-sm font-black uppercase tracking-wider text-black">
                        {t('update.title')}
                    </h2>
                </div>

                {/* Body */}
                <div className="space-y-4 p-5">
                    {state === 'available' && updateInfo && (
                        <>
                            <p className="text-sm font-bold text-[var(--text-primary)]">
                                {showsAppStoreUpdate
                                    ? updateInfo.manualOnly
                                        ? (errorMessage || t('update.appStoreDescription'))
                                        : t('update.appStoreAvailable', { version: updateInfo.version })
                                    : t('update.available', { version: updateInfo.version })}
                            </p>
                            {showsAppStoreUpdate ? (
                                <p className="text-xs text-[var(--text-secondary)]">
                                    {t('update.appStoreDescription')}
                                </p>
                            ) : updateInfo.body && (
                                <div className="max-h-32 overflow-y-auto border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
                                    <p className="whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]">
                                        {updateInfo.body}
                                    </p>
                                </div>
                            )}
                        </>
                    )}

                    {state === 'downloading' && (
                        <div className="space-y-2">
                            <p className="text-sm font-bold text-[var(--text-primary)]">
                                {t('update.downloading')}
                            </p>
                            <div className="h-4 w-full border-2 border-[var(--border-main)] bg-[var(--bg-secondary)]">
                                <div
                                    className="h-full bg-[var(--accent-success)] transition-all duration-200"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="text-right font-mono text-xs text-[var(--text-secondary)]">
                                {progress}%
                            </p>
                        </div>
                    )}

                    {state === 'installing' && (
                        <p className="text-sm font-bold text-[var(--text-primary)]">
                            {t('update.installing')}
                        </p>
                    )}

                    {state === 'error' && (
                        <div className="space-y-2">
                            <p className="text-sm font-bold text-[var(--accent-error)]">
                                {t('update.error')}
                            </p>
                            <p className="font-mono text-xs text-[var(--text-secondary)]">
                                {errorMessage}
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 border-t-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-5 py-3">
                    {state === 'available' && (
                        <>
                            <button
                                onClick={() => setDismissed(true)}
                                className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors"
                            >
                                {t('update.later')}
                            </button>
                            {showsAppStoreUpdate ? (
                                <a
                                    href={updateInfo?.storeUrl ?? fallbackStoreUrl ?? '#'}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="border-2 border-[var(--border-main)] bg-[var(--accent-success)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white hover:opacity-90 shadow-[3px_3px_0_0_var(--shadow-color)] transition-all"
                                >
                                    {t('update.openAppStore')}
                                </a>
                            ) : (
                                <button
                                    onClick={() => void handleUpdate()}
                                    className="border-2 border-[var(--border-main)] bg-[var(--accent-success)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white hover:opacity-90 shadow-[3px_3px_0_0_var(--shadow-color)] transition-all"
                                >
                                    {t('update.updateNow')}
                                </button>
                            )}
                        </>
                    )}

                    {state === 'error' && (
                        <button
                            onClick={() => setDismissed(true)}
                            className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors"
                        >
                            {t('common.close')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export default UpdateChecker;
