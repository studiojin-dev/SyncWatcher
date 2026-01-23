import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface VolumeInfo {
    name: string;
    path: string;
    mount_point: string;
    total_bytes: number;
    available_bytes: number;
    is_removable: boolean;
}

/**
 * useRemovableVolumes - Custom hook for managing removable volumes
 * Fetches and caches removable volumes (USB, SD cards, external drives)
 * Filters out Time Machine and system volumes
 */
export function useRemovableVolumes() {
    const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadVolumes = async () => {
        try {
            setLoading(true);
            setError(null);
            const vols = await invoke<VolumeInfo[]>('get_removable_volumes');
            setVolumes(vols);
        } catch (err) {
            console.error('Failed to load removable volumes:', err);
            setError(String(err));
            setVolumes([]);
        } finally {
            setLoading(false);
        }
    };

    // Load volumes on mount
    useEffect(() => {
        loadVolumes();
    }, []);

    return {
        volumes,
        loading,
        error,
        reload: loadVolumes,
    };
}
