import { useTranslation } from 'react-i18next';
import {
    IconDashboard,
    IconRefresh,
    IconHistory,
    IconSettings,
} from '@tabler/icons-react';

interface SidebarProps {
    activeTab: string;
    onTabChange: (tab: string) => void;
}

interface NavItem {
    id: string;
    labelKey: string;
    icon: typeof IconDashboard;
}

const navItems: NavItem[] = [
    { id: 'dashboard', labelKey: 'nav.dashboard', icon: IconDashboard },
    { id: 'sync-tasks', labelKey: 'nav.syncTasks', icon: IconRefresh },
    { id: 'activity-log', labelKey: 'nav.activityLog', icon: IconHistory },
    { id: 'settings', labelKey: 'nav.settings', icon: IconSettings },
];

/**
 * Sidebar navigation component
 * Minimal design with ghost-style tabs
 */
function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const { t } = useTranslation();

    return (
        <aside className="sidebar">
            <header className="sidebar-header">
                <h1 className="sidebar-title">{t('appName')}</h1>
            </header>

            <nav className="nav-tabs">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;

                    return (
                        <button
                            key={item.id}
                            className={`nav-tab ${isActive ? 'active' : ''}`}
                            onClick={() => onTabChange(item.id)}
                            aria-current={isActive ? 'page' : undefined}
                        >
                            <Icon size={18} stroke={1.5} />
                            <span>{t(item.labelKey)}</span>
                        </button>
                    );
                })}
            </nav>
        </aside>
    );
}

export default Sidebar;
