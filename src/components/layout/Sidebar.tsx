import { useTranslation } from 'react-i18next';
import {
    IconDashboard,
    IconRefresh,
    IconHistory,
    IconSettings,
    IconHelp,
    IconInfoCircle,
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
    { id: 'help', labelKey: 'nav.help', icon: IconHelp },
    { id: 'about', labelKey: 'nav.about', icon: IconInfoCircle },
];

/**
 * Sidebar navigation component
 * Minimal design with ghost-style tabs
 */
function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const { t } = useTranslation();

    return (
        <aside className="flex flex-col h-full bg-[var(--bg-secondary)] text-[var(--text-primary)]">
            <header className="p-6 border-b-3 border-[var(--border-main)] bg-[var(--bg-primary)]">
                <h1 className="text-2xl font-bold font-heading tracking-tight uppercase">
                    {t('appName')}
                </h1>
            </header>

            <nav className="flex-1 p-4 space-y-2">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;

                    return (
                        <button
                            key={item.id}
                            className={`
                                w-full flex items-center gap-3 px-4 py-3 
                                font-bold font-heading uppercase tracking-wide
                                border-3 transition-all duration-150
                                ${isActive
                                    ? 'bg-[var(--accent-main)] text-white border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] translate-x-[-2px] translate-y-[-2px]'
                                    : 'bg-[var(--bg-primary)] border-transparent hover:border-[var(--border-main)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                }
                            `}
                            onClick={() => onTabChange(item.id)}
                            aria-current={isActive ? 'page' : undefined}
                        >
                            <Icon size={20} stroke={2} />
                            <span>{t(item.labelKey)}</span>
                        </button>
                    );
                })}
            </nav>

            <div className="p-4 border-t-3 border-[var(--border-main)] bg-[var(--bg-primary)] opacity-50 hover:opacity-100 transition-opacity">
                <p className="text-xs font-mono text-center">v0.1.0 • AGPL-3.0</p>
            </div>
        </aside>
    );
}

export default Sidebar;
