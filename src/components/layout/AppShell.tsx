import { ReactNode } from 'react';
import Sidebar from './Sidebar';
import '../../styles/design-system.css';

interface AppShellProps {
    children: ReactNode;
    activeTab: string;
    onTabChange: (tab: string) => void;
}

/**
 * App Shell component - Main layout with sidebar + content area
 * Based on DESIGN_SYSTEM.md principles
 */
function AppShell({ children, activeTab, onTabChange }: AppShellProps) {
    return (
        <div className="app-shell">
            <Sidebar activeTab={activeTab} onTabChange={onTabChange} />
            <main className="main-content fade-in">
                {children}
            </main>
        </div>
    );
}

export default AppShell;
