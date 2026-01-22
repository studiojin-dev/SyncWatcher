import { useTranslation } from 'react-i18next';
import { IconDeviceDesktop, IconUsb } from '@tabler/icons-react';

interface VolumeInfo {
    name: string;
    mount_point: string;
    total_bytes: number;
    available_bytes: number;
    is_removable: boolean;
}

interface VolumeCardProps {
    volume: VolumeInfo;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Volume Card component - Ghost glass aesthetic
 * Shows volume name, mount point, free/total space
 */
function VolumeCard({ volume }: VolumeCardProps) {
    const { t } = useTranslation();
    const usedBytes = volume.total_bytes - volume.available_bytes;
    const usagePercent = volume.total_bytes > 0
        ? Math.round((usedBytes / volume.total_bytes) * 100)
        : 0;

    return (
        <div className="card hover-lift">
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-4)'
            }}>
                {volume.is_removable ? (
                    <IconUsb size={20} stroke={1.5} className="text-secondary" />
                ) : (
                    <IconDeviceDesktop size={20} stroke={1.5} className="text-secondary" />
                )}
                <div>
                    <h3 style={{
                        fontSize: 'var(--text-base)',
                        fontWeight: 'var(--weight-normal)',
                        margin: 0
                    }}>
                        {volume.name || 'Unknown'}
                    </h3>
                    <p className="text-tertiary text-xs font-mono" style={{ margin: 0 }}>
                        {volume.mount_point}
                    </p>
                </div>
            </div>

            {/* Progress Bar */}
            <div className="progress-bar" style={{ marginBottom: 'var(--space-3)' }}>
                <div
                    className="progress-fill"
                    style={{ width: `${usagePercent}%` }}
                />
            </div>

            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <span className="text-tertiary text-xs">
                    {formatBytes(volume.available_bytes)} {t('dashboard.freeSpace')}
                </span>
                <span className="text-tertiary text-xs">
                    {formatBytes(volume.total_bytes)}
                </span>
            </div>
        </div>
    );
}

export default VolumeCard;
