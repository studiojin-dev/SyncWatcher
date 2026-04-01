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

const DEFAULT_DISTRIBUTION_INFO: DistributionInfo = {
    channel: 'github',
    purchaseProvider: 'lemon_squeezy',
    canSelfUpdate: true,
    appStoreAppId: null,
    appStoreCountry: 'us',
    appStoreUrl: null,
    legacyImportAvailable: false,
};

interface DistributionContextValue {
    info: DistributionInfo;
    loaded: boolean;
    reload: () => Promise<void>;
}

const DistributionContext = createContext<DistributionContextValue | null>(null);

export function DistributionProvider({ children }: { children: ReactNode }) {
    const [info, setInfo] = useState<DistributionInfo>(DEFAULT_DISTRIBUTION_INFO);
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        try {
            const result = await invoke<DistributionInfo>('get_distribution_info');
            setInfo({
                ...DEFAULT_DISTRIBUTION_INFO,
                ...result,
            });
        } catch (error) {
            console.error('Failed to load distribution info:', error);
            setInfo(DEFAULT_DISTRIBUTION_INFO);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const value = useMemo(() => ({
        info,
        loaded,
        reload: load,
    }), [info, loaded, load]);

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
