import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../hooks/useSettings';
import LicenseActivation from '../features/LicenseActivation';
import PizzaBiteAnimation from '../ui/PizzaBiteAnimation';
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
    const { settings } = useSettings();
    const isRegistered = settings.isRegistered;
    const [showLicenseModal, setShowLicenseModal] = useState(false);
    const [showSupportModal, setShowSupportModal] = useState(false);

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
            <div className="p-4 border-t-4 border-[var(--border-main)] bg-[var(--bg-secondary)] space-y-4">
                {/* Registration Status */}
                <div className="flex flex-col gap-3">
                    {!isRegistered ? (
                        <div className="flex flex-col gap-2 p-3 bg-[var(--bg-primary)] border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--accent-error)]">
                                    {t('about.unregistered')}
                                </span>
                                <div className="w-2 h-2 rounded-full bg-[var(--accent-error)] animate-pulse" />
                            </div>
                            <a
                                href="https://studiojin.lemonsqueezy.com/checkout/buy/syncwatcher"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full text-center text-[10px] font-black uppercase tracking-widest bg-black text-[var(--accent-warning)] py-2 hover:bg-[var(--accent-warning)] hover:text-black transition-all transform hover:-translate-y-1 hover:shadow-[0_4px_0_0_black] active:translate-y-0 active:shadow-none"
                            >
                                {t('about.purchaseLicense')}
                            </a>
                            <button
                                onClick={() => setShowLicenseModal(true)}
                                className="w-full text-center text-[10px] font-black uppercase tracking-widest bg-[var(--bg-secondary)] text-[var(--text-primary)] py-2 border-t border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                            >
                                {t('license.enterLicense')}
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2.5 p-3 bg-[var(--bg-tertiary)] border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] overflow-hidden">
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--accent-success)]">
                                    {t('about.registered')}
                                </span>
                                <div className="w-2 h-2 rounded-full bg-[var(--accent-success)]" />
                            </div>
                            <div className="flex items-center gap-3 border-2 border-[var(--border-main)] bg-[var(--bg-primary)] px-2 py-1.5">
                                <PizzaBiteAnimation className="shrink-0" />
                                <div className="min-w-0">
                                    <p className="text-[10px] font-black uppercase tracking-wider text-[var(--text-primary)]">
                                        {t('about.supportTitle')}
                                    </p>
                                    <p className="mt-1 text-[9px] font-bold italic leading-relaxed text-[var(--text-secondary)]">
                                        {t('about.supportHint')}
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowSupportModal(true)}
                                className="w-full text-center text-[10px] font-black uppercase tracking-widest bg-black text-[var(--accent-warning)] py-2 hover:bg-[var(--accent-warning)] hover:text-black transition-all transform hover:-translate-y-1 hover:shadow-[0_4px_0_0_black] active:translate-y-0 active:shadow-none"
                            >
                                {t('about.supportButton')}
                            </button>
                        </div>
                    )}
                </div>

                <div className="neo-box p-2 bg-[var(--bg-primary)] text-center text-[10px] uppercase font-bold tracking-widest border-2 border-[var(--border-main)] relative overflow-hidden group">
                    <span className="relative z-10">v{import.meta.env.PACKAGE_VERSION || '0.9.1-beta'}</span>
                    <div className="absolute inset-0 bg-[var(--accent-warning)] translate-y-full group-hover:translate-y-0 transition-transform duration-200" />
                </div>
            </div>
            <LicenseActivation
                open={showLicenseModal}
                onClose={() => setShowLicenseModal(false)}
            />
            {showSupportModal && createPortal(
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
                    data-testid="support-modal-overlay"
                    onClick={() => setShowSupportModal(false)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="support-modal-title"
                        className="w-full max-w-md border-4 border-[var(--border-main)] bg-[var(--bg-primary)] shadow-[8px_8px_0_0_var(--shadow-color)]"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between border-b-4 border-[var(--border-main)] bg-[var(--accent-warning)] px-5 py-3">
                            <h2
                                id="support-modal-title"
                                className="text-sm font-black uppercase tracking-wider text-black"
                            >
                                {t('about.supportModalTitle')}
                            </h2>
                            <button
                                onClick={() => setShowSupportModal(false)}
                                aria-label={t('common.close')}
                                className="text-black text-lg font-black hover:opacity-70 transition-opacity"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="space-y-4 p-5">
                            <p className="text-xs leading-relaxed font-bold text-[var(--text-primary)]">
                                {t('about.supportModalMessage')}
                            </p>
                        </div>

                        <div className="flex justify-end gap-3 border-t-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-5 py-3">
                            <button
                                onClick={() => setShowSupportModal(false)}
                                className="border-2 border-[var(--border-main)] px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-[var(--bg-tertiary)] transition-colors"
                            >
                                {t('about.supportModalCancel')}
                            </button>
                            <a
                                href="https://buymeacoffee.com/studiojin_dev"
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setShowSupportModal(false)}
                                className="inline-flex items-center justify-center border-2 border-[var(--border-main)] bg-black px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--accent-warning)] shadow-[3px_3px_0_0_var(--shadow-color)] hover:opacity-90 transition-all"
                            >
                                {t('about.supportModalConfirm')}
                            </a>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </aside>
    );
}

export default Sidebar;
