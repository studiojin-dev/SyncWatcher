import { invoke } from '@tauri-apps/api/core';
import { createContext, useState, useCallback, useEffect, ReactNode, useContext, useRef } from 'react';
import i18n from '../i18n';
import { DataUnitSystem } from '../utils/formatBytes';
import { listenConfigStoreChanged, readConfigRecord } from '../utils/configStore';

export interface Settings {
    language: string;
    theme: 'light' | 'dark' | 'system';
    dataUnitSystem: DataUnitSystem;
    notifications: boolean;
    stateLocation: string;
    stateLocationBookmark?: string | null;
    maxLogLines: number;
    closeAction: 'quit' | 'background';
    isRegistered: boolean;
    launchAtLogin: boolean;
    mcpEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
    language: 'en',
    theme: 'system',
    dataUnitSystem: 'binary',
    notifications: true,
    stateLocation: '',
    stateLocationBookmark: null,
    maxLogLines: 10000,
    closeAction: 'quit',
    isRegistered: false,
    launchAtLogin: false,
    mcpEnabled: false,
};

const STORAGE_KEY = 'syncwatcher_settings';

interface SettingsContextType {
    settings: Settings;
    loaded: boolean;
    updateSettings: (updates: Partial<Settings>) => void;
    setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
    resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

function normalizeSettings(candidate: Partial<Settings> | null | undefined): Settings {
    return {
        ...DEFAULT_SETTINGS,
        ...candidate,
    };
}

function readCachedSettings(): Settings | null {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
            return null;
        }

        const parsed = JSON.parse(stored) as Partial<Settings>;
        return normalizeSettings(parsed);
    } catch (err) {
        console.error('Failed to load settings cache:', err);
        return null;
    }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [loaded, setLoaded] = useState(false);
    const settingsRef = useRef(settings);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    useEffect(() => {
        if (!loaded) {
            return;
        }

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (err) {
            console.error('Failed to save settings cache:', err);
        }
    }, [loaded, settings]);

    const loadSettings = useCallback(async () => {
        try {
            const stored = await invoke<unknown>('get_settings');
            const nextSettings = normalizeSettings(readConfigRecord<Settings>(stored, ['settings']));
            setSettings(nextSettings);
        } catch (err) {
            console.error('Failed to load settings from backend:', err);
            const cachedSettings = readCachedSettings();
            setSettings(cachedSettings ?? DEFAULT_SETTINGS);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void loadSettings();

        let disposed = false;
        const unlistenPromise = listenConfigStoreChanged(['settings'], () => {
            if (!disposed) {
                void loadSettings();
            }
        });

        return () => {
            disposed = true;
            void unlistenPromise
                .then((unlisten) => unlisten())
                .catch((error) => {
                    console.warn('Failed to unlisten config-store-changed for settings', error);
                });
        };
    }, [loadSettings]);

    const updateSettings = useCallback((updates: Partial<Settings>) => {
        const previousSettings = settingsRef.current;
        const nextSettings = normalizeSettings({
            ...previousSettings,
            ...updates,
        });

        settingsRef.current = nextSettings;
        setSettings(nextSettings);

        const {
            isRegistered: _ignoredIsRegistered,
            launchAtLogin: _ignoredLaunchAtLogin,
            ...persistedUpdates
        } = updates;

        if (Object.keys(persistedUpdates).length === 0) {
            return;
        }

        void invoke('update_settings', { updates: persistedUpdates })
            .then((response) => {
                const persistedSettings = readConfigRecord<Settings>(response, ['settings']);
                if (persistedSettings) {
                    const normalized = normalizeSettings(persistedSettings);
                    settingsRef.current = normalized;
                    setSettings(normalized);
                }
            })
            .catch((err) => {
                console.error('Failed to update settings:', err);
                settingsRef.current = previousSettings;
                setSettings(previousSettings);
            });
    }, []);

    const setLaunchAtLogin = useCallback(async (enabled: boolean) => {
        const previousSettings = settingsRef.current;
        const nextSettings = normalizeSettings({
            ...previousSettings,
            launchAtLogin: enabled,
        });

        settingsRef.current = nextSettings;
        setSettings(nextSettings);

        try {
            const response = await invoke<unknown>('set_launch_at_login', { enabled });
            const persistedSettings = readConfigRecord<Settings>(response, ['settings']);
            if (persistedSettings) {
                const normalized = normalizeSettings(persistedSettings);
                settingsRef.current = normalized;
                setSettings(normalized);
            }
            return true;
        } catch (err) {
            console.error('Failed to update launch-at-login setting:', err);
            settingsRef.current = previousSettings;
            setSettings(previousSettings);
            return false;
        }
    }, []);

    const resetSettings = useCallback(() => {
        const previousSettings = settingsRef.current;
        settingsRef.current = DEFAULT_SETTINGS;
        setSettings(DEFAULT_SETTINGS);

        void invoke('reset_settings')
            .then((response) => {
                const persistedSettings = readConfigRecord<Settings>(response, ['settings']);
                if (persistedSettings) {
                    const normalized = normalizeSettings(persistedSettings);
                    settingsRef.current = normalized;
                    setSettings(normalized);
                }
            })
            .catch((err) => {
                console.error('Failed to reset settings:', err);
                settingsRef.current = previousSettings;
                setSettings(previousSettings);
            });
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
        <SettingsContext.Provider value={{ settings, loaded, updateSettings, setLaunchAtLogin, resetSettings }}>
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
