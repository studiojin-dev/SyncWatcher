import { createContext, useContext, ReactNode } from 'react';
import { useSaveRuleTemplates } from '../hooks/useSaveRuleTemplates';

type SaveRuleTemplatesContextValue = ReturnType<typeof useSaveRuleTemplates>;

const SaveRuleTemplatesContext = createContext<SaveRuleTemplatesContextValue | null>(null);

export function SaveRuleTemplatesProvider({ children }: { children: ReactNode }) {
    const value = useSaveRuleTemplates();
    return (
        <SaveRuleTemplatesContext.Provider value={value}>
            {children}
        </SaveRuleTemplatesContext.Provider>
    );
}

export function useSaveRuleTemplatesContext() {
    const context = useContext(SaveRuleTemplatesContext);
    if (!context) {
        throw new Error('useSaveRuleTemplatesContext must be used within a SaveRuleTemplatesProvider');
    }
    return context;
}
