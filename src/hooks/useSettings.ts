import { useState, useEffect, useCallback } from 'react';
import i18n from '../i18n';

interface Settings {
    language: string;
    theme: 'light' | 'dark' | 'system';
    notifications: boolean;
    autoSync: boolean;
    deleteConfirmation: boolean;
    verifyAfterCopy: boolean;
}

const defaultSettings: Settings = {
    language: 'en',
    theme: 'system',
    notifications: true,
    autoSync: false,
    deleteConfirmation: true,
    verifyAfterCopy: true,
};

const STORAGE_KEY = 'syncwatcher_settings';

/**
 * Hook for managing app settings with localStorage persistence
 */
export function useSettings() {
    const [settings, setSettings] = useState<Settings>(defaultSettings);
    const [loaded, setLoaded] = useState(false);

    // Load settings from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored) as Partial<Settings>;
                setSettings({ ...defaultSettings, ...parsed });
            }
        } catch (err) {
            console.error('Failed to load settings:', err);
        }
        setLoaded(true);
    }, []);

    // Apply theme when settings change
    useEffect(() => {
        if (!loaded) return;

        const applyTheme = (theme: string) => {
            if (theme === 'system') {
                document.documentElement.removeAttribute('data-theme');
                document.documentElement.classList.remove('dark');
            } else if (theme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.setAttribute('data-theme', 'light');
                document.documentElement.classList.remove('dark');
            }
        };

        applyTheme(settings.theme);

        // Apply language
        if (i18n.language !== settings.language) {
            i18n.changeLanguage(settings.language);
        }
    }, [settings.theme, settings.language, loaded]);

    const updateSettings = useCallback((updates: Partial<Settings>) => {
        setSettings((prev) => {
            const newSettings = { ...prev, ...updates };
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
            } catch (err) {
                console.error('Failed to save settings:', err);
            }
            return newSettings;
        });
    }, []);

    const resetSettings = useCallback(() => {
        setSettings(defaultSettings);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultSettings));
        } catch (err) {
            console.error('Failed to reset settings:', err);
        }
    }, []);

    return {
        settings,
        loaded,
        updateSettings,
        resetSettings,
    };
}

export default useSettings;
export type { Settings };
