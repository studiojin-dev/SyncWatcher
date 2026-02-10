import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { SettingsProvider, useSettings } from '../context/SettingsContext';

// Mock i18n
vi.mock('../i18n', () => ({
  default: {
    changeLanguage: vi.fn(),
  },
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: vi.fn((key: string) => store[key] || null),
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

// Mock document methods that useSettings uses
vi.spyOn(document.documentElement, 'setAttribute').mockImplementation(() => { });
vi.spyOn(document.documentElement, 'removeAttribute').mockImplementation(() => { });
vi.spyOn(document.documentElement.classList, 'add').mockImplementation(() => { });
vi.spyOn(document.documentElement.classList, 'remove').mockImplementation(() => { });

// Wrapper component with SettingsProvider
const wrapper = ({ children }: { children: ReactNode }) => (
  <SettingsProvider>{ children } </SettingsProvider>
);

describe('useSettings', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  it('should load default settings on mount', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.settings).toEqual({
      language: 'en',
      theme: 'system',
      notifications: true,
      stateLocation: '',
      maxLogLines: 10000,
      closeAction: 'quit',
    });
  });

  it('should load settings from localStorage on mount', async () => {
    const savedSettings = {
      language: 'ko',
      theme: 'dark' as const,
      notifications: false,
      stateLocation: '/custom/path',
      maxLogLines: 5000,
    };

    localStorageMock.setItem('syncwatcher_settings', JSON.stringify(savedSettings));

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.settings.language).toBe('ko');
    expect(result.current.settings.theme).toBe('dark');
    expect(result.current.settings.notifications).toBe(false);
  });

  it('should save settings to localStorage when updateSettings is called', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    act(() => {
      result.current.updateSettings({ language: 'es' });
    });

    expect(localStorageMock.setItem).toHaveBeenCalled();
    const calls = localStorageMock.setItem.mock.calls;
    const lastCall = calls[calls.length - 1];
    const parsed = JSON.parse(lastCall![1]);

    expect(parsed.language).toBe('es');
  });

  it('should merge updates with existing settings', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    act(() => {
      result.current.updateSettings({ language: 'fr' });
    });

    expect(result.current.settings.language).toBe('fr');
    // Other settings should remain
    expect(result.current.settings.theme).toBe('system');
    expect(result.current.settings.notifications).toBe(true);
  });

  it('should reset to default settings when resetSettings is called', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    // First change some settings
    act(() => {
      result.current.updateSettings({ language: 'ja' });
    });

    expect(result.current.settings.language).toBe('ja');

    // Reset
    act(() => {
      result.current.resetSettings();
    });

    expect(result.current.settings.language).toBe('en');
  });

  it('should apply dark theme when theme is "dark"', async () => {
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

  it('should apply light theme when theme is "light"', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    act(() => {
      result.current.updateSettings({ theme: 'light' });
    });

    expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
  });

  it('should remove theme attributes when theme is "system"', async () => {
    // First set a non-system theme
    const savedSettings = {
      theme: 'dark' as const,
    };
    localStorageMock.setItem('syncwatcher_settings', JSON.stringify(savedSettings));

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

  it('should handle JSON parse errors gracefully', async () => {
    // Store invalid JSON
    localStorageMock.setItem('syncwatcher_settings', 'invalid json');
    localStorageMock.getItem.mockReturnValueOnce('invalid json');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    // Should fall back to defaults
    expect(result.current.settings.language).toBe('en');
    consoleErrorSpy.mockRestore();
  });

  it('should handle localStorage errors gracefully', async () => {
    localStorageMock.getItem.mockImplementationOnce(() => {
      throw new Error('localStorage access denied');
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    // Should still work with defaults
    expect(result.current.settings.language).toBe('en');
    consoleErrorSpy.mockRestore();
  });

  it('should not cause infinite loop with useCallback dependencies', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    // Call updateSettings multiple times
    act(() => {
      result.current.updateSettings({ language: 'de' });
      result.current.updateSettings({ notifications: false });
    });

    // Should not cause infinite loop
    expect(result.current.settings.language).toBe('de');
    expect(result.current.settings.notifications).toBe(false);
  });

  it('should return loaded state after loading', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });

    // After loading, loaded should be true
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
  });
});
