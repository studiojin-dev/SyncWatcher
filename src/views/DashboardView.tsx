import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
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

/**
 * Dashboard View - Main view showing connected volumes
 * Bento Grid layout for volume cards with staggered animation
 */
function DashboardView() {
    const { t } = useTranslation();
    const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadVolumes = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const result = await invoke<VolumeInfo[]>('list_volumes');
            setVolumes(result);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadVolumes();
    }, [loadVolumes]);

    return (
        <div className="space-y-8">
            <FadeIn>
                <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
                    <h1 className="text-3xl font-heading font-black mb-2 uppercase">
                        {t('dashboard.title')}
                    </h1>
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

            {loading ? (
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
