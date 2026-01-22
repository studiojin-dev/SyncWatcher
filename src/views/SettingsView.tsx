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
        <div className="fade-in">
            <header style={{ marginBottom: 'var(--space-8)' }}>
                <h1 className="text-xl" style={{ fontWeight: 'var(--weight-normal)', marginBottom: 'var(--space-2)' }}>
                    {t('settings.title')}
                </h1>
            </header>

            <div style={{ maxWidth: '480px', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
                {/* Language */}
                <div className="card">
                    <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                        {t('settings.language')}
                    </label>
                    <Select
                        value={settings.language}
                        onChange={(value) => value && updateSettings({ language: value })}
                        data={languages}
                        styles={{
                            input: {
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--accent-border)',
                                color: 'var(--text-primary)',
                            },
                        }}
                    />
                </div>

                {/* Theme */}
                <div className="card">
                    <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                        {t('settings.darkMode')}
                    </label>
                    <Select
                        value={settings.theme}
                        onChange={(value) => value && updateSettings({ theme: value as 'light' | 'dark' | 'system' })}
                        data={themes}
                        styles={{
                            input: {
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--accent-border)',
                                color: 'var(--text-primary)',
                            },
                        }}
                    />
                </div>

                {/* State Location */}
                <div className="card">
                    <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                        State Location
                    </label>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                        <input
                            value={settings.stateLocation}
                            onChange={(e) => updateSettings({ stateLocation: e.target.value })}
                            className="btn-ghost"
                            style={{ flex: 1 }}
                            placeholder="Default: Tauri AppData"
                        />
                        <button
                            onClick={() => handleBrowseFolder('stateLocation')}
                            className="btn-ghost"
                        >
                            Browse
                        </button>
                    </div>
                </div>

                {/* Max Log Lines */}
                <div className="card">
                    <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                        Max Log Lines (per log file)
                    </label>
                    <input
                        type="number"
                        min="100"
                        max="100000"
                        value={settings.maxLogLines}
                        onChange={(e) => updateSettings({ maxLogLines: parseInt(e.target.value) || 10000 })}
                        className="btn-ghost"
                        style={{ width: '100%' }}
                    />
                </div>

                {/* Hide to Tray */}
                <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <div className="text-sm">Hide to Tray</div>
                            <div className="text-xs text-tertiary">
                                Run in background without dock icon
                            </div>
                        </div>
                        <button
                            onClick={handleHideToTray}
                            className="btn-ghost"
                        >
                            Hide
                        </button>
                    </div>
                </div>

                {/* Toggles */}
                <div className="card">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="text-sm">{t('settings.notifications')}</span>
                            <Switch
                                checked={settings.notifications}
                                onChange={(e) => updateSettings({ notifications: e.currentTarget.checked })}
                            />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="text-sm">{t('settings.deleteConfirmation')}</span>
                            <Switch
                                checked={settings.deleteConfirmation}
                                onChange={(e) => updateSettings({ deleteConfirmation: e.currentTarget.checked })}
                            />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="text-sm">{t('settings.verifyAfterCopy')}</span>
                            <Switch
                                checked={settings.verifyAfterCopy}
                                onChange={(e) => updateSettings({ verifyAfterCopy: e.currentTarget.checked })}
                            />
                        </div>
                    </div>
                </div>

                {/* Reset Button */}
                <button className="btn-ghost" onClick={resetSettings}>
                    {t('settings.resetDefaults')}
                </button>
            </div>
        </div>
    );
}

export default SettingsView;
