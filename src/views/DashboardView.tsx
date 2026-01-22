import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import VolumeCard from '../components/VolumeCard';

interface VolumeInfo {
    name: string;
    mount_point: string;
    total_bytes: number;
    available_bytes: number;
    is_removable: boolean;
}

/**
 * Dashboard View - Main view showing connected volumes
 * Bento Grid layout for volume cards
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
        <div className="fade-in">
            <header style={{ marginBottom: 'var(--space-8)' }}>
                <h1 className="text-xl" style={{ fontWeight: 'var(--weight-normal)', marginBottom: 'var(--space-2)' }}>
                    {t('dashboard.title')}
                </h1>
                <p className="text-secondary text-sm">
                    {volumes.length > 0
                        ? `${volumes.length} ${t('dashboard.connected')}`
                        : t('dashboard.noDevices')
                    }
                </p>
            </header>

            {error && (
                <div className="card status-error" style={{ marginBottom: 'var(--space-6)' }}>
                    <p>{error}</p>
                    <button className="btn-ghost" onClick={loadVolumes} style={{ marginTop: 'var(--space-3)' }}>
                        {t('common.ok')}
                    </button>
                </div>
            )}

            {loading ? (
                <div className="text-secondary" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
                    {t('common.loading')}
                </div>
            ) : (
                <div className="bento-grid">
                    {volumes.map((volume) => (
                        <VolumeCard key={volume.mount_point} volume={volume} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default DashboardView;
