import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettings } from './useSettings';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
});

// Mock document methods that useSettings uses
vi.spyOn(document.documentElement, 'setAttribute').mockImplementation(() => {});
vi.spyOn(document.documentElement, 'removeAttribute').mockImplementation(() => {});
vi.spyOn(document.documentElement.classList, 'add').mockImplementation(() => {});
vi.spyOn(document.documentElement.classList, 'remove').mockImplementation(() => {});

describe('useSettings', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('should load default settings on mount', () => {
    const { result } = renderHook(() => useSettings());

    expect(result.current.settings).toEqual({
      language: 'en',
      theme: 'system',
      notifications: true,
      deleteConfirmation: true,
      verifyAfterCopy: true,
      stateLocation: '',
      maxLogLines: 10000,
    });
  });

  it('should load settings from localStorage on mount', async () => {
    const savedSettings = {
      language: 'ko',
      theme: 'dark' as const,
      notifications: false,
      deleteConfirmation: false,
      verifyAfterCopy: false,
      stateLocation: '/custom/path',
      maxLogLines: 5000,
    };

    localStorageMock.setItem('syncwatcher_settings', JSON.stringify(savedSettings));

    const { result } = renderHook(() => useSettings());

    await waitFor(() => {
      expect(result.current.settings.language).toBe('ko');
      expect(result.current.settings.theme).toBe('dark');
      expect(result.current.settings.notifications).toBe(false);
    });
  });

  it('should save settings to localStorage when updateSettings is called', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ language: 'es' });
    });

    const saved = localStorageMock.getItem('syncwatcher_settings');
    const parsed = JSON.parse(saved!);

    expect(parsed.language).toBe('es');
  });

  it('should merge updates with existing settings', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ language: 'fr' });
    });

    expect(result.current.settings.language).toBe('fr');
    // Other settings should remain
    expect(result.current.settings.theme).toBe('system');
    expect(result.current.settings.notifications).toBe(true);
  });

  it('should reset to default settings when resetSettings is called', () => {
    const { result } = renderHook(() => useSettings());

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

  it('should apply dark theme when theme is "dark"', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ theme: 'dark' });
    });

    expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    expect(document.documentElement.classList.add).toHaveBeenCalledWith('dark');
  });

  it('should apply light theme when theme is "light"', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ theme: 'light' });
    });

    expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
  });

  it('should remove theme attributes when theme is "system"', () => {
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.updateSettings({ theme: 'system' });
    });

    expect(document.documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
    expect(document.documentElement.classList.remove).toHaveBeenCalledWith('dark');
  });

  it('should handle JSON parse errors gracefully', () => {
    // Store invalid JSON
    localStorageMock.setItem('syncwatcher_settings', 'invalid json');

    const { result } = renderHook(() => useSettings());

    // Should fall back to defaults
    expect(result.current.settings.language).toBe('en');
  });

  it('should handle localStorage errors gracefully', () => {
    const originalGetItem = localStorageMock.getItem;
    localStorageMock.getItem = vi.fn(() => {
      throw new Error('localStorage access denied');
    });

    const { result } = renderHook(() => useSettings());

    // Should still work with defaults
    expect(result.current.settings.language).toBe('en');

    localStorageMock.getItem = originalGetItem;
  });

  it('should not cause infinite loop with useCallback dependencies', () => {
    const { result } = renderHook(() => useSettings());

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
    const { result } = renderHook(() => useSettings());

    // After loading, loaded should be true
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
  });
});
