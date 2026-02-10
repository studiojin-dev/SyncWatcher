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
    { id: 'sync-tasks', labelKey: 'nav.syncTasks', icon: IconRefresh },
    { id: 'dashboard', labelKey: 'nav.dashboard', icon: IconDashboard },
    { id: 'activity-log', labelKey: 'nav.activityLog', icon: IconHistory },
    { id: 'settings', labelKey: 'nav.settings', icon: IconSettings },
    { id: 'help', labelKey: 'nav.help', icon: IconHelp },
    { id: 'about', labelKey: 'nav.about', icon: IconInfoCircle },
];

/**
 * Sidebar navigation component
 * "Hard" Neo-Brutalism Redesign
 * - Thick borders
 * - High contrast (Yellow/Black)
 * - Deep shadows
 */
function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const { t } = useTranslation();

    return (
        <aside className="flex flex-col h-full bg-[var(--bg-primary)] border-r-4 border-[var(--border-main)] overflow-hidden">
            {/* Header Area */}
            <header className="p-6 border-b-4 border-[var(--border-main)] bg-[var(--bg-tertiary)] flex flex-col gap-2 relative">
                <div className="flex items-center gap-3 relative z-10">
                    <div className="w-10 h-10 bg-[var(--accent-error)] border-3 border-[var(--border-main)] flex items-center justify-center shadow-[4px_4px_0_0_var(--shadow-color)]">
                        <span className="font-heading font-black text-xl text-white">S</span>
                    </div>
                    <h1 className="text-2xl font-black font-heading tracking-tighter uppercase italic transform -rotate-2">
                        {t('appName')}
                    </h1>
                </div>
            </header>

            {/* Nav Items */}
            <nav className="flex-1 p-5 space-y-4 overflow-y-auto">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;

                    return (
                        <button
                            key={item.id}
                            className={`
                                group w-full flex items-center gap-4 px-5 py-4
                                font-bold font-heading uppercase text-sm tracking-wider
                                border-3 transition-all duration-100 ease-in-out relative
                                ${isActive
                                    ? 'bg-[var(--accent-warning)] text-black border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] translate-x-[-2px] translate-y-[-2px]'
                                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--text-secondary)] hover:border-[var(--border-main)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] hover:shadow-[4px_4px_0_0_var(--shadow-color)] hover:translate-x-[-2px] hover:translate-y-[-2px]'
                                }
                            `}
                            onClick={() => onTabChange(item.id)}
                            aria-current={isActive ? 'page' : undefined}
                        >
                            {/* Icon Box */}
                            <div className={`
                                p-1 border-2 transition-colors
                                ${isActive
                                    ? 'bg-black text-[var(--accent-warning)] border-black'
                                    : 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-main)] group-hover:bg-white'
                                }
                            `}>
                                <Icon size={22} stroke={2.5} />
                            </div>

                            <span>{t(item.labelKey)}</span>

                            {/* Active Indicator Arrow */}
                            {isActive && (
                                <div className="absolute right-4 font-black text-xl animate-pulse">
                                    &lt;
                                </div>
                            )}
                        </button>
                    );
                })}
            </nav>

            {/* Footer */}
            <div className="p-4 border-t-4 border-[var(--border-main)] bg-[var(--bg-secondary)] space-y-3">
                {/* Registration Status */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-3 py-2 bg-[var(--bg-primary)] border-2 border-[var(--border-main)] shadow-[3px_3px_0_0_var(--shadow-color)]">
                        <span className="text-[10px] font-black uppercase tracking-wider text-[var(--accent-error)]">
                            {t('about.unregistered')}
                        </span>
                        <a
                            href="https://studiojin.lemonsqueezy.com/checkout/buy/syncwatcher"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-black uppercase tracking-tighter bg-black text-[var(--accent-warning)] px-2 py-0.5 hover:bg-[var(--accent-warning)] hover:text-black transition-colors"
                        >
                            {t('about.purchaseLicense')}
                        </a>
                    </div>
                </div>

                <div className="neo-box p-2 bg-[var(--bg-primary)] text-center text-[10px] uppercase font-bold tracking-widest border-2 border-[var(--border-main)]">
                    v{import.meta.env.PACKAGE_VERSION || '0.1.0'}
                    <span className="mx-2 text-[var(--border-main)]">•</span>
                    {t('about.licenseType')}
                </div>
            </div>
        </aside>
    );
}

export default Sidebar;
