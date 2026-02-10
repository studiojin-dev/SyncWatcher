import { createContext, useState, useCallback, useEffect, ReactNode, useContext } from 'react';
import i18n from '../i18n';
import { DataUnitSystem } from '../utils/formatBytes';

export interface Settings {
    language: string;
    theme: 'light' | 'dark' | 'system';
    dataUnitSystem: DataUnitSystem;
    notifications: boolean;
    stateLocation: string;
    maxLogLines: number;
    closeAction: 'quit' | 'background';
}

const defaultSettings: Settings = {
    language: 'en',
    theme: 'system',
    dataUnitSystem: 'binary',
    notifications: true,
    stateLocation: '',
    maxLogLines: 10000,
    closeAction: 'quit',
};

const STORAGE_KEY = 'syncwatcher_settings';

interface SettingsContextType {
    settings: Settings;
    loaded: boolean;
    updateSettings: (updates: Partial<Settings>) => void;
    resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
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

    const applyTheme = useCallback((theme: string) => {
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
    }, []);

    // Side effects for settings changes
    useEffect(() => {
        if (!loaded) return;

        applyTheme(settings.theme);
        i18n.changeLanguage(settings.language);
    }, [settings.theme, settings.language, loaded, applyTheme]);

    return (
        <SettingsContext.Provider value={{ settings, loaded, updateSettings, resetSettings }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }
    return context;
}
