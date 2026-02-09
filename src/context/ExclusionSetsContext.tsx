import { createContext, useContext, ReactNode } from 'react';
import { useExclusionSets } from '../hooks/useExclusionSets';

type ExclusionSetsContextValue = ReturnType<typeof useExclusionSets>;

const ExclusionSetsContext = createContext<ExclusionSetsContextValue | null>(null);

export function ExclusionSetsProvider({ children }: { children: ReactNode }) {
    const value = useExclusionSets();
    return (
        <ExclusionSetsContext.Provider value={value}>
            {children}
        </ExclusionSetsContext.Provider>
    );
}

export function useExclusionSetsContext() {
    const context = useContext(ExclusionSetsContext);
    if (!context) {
        throw new Error('useExclusionSetsContext must be used within a ExclusionSetsProvider');
    }
    return context;
}
