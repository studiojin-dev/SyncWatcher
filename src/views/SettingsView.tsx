import { useTranslation } from 'react-i18next';
import { Switch, Select } from '@mantine/core';
import { useSettings } from '../hooks/useSettings';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

const languages = [
    { value: 'en', label: 'English' },
    { value: 'ko', label: '한국어' },
    { value: 'ja', label: '日本語' },
    { value: 'zh', label: '中文' },
    { value: 'es', label: 'Español' },
];

const themes = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
];

/**
 * Settings View - App configuration
 * Language, theme, notifications, sync options
 */
function SettingsView() {
    const { t } = useTranslation();
    const { settings, updateSettings, resetSettings, loaded } = useSettings();

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

    const handleHideToTray = async () => {
        try {
            const window = getCurrentWindow();
            await window.hide();
        } catch (err) {
            console.error('Failed to hide window:', err);
        }
    };

    return (
        <div className="fade-in max-w-3xl">
            <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-b-3 border-[var(--border-main)]">
                <h1 className="text-2xl font-heading font-black uppercase mb-1">
                    {t('settings.title')}
                </h1>
                <div className="font-mono text-xs">
                    // SYSTEM_CONFIGURATION
                </div>
            </header>

            <div className="grid gap-8">
                {/* Visual Settings Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-main)]">
                        Display
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
                    </div>
                </section>

                {/* System Settings Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-warning)]">
                        System
                    </h2>
                    <div className="neo-box p-6 space-y-6">
                        {/* State Location */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                State Location
                            </label>
                            <div className="flex gap-2">
                                <input
                                    value={settings.stateLocation}
                                    onChange={(e) => updateSettings({ stateLocation: e.target.value })}
                                    className="neo-input flex-1 font-mono text-sm"
                                    placeholder="Default: Tauri AppData"
                                />
                                <button
                                    onClick={() => handleBrowseFolder('stateLocation')}
                                    className="px-4 font-bold uppercase border-3 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]"
                                >
                                    Browse
                                </button>
                            </div>
                        </div>

                        {/* Max Log Lines */}
                        <div>
                            <label className="block text-sm font-bold mb-2 uppercase font-mono">
                                Max Log Lines
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

                {/* Behavior Section */}
                <section>
                    <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-success)]">
                        Behavior
                    </h2>
                    <div className="neo-box p-6 space-y-4">
                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <div>
                                <div className="font-bold">Hide to Tray</div>
                                <div className="text-xs text-[var(--text-secondary)]">Run in background without dock icon</div>
                            </div>
                            <button
                                onClick={handleHideToTray}
                                className="px-4 py-1 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] font-bold text-sm uppercase"
                            >
                                HIDE
                            </button>
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
                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <span className="font-bold">{t('settings.deleteConfirmation')}</span>
                            <Switch
                                size="md"
                                checked={settings.deleteConfirmation}
                                onChange={(e) => updateSettings({ deleteConfirmation: e.currentTarget.checked })}
                                styles={{ track: { border: '2px solid black', cursor: 'pointer' }, thumb: { border: '2px solid black' } }}
                            />
                        </div>
                        <div className="flex justify-between items-center py-2 border-b border-dashed border-[var(--border-main)] last:border-0">
                            <span className="font-bold">{t('settings.verifyAfterCopy')}</span>
                            <Switch
                                size="md"
                                checked={settings.verifyAfterCopy}
                                onChange={(e) => updateSettings({ verifyAfterCopy: e.currentTarget.checked })}
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
