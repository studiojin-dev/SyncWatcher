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
    useTranslation();
    const usedBytes = volume.total_bytes - volume.available_bytes;
    const usagePercent = volume.total_bytes > 0
        ? Math.round((usedBytes / volume.total_bytes) * 100)
        : 0;

    return (
        <div className="neo-box p-5 hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[6px_6px_0_0_var(--shadow-color)] transition-all">
            <div className="flex items-center gap-4 mb-4 pb-4 border-b-2 border-dashed border-[var(--border-main)]">
                {volume.is_removable ? (
                    <div className="p-2 bg-[var(--color-bg-tertiary)] border-2 border-[var(--border-main)]">
                        <IconUsb size={24} stroke={2} className="text-[var(--text-primary)]" />
                    </div>
                ) : (
                    <div className="p-2 bg-[var(--bg-secondary)] border-2 border-[var(--border-main)]">
                        <IconDeviceDesktop size={24} stroke={2} className="text-[var(--text-primary)]" />
                    </div>
                )}
                <div>
                    <h3 className="text-lg font-bold font-heading uppercase tracking-tight">
                        {volume.name || 'Unknown'}
                    </h3>
                    <p className="text-[var(--text-secondary)] text-xs font-mono">
                        {volume.mount_point}
                    </p>
                </div>
            </div>

            {/* Progress Bar (Neo) */}
            <div className="relative h-6 w-full bg-[var(--bg-secondary)] border-2 border-[var(--border-main)] mb-3">
                <div
                    className="h-full bg-[var(--accent-main)] border-r-2 border-[var(--border-main)] relative overflow-hidden"
                    style={{ width: `${usagePercent}%` }}
                >
                    {/* Striped pattern overlay */}
                    <div className="absolute inset-0 opacity-20 bg-[linear-gradient(45deg,#000_25%,transparent_25%,transparent_50%,#000_50%,#000_75%,transparent_75%,transparent)] bg-[length:10px_10px]" />
                </div>
            </div>

            <div className="flex justify-between items-center font-mono text-xs font-bold">
                <span className="bg-[var(--accent-success)] text-black px-2 py-1 border-2 border-[var(--border-main)] shadow-[2px_2px_0_0_#000]">
                    {formatBytes(volume.available_bytes)} FREE
                </span>
                <span className="text-[var(--text-secondary)]">
                    / {formatBytes(volume.total_bytes)}
                </span>
            </div>
        </div>
    );
}

export default VolumeCard;
