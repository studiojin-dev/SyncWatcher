import { invoke } from '@tauri-apps/api/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface DistributionInfo {
    channel: 'github' | 'app_store';
    purchaseProvider: 'lemon_squeezy' | 'app_store';
    canSelfUpdate: boolean;
    appStoreAppId?: string | null;
    appStoreCountry: string;
    appStoreUrl?: string | null;
    legacyImportAvailable: boolean;
}

export const DEFAULT_DISTRIBUTION_INFO: DistributionInfo = {
    channel: 'github',
    purchaseProvider: 'lemon_squeezy',
    canSelfUpdate: true,
    appStoreAppId: null,
    appStoreCountry: 'us',
    appStoreUrl: null,
    legacyImportAvailable: false,
};

export function normalizeDistributionInfo(
    info: Partial<DistributionInfo>,
): DistributionInfo {
    return {
        ...DEFAULT_DISTRIBUTION_INFO,
        ...info,
    };
}

export async function fetchDistributionInfo(): Promise<DistributionInfo> {
    const result = await invoke<DistributionInfo>('get_distribution_info');
    return normalizeDistributionInfo(result);
}

interface DistributionContextValue {
    info: DistributionInfo;
    loaded: boolean;
    reload: () => Promise<DistributionInfo>;
    resolve: () => Promise<DistributionInfo>;
}

const DistributionContext = createContext<DistributionContextValue | null>(null);

export function DistributionProvider({ children }: { children: ReactNode }) {
    const [info, setInfo] = useState<DistributionInfo>(DEFAULT_DISTRIBUTION_INFO);
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        let nextInfo = DEFAULT_DISTRIBUTION_INFO;
        try {
            nextInfo = await fetchDistributionInfo();
            setInfo(nextInfo);
        } catch (error) {
            console.error('Failed to load distribution info:', error);
            setInfo(DEFAULT_DISTRIBUTION_INFO);
        } finally {
            setLoaded(true);
        }
        return nextInfo;
    }, []);

    const resolve = useCallback(async () => {
        if (loaded) {
            return info;
        }
        return load();
    }, [info, loaded, load]);

    useEffect(() => {
        void load();
    }, [load]);

    const value = useMemo(() => ({
        info,
        loaded,
        reload: load,
        resolve,
    }), [info, loaded, load, resolve]);

    return (
        <DistributionContext.Provider value={value}>
            {children}
        </DistributionContext.Provider>
    );
}

export function useDistribution() {
    const context = useContext(DistributionContext);
    if (!context) {
        throw new Error('useDistribution must be used within a DistributionProvider');
    }
    return context;
}
