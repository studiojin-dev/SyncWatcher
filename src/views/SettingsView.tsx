import { useTranslation } from 'react-i18next';
import { Switch, Select } from '@mantine/core';
import { ExclusionSetsManager } from '../components/settings/ExclusionSetsManager';
import { useSettings } from '../hooks/useSettings';
import { open } from '@tauri-apps/plugin-dialog';
import { DataUnitSystem } from '../utils/formatBytes';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'ko', label: '한국어' },
    { value: 'ja', label: '日本語' },
    { value: 'zh', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'es', label: 'Español' },
];

/**
 * Settings View - App configuration
 * Language, theme, notifications, sync options
 */
function SettingsView() {
    const { t } = useTranslation();
    const { settings, updateSettings, resetSettings, loaded } = useSettings();
    const themes = [
        { value: 'system', label: t('settings.themeSystem') },
        { value: 'light', label: t('settings.themeLight') },
        { value: 'dark', label: t('settings.themeDark') },
    ];
    const dataUnitSystems = [
        { value: 'binary', label: t('settings.unitBinary') },
        { value: 'decimal', label: t('settings.unitDecimal') },
    ];

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
            if (selected) {
                updateSettings({ [settingKey]: selected as string });
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
                                    onChange={(e) => updateSettings({ stateLocation: e.target.value })}
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
        </div>
    );
}

export default SettingsView;
