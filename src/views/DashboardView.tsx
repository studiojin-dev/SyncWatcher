import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { IconRefresh } from '@tabler/icons-react';
import VolumeCard from '../components/VolumeCard';
import { CardAnimation, FadeIn } from '../components/ui/Animations';

interface VolumeInfo {
    name: string;
    mount_point: string;
    total_bytes: number;
    available_bytes: number;
    is_removable: boolean;
    /** 파일시스템 UUID (포맷 시 변경될 수 있음) */
    volume_uuid?: string;
    /** 파티션 UUID (포맷 후에도 유지됨, SD 카드 식별에 권장) */
    disk_uuid?: string;
}

const CACHE_KEY = 'syncwatcher:volumes';
/** 폴링 간격: 1분 (60,000ms) */
const POLL_INTERVAL_MS = 60 * 1000;

/**
 * LocalStorage에서 캐시된 볼륨 데이터를 로드합니다.
 * 캐시는 만료되지 않습니다 (이벤트 또는 폴링으로 업데이트).
 */
function loadCachedVolumes(): VolumeInfo[] {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed)) {
                console.debug('[DashboardView] Loaded cached volumes', { count: parsed.length });
                return parsed;
            }
        }
    } catch (err) {
        console.warn('[DashboardView] Failed to load cached volumes', err);
    }
    return [];
}

/**
 * 볼륨 데이터를 LocalStorage에 캐시합니다.
 */
function saveCachedVolumes(volumes: VolumeInfo[]): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(volumes));
        console.debug('[DashboardView] Saved volumes to cache', { count: volumes.length });
    } catch (err) {
        console.warn('[DashboardView] Failed to save volumes to cache', err);
    }
}

/**
 * Dashboard View - Main view showing connected volumes
 * 
 * - 캐시된 데이터를 즉시 표시
 * - 마운트 시 백그라운드에서 새로고침
 * - 1분마다 자동 업데이트 (폴링)
 * - 백엔드에서 volumes-changed 이벤트 수신 시 업데이트
 */
function DashboardView() {
    const { t } = useTranslation();
    const [volumes, setVolumes] = useState<VolumeInfo[]>(() => loadCachedVolumes());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 캐시가 없으면 "분석중" 표시
    const [isAnalyzing, setIsAnalyzing] = useState(() => volumes.length === 0);
    const isMounted = useRef(true);
    const requestSeq = useRef(0);
    const inFlightCount = useRef(0);

    const loadVolumes = useCallback(async () => {
        const startTime = performance.now();
        const requestId = ++requestSeq.current;
        try {
            inFlightCount.current += 1;
            setLoading(true);
            setError(null);

            console.debug('[DashboardView] loadVolumes started', { requestId, inFlight: inFlightCount.current });

            const result = await invoke<VolumeInfo[]>('list_volumes');

            if (isMounted.current && requestId === requestSeq.current) {
                setVolumes(result);
                setIsAnalyzing(false);
                saveCachedVolumes(result);
                console.debug('[DashboardView] loadVolumes completed', {
                    requestId,
                    volumeCount: result.length,
                    durationMs: Math.round(performance.now() - startTime)
                });
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[DashboardView] loadVolumes failed', { requestId, error: errorMessage });
            if (isMounted.current && requestId === requestSeq.current) {
                setError(errorMessage);
                setIsAnalyzing(false);
            }
        } finally {
            // [코드 리뷰 완료] 방어적 프로그래밍: 음수 방지.
            // 현재 로직에서 음수가 될 가능성은 없지만, 향후 코드 변경 시 실수 방지용.
            // 매 호출이 +1 → finally에서 -1을 정확히 한 번씩 수행함.
            inFlightCount.current = Math.max(0, inFlightCount.current - 1);
            if (isMounted.current) {
                setLoading(inFlightCount.current > 0);
            }
        }
    }, []);

    useEffect(() => {
        isMounted.current = true;

        // 1. 마운트 시 즉시 (50ms 딜레이) 볼륨 로드
        const timeoutId = setTimeout(() => {
            if (isMounted.current) {
                loadVolumes();
            }
        }, 50);

        // 2. 백엔드에서 volumes-changed 이벤트 수신
        const unlistenPromise = listen('volumes-changed', () => {
            console.debug('[DashboardView] Received volumes-changed event');
            if (isMounted.current) {
                loadVolumes();
            }
        });

        // 3. 1분마다 폴링 (폴백)
        const intervalId = setInterval(() => {
            if (isMounted.current) {
                console.debug('[DashboardView] Polling volumes');
                loadVolumes();
            }
        }, POLL_INTERVAL_MS);

        return () => {
            isMounted.current = false;
            clearTimeout(timeoutId);
            clearInterval(intervalId);
            unlistenPromise
                .then((unlisten) => unlisten())
                .catch((err) => {
                    console.warn('[DashboardView] Failed to unlisten volumes-changed', err);
                });
        };
    }, [loadVolumes]);

    return (
        <div className="space-y-8">
            <FadeIn>
                <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
                    <div className="flex items-center gap-3 mb-2">
                        <h1 className="text-3xl font-heading font-black uppercase">
                            {t('dashboard.title')}
                        </h1>
                        {(loading || isAnalyzing) && (
                            <div className="flex items-center gap-2">
                                <IconRefresh
                                    size={24}
                                    className="animate-spin text-[var(--accent-main)]"
                                    aria-label={t('common.loading')}
                                />
                                {isAnalyzing && (
                                    <span className="text-sm font-mono text-[var(--text-secondary)] uppercase">
                                        {t('dashboard.analyzing', '분석중...')}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <p className="text-[var(--text-secondary)] font-mono text-sm border-l-4 border-[var(--accent-main)] pl-3">
                        {volumes.length > 0
                            ? `// ${volumes.length} ${t('dashboard.connected')}`.toUpperCase()
                            : `// ${t('dashboard.noDevices')}`.toUpperCase()
                        }
                    </p>
                </header>
            </FadeIn>

            {error && (
                <div className="neo-box bg-[var(--color-accent-error)] text-black p-4 flex flex-col items-start gap-4">
                    <p className="font-bold">ERROR: {error}</p>
                    <button
                        className="bg-white border-2 border-black px-4 py-2 font-bold shadow-[2px_2px_0_0_#000] active:translate-y-1 active:shadow-none transition-all"
                        onClick={loadVolumes}
                    >
                        {t('common.retry')}
                    </button>
                </div>
            )}

            {/* 캐시도 없고 분석중일 때만 전체 화면 로딩 표시 */}
            {isAnalyzing && volumes.length === 0 ? (
                <div className="text-center py-12 font-mono animate-pulse">
                    ANALYZING_VOLUMES...
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-8">
                    {volumes.map((volume, index) => (
                        <CardAnimation key={volume.mount_point} index={index}>
                            <VolumeCard volume={volume} />
                        </CardAnimation>
                    ))}
                </div>
            )}
        </div>
    );
}

export default DashboardView;
