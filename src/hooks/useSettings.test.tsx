import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DEFAULT_SETTINGS, SettingsProvider, useSettings } from '../context/SettingsContext';

vi.mock('../i18n', () => ({
    default: {
        changeLanguage: vi.fn(),
    },
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

const localStorageMock = (() => {
    let store: Record<string, string> = {};

    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
            store[key] = value.toString();
        }),
        removeItem: vi.fn((key: string) => {
            delete store[key];
        }),
        clear: () => {
            store = {};
        },
    };
})();

Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
});

vi.spyOn(document.documentElement, 'setAttribute').mockImplementation(() => {});
vi.spyOn(document.documentElement, 'removeAttribute').mockImplementation(() => {});
vi.spyOn(document.documentElement.classList, 'add').mockImplementation(() => {});
vi.spyOn(document.documentElement.classList, 'remove').mockImplementation(() => {});

const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsProvider>{children}</SettingsProvider>
);

describe('useSettings', () => {
    beforeEach(() => {
        localStorageMock.clear();
        vi.clearAllMocks();
        eventHandlers.clear();
        mockListen.mockImplementation(async (eventName: string, handler: (event: { payload?: unknown }) => void) => {
            eventHandlers.set(eventName, handler);
            return () => {
                eventHandlers.delete(eventName);
            };
        });
        mockInvoke.mockImplementation(async (command: string) => {
            if (command === 'get_settings') {
                return {};
            }

            return undefined;
        });
    });

    afterEach(() => {
        localStorageMock.clear();
    });

    it('loads default settings from the backend on mount', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(mockInvoke).toHaveBeenCalledWith('get_settings');
        expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    });

    it('falls back to cached settings when backend loading fails', async () => {
        localStorageMock.setItem('syncwatcher_settings', JSON.stringify({
            language: 'ko',
            theme: 'dark',
            notifications: false,
            mcpEnabled: true,
        }));
        mockInvoke.mockRejectedValueOnce(new Error('backend unavailable'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(result.current.settings.language).toBe('ko');
        expect(result.current.settings.theme).toBe('dark');
        expect(result.current.settings.notifications).toBe(false);
        expect(result.current.settings.mcpEnabled).toBe(true);
        consoleErrorSpy.mockRestore();
    });

    it('persists optimistic updates to backend and boot cache', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        act(() => {
            result.current.updateSettings({ language: 'es', mcpEnabled: true });
        });

        expect(result.current.settings.language).toBe('es');
        expect(result.current.settings.mcpEnabled).toBe(true);

        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('update_settings', {
                updates: {
                    language: 'es',
                    mcpEnabled: true,
                },
            });
        });

        const lastCallIndex = localStorageMock.setItem.mock.calls.length - 1;
        const cachedSettings = JSON.parse(localStorageMock.setItem.mock.calls[lastCallIndex]?.[1] ?? '{}');
        expect(cachedSettings.language).toBe('es');
        expect(cachedSettings.mcpEnabled).toBe(true);
    });

    it('resets settings through the backend command', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        act(() => {
            result.current.updateSettings({ language: 'ja', mcpEnabled: true });
        });
        expect(result.current.settings.language).toBe('ja');

        act(() => {
            result.current.resetSettings();
        });

        expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
        await waitFor(() => {
            expect(mockInvoke).toHaveBeenCalledWith('reset_settings');
        });
    });

    it('reloads settings when config-store-changed is emitted', async () => {
        mockInvoke
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                settings: {
                    language: 'de',
                    notifications: false,
                    mcpEnabled: true,
                },
            });

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        const handler = eventHandlers.get('config-store-changed');
        if (!handler) {
            throw new Error('config-store-changed handler not found');
        }

        act(() => {
            handler({ payload: { scope: 'settings' } });
        });

        await waitFor(() => {
            expect(result.current.settings.language).toBe('de');
        });
        expect(result.current.settings.notifications).toBe(false);
        expect(result.current.settings.mcpEnabled).toBe(true);
    });

    it('applies dark theme when the theme is updated', async () => {
        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        act(() => {
            result.current.updateSettings({ theme: 'dark' });
        });

        expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
        expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
    });

    it('removes explicit theme attributes when theme is set to system', async () => {
        mockInvoke.mockResolvedValueOnce({
            settings: {
                theme: 'dark',
            },
        });

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        vi.clearAllMocks();

        act(() => {
            result.current.updateSettings({ theme: 'system' });
        });

        expect(document.documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
        expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
    });

    it('falls back to defaults when cached settings are invalid and backend loading fails', async () => {
        localStorageMock.getItem.mockReturnValueOnce('invalid json');
        mockInvoke.mockRejectedValueOnce(new Error('backend unavailable'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { result } = renderHook(() => useSettings(), { wrapper });

        await waitFor(() => {
            expect(result.current.loaded).toBe(true);
        });

        expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });
});
