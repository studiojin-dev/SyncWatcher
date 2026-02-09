import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
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

/** 모듈 레벨 볼륨 캐시 - 탭 전환 시 즉시 표시용 */
let volumeCache: VolumeInfo[] | null = null;

/**
 * Dashboard View - Main view showing connected volumes
 * Bento Grid layout for volume cards with staggered animation
 * 
 * 캐시된 볼륨 데이터가 있으면 즉시 표시하고, 백그라운드에서 새로고침합니다.
 */
function DashboardView() {
    const { t } = useTranslation();
    // 캐시된 데이터로 초기화하여 즉시 표시
    const [volumes, setVolumes] = useState<VolumeInfo[]>(volumeCache ?? []);
    // 캐시가 있으면 로딩 상태 false로 시작
    const [loading, setLoading] = useState(volumeCache === null);
    const [error, setError] = useState<string | null>(null);
    const isMounted = useRef(true);

    const loadVolumes = useCallback(async (isBackground = false) => {
        const startTime = performance.now();
        try {
            // 백그라운드 로드가 아닐 때만 로딩 표시
            if (!isBackground) {
                setLoading(true);
            } else {
                // 백그라운드 로드일 때도 스피너 표시
                setLoading(true);
            }
            setError(null);

            console.debug('[DashboardView] loadVolumes started', { isBackground, hasCachedData: volumeCache !== null });

            const result = await invoke<VolumeInfo[]>('list_volumes');

            if (isMounted.current) {
                setVolumes(result);
                volumeCache = result; // 캐시 업데이트
                console.debug('[DashboardView] loadVolumes completed', {
                    volumeCount: result.length,
                    durationMs: Math.round(performance.now() - startTime)
                });
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[DashboardView] loadVolumes failed', { error: errorMessage });
            if (isMounted.current) {
                setError(errorMessage);
            }
        } finally {
            if (isMounted.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        isMounted.current = true;
        // 캐시가 있으면 백그라운드 로드, 없으면 일반 로드
        loadVolumes(volumeCache !== null);

        return () => {
            isMounted.current = false;
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
                        {loading && (
                            <IconRefresh
                                size={24}
                                className="animate-spin text-[var(--accent-main)]"
                                aria-label={t('common.loading')}
                            />
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
                        onClick={() => loadVolumes(false)}
                    >
                        {t('common.retry')}
                    </button>
                </div>
            )}

            {/* 캐시가 없고 로딩 중일 때만 전체 화면 로딩 표시 */}
            {loading && volumes.length === 0 ? (
                <div className="text-center py-12 font-mono animate-pulse">
                    LOADING_SYSTEM_MODULES...
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
