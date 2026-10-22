import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { appStoreListingUrl } from '../../config/appLinks';
import { useDistribution } from '../../hooks/useDistribution';
import { useSettings, type UpdateChannel } from '../../hooks/useSettings';
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

/**
 * `check_for_app_update` 명령이 돌려주는 메타데이터. updater 플러그인의 `Update` 생성자가
 * 받는 형태와 같으므로 `new Update(metadata)`로 다운로드·설치 흐름을 그대로 재사용한다.
 */
interface AppUpdateMetadata {
    rid: number;
    currentVersion: string;
    version: string;
    date?: string | null;
    body?: string | null;
    rawJson: Record<string, unknown>;
    channel: UpdateChannel;
    endpoint: string;
}

interface UpdateCheckerProps {
    autoCheckEnabled: boolean;
    manualCheckRequestNonce: number;
}

export function isPrereleaseVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+-/.test(version.trim().replace(/^v/, ''));
}

export interface SelfUpdateCheckResult {
    update: Update;
    /** 백엔드가 실제로 조회한 채널. 베타 해석 실패 시 `stable`로 대체될 수 있다. */
    channel: UpdateChannel;
}

export async function checkForSelfUpdate(channel: UpdateChannel): Promise<SelfUpdateCheckResult | null> {
    const metadata = await invoke<AppUpdateMetadata | null>('check_for_app_update', { channel });
    if (!metadata) {
        return null;
    }
    return {
        update: new Update({
            rid: metadata.rid,
            currentVersion: metadata.currentVersion,
            version: metadata.version,
            date: metadata.date ?? undefined,
            body: metadata.body ?? undefined,
            rawJson: metadata.rawJson,
        }),
        channel: metadata.channel === 'beta' ? 'beta' : 'stable',
    };
}

function releaseUpdateResource(update: Update | null) {
    if (!update) {
        return;
    }
    void update.close().catch((err) => {
        console.warn('[UpdateChecker] Failed to release update resource', err);
    });
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
    const { settings } = useSettings();
    const updateChannel = settings.updateChannel;
    const [state, setState] = useState<UpdateState>('idle');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [progress, setProgress] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const updateRef = useRef<Update | null>(null);
    /** 렌더마다 갱신되는 현재 채널. 진행 중인 확인이 끝났을 때 채널이 바뀌었는지 비교한다. */
    const latestChannelRef = useRef<UpdateChannel>(updateChannel);
    latestChannelRef.current = updateChannel;
    /** `updateRef`를 조회할 때 설정돼 있던 채널. 채널이 바뀌면 캐시를 버리고 다시 조회한다. */
    const cachedRequestedChannelRef = useRef<UpdateChannel | null>(null);
    /** 백엔드가 실제로 조회한 채널. 베타 요청이 안정으로 대체됐다면 수동 확인 때 다시 시도한다. */
    const cachedEffectiveChannelRef = useRef<UpdateChannel | null>(null);
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

        if (
            mode === 'manual'
            && updateRef.current
            && state === 'available'
            && cachedRequestedChannelRef.current === updateChannel
            && cachedEffectiveChannelRef.current === updateChannel
        ) {
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

            // 확인이 진행되는 동안 사용자가 채널을 바꿀 수 있다(예: 시작 자동 확인 중 설정 변경).
            // 요청 시점 채널과 현재 채널이 다르면 돌아온 Update를 닫고 새 채널로 다시 조회한다.
            let requestedChannel = latestChannelRef.current;
            let result = await checkForSelfUpdate(requestedChannel);
            while (latestChannelRef.current !== requestedChannel) {
                releaseUpdateResource(result?.update ?? null);
                requestedChannel = latestChannelRef.current;
                result = await checkForSelfUpdate(requestedChannel);
            }

            if (result) {
                const { update } = result;
                if (updateRef.current !== update) {
                    releaseUpdateResource(updateRef.current);
                }
                updateRef.current = update;
                cachedRequestedChannelRef.current = requestedChannel;
                cachedEffectiveChannelRef.current = result.channel;
                setUpdateInfo({
                    version: update.version,
                    body: update.body ?? null,
                    date: update.date ?? null,
                    storeUrl: null,
                });
                setDismissed(false);
                setState('available');
            } else {
                releaseUpdateResource(updateRef.current);
                updateRef.current = null;
                cachedRequestedChannelRef.current = null;
                cachedEffectiveChannelRef.current = null;
                setUpdateInfo(null);
                setState('idle');
                if (mode === 'manual') {
                    showToast(t('update.noneAvailable'), 'success');
                }
            }
        } catch (err) {
            console.error('[UpdateChecker] Failed to check for updates:', err);
            releaseUpdateResource(updateRef.current);
            updateRef.current = null;
            cachedRequestedChannelRef.current = null;
            cachedEffectiveChannelRef.current = null;
            setUpdateInfo(null);
            setState('idle');
            if (mode === 'manual') {
                showToast(t('update.checkFailed'), 'error');
            }
        }
    }, [distribution, distributionLoaded, resolveDistribution, showToast, state, t, updateChannel]);

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

    // 채널이 바뀌면 이전 채널에서 찾은 Update는 더 이상 유효한 후보가 아니다.
    // 다운로드·설치 중이 아닐 때만 캐시를 닫고 모달을 접어, 다음 확인이 새 채널을 조회하게 한다.
    useEffect(() => {
        const cached = updateRef.current;
        if (!cached || cachedRequestedChannelRef.current === updateChannel) {
            return;
        }
        if (state === 'downloading' || state === 'installing') {
            return;
        }

        updateRef.current = null;
        cachedRequestedChannelRef.current = null;
        cachedEffectiveChannelRef.current = null;
        releaseUpdateResource(cached);
        setUpdateInfo(null);
        setErrorMessage('');
        setProgress(0);
        // 'available'뿐 아니라 설치 실패('error')도 이전 채널의 Update에 묶인 상태이므로 함께 접는다.
        setState('idle');
        setDismissed(false);
    }, [state, updateChannel]);

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
                            ) : (
                                <>
                                    {isPrereleaseVersion(updateInfo.version) && (
                                        <p className="text-xs font-bold text-[var(--accent-warning)]">
                                            {t('update.prereleaseNotice')}
                                        </p>
                                    )}
                                    {updateInfo.body && (
                                        <div className="max-h-32 overflow-y-auto border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-3">
                                            <p className="whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]">
                                                {updateInfo.body}
                                            </p>
                                        </div>
                                    )}
                                </>
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
