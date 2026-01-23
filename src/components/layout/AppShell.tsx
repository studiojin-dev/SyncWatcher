import { ReactNode } from 'react';
import Sidebar from './Sidebar';

interface AppShellProps {
    children: ReactNode;
    activeTab: string;
    onTabChange: (tab: string) => void;
}

/**
 * AppShell - Neo-Brutalist Layout
 * 
 * Uses a rigid grid layout with thick borders.
 * The sidebar is a dedicated column, separated by a border.
 */
function AppShell({ children, activeTab, onTabChange }: AppShellProps) {
    return (
        <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
            {/* Sidebar - Fixed width, Border Right */}
            <aside className="w-64 border-r-3 border-t-3 border-[var(--border-main)] flex-shrink-0 bg-[var(--bg-secondary)]">
                <Sidebar activeTab={activeTab} onTabChange={onTabChange} />
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 overflow-y-auto p-12 bg-[var(--bg-primary)] border-t-3 border-[var(--border-main)]">
                <div className="max-w-7xl mx-auto">
                    {children}
                </div>
            </main>
        </div>
    );
}

export default AppShell;
