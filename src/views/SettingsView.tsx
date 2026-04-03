import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, Select } from '@mantine/core';
import { invoke } from '@tauri-apps/api/core';
import { ExclusionSetsManager } from '../components/settings/ExclusionSetsManager';
import { useDistribution } from '../hooks/useDistribution';
import { useSettings } from '../hooks/useSettings';
import { open } from '@tauri-apps/plugin-dialog';
import { DataUnitSystem } from '../utils/formatBytes';
import { capturePathAccess } from '../utils/pathAccess';
import { getDistributionPolicy } from '../utils/distributionPolicy';
import LicenseActivation from '../components/features/LicenseActivation';
import { lemonSqueezyCheckoutUrl, privacyPolicyUrl, termsOfServiceUrl } from '../config/appLinks';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'ko', label: '한국어' },
    { value: 'ja', label: '日本語' },
    { value: 'zh', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'es', label: 'Español' },
];

interface McpStdioConfigExample {
    command: string;
    args: string[];
}

/**
 * Settings View - App configuration
 * Language, theme, notifications, sync options
 */
function SettingsView() {
    const { t } = useTranslation();
    const { info: distribution, loaded: distributionLoaded } = useDistribution();
    const { settings, updateSettings, setLaunchAtLogin, resetSettings, loaded } = useSettings();
    const [showLicenseModal, setShowLicenseModal] = useState(false);
    const [mcpConfigExample, setMcpConfigExample] = useState<McpStdioConfigExample | null>(null);
    const policy = getDistributionPolicy(distribution);
    const canShowExternalCheckout =
        distributionLoaded && policy.supportsExternalCheckout && !!lemonSqueezyCheckoutUrl;
    const themes = [
        { value: 'system', label: t('settings.themeSystem') },
        { value: 'light', label: t('settings.themeLight') },
        { value: 'dark', label: t('settings.themeDark') },
    ];
    const dataUnitSystems = [
        { value: 'binary', label: t('settings.unitBinary') },
        { value: 'decimal', label: t('settings.unitDecimal') },
    ];

    useEffect(() => {
        let cancelled = false;

        void invoke<McpStdioConfigExample>('get_mcp_stdio_config_example')
            .then((example) => {
                if (!cancelled) {
                    setMcpConfigExample(example);
                }
            })
            .catch((error) => {
                console.warn('Failed to load MCP stdio config example:', error);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    if (!loaded) {
        return (
            <div className="text-secondary" style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
                {t('common.loading')}
            </div>
        );
    }

    const handleBrowseFolder = async (settingKey: 'stateLocation') => {
        try {
            const selected = await open({ directory: true });
            if (selected && typeof selected === 'string') {
                const captured = await capturePathAccess(selected);
                updateSettings({
                    [settingKey]: captured.path,
                    stateLocationBookmark: captured.bookmark ?? '',
                });
            }
        } catch (err) {
            console.error('Failed to open folder dialog:', err);
        }
    };

    return (
        <div className="fade-in max-w-3xl">
            <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
                <h1 className="text-3xl font-heading font-black uppercase mb-1">
                    {t('settings.title')}
                </h1>
                <div className="font-mono text-xs border-l-4 border-[var(--accent-warning)] pl-3">
                    // SYSTEM_CONFIGURATION
                </div>
            </header>

            <div className="grid gap-8">
                {/* Visual Settings Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-main)]">
                        {t('settings.sectionDisplay')}
                    </h2>
                    <div className="neo-box p-6 space-y-6">
                        {/* Language */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                {t('settings.language')}
                            </label>
                            <Select
                                value={settings.language}
                                onChange={(value) => value && updateSettings({ language: value })}
                                data={languages}
                                styles={{
                                    input: {
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)',
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        fontFamily: 'var(--font-heading)',
                                        fontWeight: 'bold',
                                        minHeight: '42px',
                                    },
                                    dropdown: {
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        boxShadow: '4px 4px 0 0 black',
                                    }
                                }}
                            />
                        </div>

                        {/* Theme */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                {t('settings.darkMode')}
                            </label>
                            <Select
                                value={settings.theme}
                                onChange={(value) => value && updateSettings({ theme: value as 'light' | 'dark' | 'system' })}
                                data={themes}
                                styles={{
                                    input: {
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)',
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        fontFamily: 'var(--font-heading)',
                                        fontWeight: 'bold',
                                        minHeight: '42px',
                                    },
                                    dropdown: {
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        boxShadow: '4px 4px 0 0 black',
                                    }
                                }}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                {t('settings.dataUnit')}
                            </label>
                            <Select
                                value={settings.dataUnitSystem}
                                onChange={(value) => value && updateSettings({
                                    dataUnitSystem: value as DataUnitSystem,
                                })}
                                data={dataUnitSystems}
                                styles={{
                                    input: {
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)',
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        fontFamily: 'var(--font-heading)',
                                        fontWeight: 'bold',
                                        minHeight: '42px',
                                    },
                                    dropdown: {
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        boxShadow: '4px 4px 0 0 black',
                                    },
                                }}
                            />
                        </div>
                    </div>
                </section>

                {/* System Settings Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-warning)]">
                        {t('settings.sectionSystem')}
                    </h2>
                    <div className="neo-box p-6 space-y-6">
                        {/* State Location */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                {t('settings.stateLocation')}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    value={settings.stateLocation}
                                    onChange={(e) => updateSettings({
                                        stateLocation: e.target.value,
                                        stateLocationBookmark: '',
                                    })}
                                    readOnly={
                                        distributionLoaded
                                            ? policy.requiresSecurityScopedBookmarks
                                            : true
                                    }
                                    className="neo-input flex-1 font-mono text-sm"
                                    placeholder={t('settings.stateLocationPlaceholder')}
                                />
                                <button
                                    onClick={() => handleBrowseFolder('stateLocation')}
                                    className="px-4 font-bold uppercase border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]"
                                >
                                    {t('common.browse')}
                                </button>
                            </div>
                        </div>

                        {/* Max Log Lines */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                {t('settings.maxLogLines')}
                            </label>
                            <input
                                type="number"
                                min="100"
                                max="100000"
                                value={settings.maxLogLines}
                                onChange={(e) => updateSettings({ maxLogLines: parseInt(e.target.value) || 10000 })}
                                className="neo-input w-full"
                            />
                        </div>

                        <div className="flex justify-between items-center py-2 border-t border-dashed border-[var(--border-main)]">
                            <div className="pr-4">
                                <div className="font-bold">{t('settings.mcpEnabled')}</div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                    {t('settings.mcpEnabledDesc')}
                                </div>
                            </div>
                            <Switch
                                size="md"
                                checked={settings.mcpEnabled}
                                onChange={(e) => updateSettings({ mcpEnabled: e.currentTarget.checked })}
                                styles={{ track: { border: '2px solid black', cursor: 'pointer' }, thumb: { border: '2px solid black' } }}
                            />
                        </div>

                        {mcpConfigExample && (
                            <div className="border-2 border-[var(--border-main)] bg-[var(--bg-primary)] p-4">
                                <div className="font-bold mb-2">{t('settings.mcpConfigExampleTitle')}</div>
                                <p className="text-xs text-[var(--text-secondary)] mb-3">
                                    {t('settings.mcpConfigExampleDesc')}
                                </p>
                                <pre className="whitespace-pre-wrap break-all bg-[var(--bg-secondary)] border-2 border-[var(--border-main)] p-3 text-xs font-mono">
                                    {JSON.stringify(mcpConfigExample, null, 2)}
                                </pre>
                            </div>
                        )}
                    </div>
                </section>

                <ExclusionSetsManager />

                {/* Behavior Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-success)]">
                        {t('settings.sectionBehavior')}
                    </h2>
                    <div className="neo-box p-6 space-y-4">
                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <div className="pr-4">
                                <div className="font-bold">{t('settings.launchAtLogin')}</div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                    {t('settings.launchAtLoginDesc')}
                                </div>
                            </div>
                            <Switch
                                size="md"
                                checked={settings.launchAtLogin}
                                onChange={(e) => {
                                    void setLaunchAtLogin(e.currentTarget.checked);
                                }}
                                styles={{ track: { border: '2px solid black', cursor: 'pointer' }, thumb: { border: '2px solid black' } }}
                            />
                        </div>

                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <div>
                                <div className="font-bold">{t('settings.closeAction')}</div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                    {t('settings.closeActionDesc')}
                                </div>
                            </div>
                            <Select
                                value={settings.closeAction}
                                onChange={(value) => value && updateSettings({
                                    closeAction: value as 'quit' | 'background',
                                })}
                                data={[
                                    { value: 'quit', label: t('settings.closeActionQuit') },
                                    { value: 'background', label: t('settings.closeActionBackground') },
                                ]}
                                styles={{
                                    input: {
                                        background: 'var(--bg-primary)',
                                        color: 'var(--text-primary)',
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        fontFamily: 'var(--font-heading)',
                                        fontWeight: 'bold',
                                        minHeight: '42px',
                                        minWidth: '220px',
                                    },
                                    dropdown: {
                                        border: '3px solid var(--border-main)',
                                        borderRadius: 0,
                                        boxShadow: '4px 4px 0 0 black',
                                    },
                                }}
                            />
                        </div>

                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <span className="font-bold">{t('settings.notifications')}</span>
                            <Switch
                                size="md"
                                checked={settings.notifications}
                                onChange={(e) => updateSettings({ notifications: e.currentTarget.checked })}
                                styles={{ track: { border: '2px solid black', cursor: 'pointer' }, thumb: { border: '2px solid black' } }}
                            />
                        </div>
                    </div>
                </section>

                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-error)]">
                        {t('settings.sectionLicense')}
                    </h2>
                    <div className="neo-box p-6 space-y-4">
                        <div className="flex items-center justify-between gap-4 border-b border-dashed border-[var(--border-main)] pb-4">
                            <div>
                                <div className="font-bold">{t('about.supportStatus')}</div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                    {settings.isRegistered ? t('about.thankYou') : t('about.supportHint')}
                                </div>
                            </div>
                            <span className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-1 text-xs font-black uppercase tracking-wider">
                                {settings.isRegistered ? t('about.registered') : t('about.unregistered')}
                            </span>
                        </div>

                        <div className="flex flex-col gap-3 sm:flex-row">
                            {canShowExternalCheckout ? (
                                <a
                                    href={lemonSqueezyCheckoutUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center border-3 border-[var(--border-main)] bg-black px-4 py-3 text-xs font-bold uppercase tracking-wider text-[var(--accent-warning)] shadow-[4px_4px_0_0_var(--shadow-color)] transition-all hover:opacity-90"
                                >
                                    {t('about.purchaseLicense')}
                                </a>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => setShowLicenseModal(true)}
                                disabled={!distributionLoaded}
                                className="border-3 border-[var(--border-main)] bg-[var(--bg-primary)] px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors hover:bg-[var(--bg-secondary)]"
                            >
                                {!distributionLoaded
                                    ? t('common.loading')
                                    : policy.supportsStoreKitPurchase
                                        ? settings.isRegistered
                                            ? t('license.restore')
                                            : t('license.appStorePurchase')
                                        : settings.isRegistered
                                            ? t('license.manage')
                                            : t('license.enterLicense')}
                            </button>
                        </div>
                    </div>
                </section>

                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-main)]">
                        {t('settings.sectionLegal')}
                    </h2>
                    <div className="neo-box p-6 space-y-3">
                        <a
                            href={termsOfServiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center border-3 border-[var(--border-main)] bg-[var(--bg-primary)] px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors hover:bg-[var(--bg-secondary)]"
                        >
                            {t('settings.termsLink')}
                        </a>
                        <a
                            href={privacyPolicyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center border-3 border-[var(--border-main)] bg-[var(--bg-primary)] px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors hover:bg-[var(--bg-secondary)]"
                        >
                            {t('settings.privacyLink')}
                        </a>
                    </div>
                </section>

                {/* Danger Zone */}
                <div className="mt-8 pt-8 border-t-3 border-[var(--border-main)] border-dashed">
                    <button
                        className="w-full py-3 border-3 border-dashed border-[var(--color-accent-error)] text-[var(--color-accent-error)] font-black hover:bg-[var(--color-accent-error)] hover:text-white transition-all uppercase"
                        onClick={resetSettings}
                    >
                        ⚠ {t('settings.resetDefaults')}
                    </button>
                </div>
            </div>
            <LicenseActivation open={showLicenseModal} onClose={() => setShowLicenseModal(false)} />
        </div>
    );
}

export default SettingsView;
