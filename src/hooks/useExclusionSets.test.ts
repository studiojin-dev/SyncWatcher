import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useYamlStore } from './useYamlStore';
import {
  EXCLUSION_SETS_DEFAULTS_VERSION,
  EXCLUSION_SETS_DEFAULTS_VERSION_KEY,
  ExclusionSet,
  useExclusionSets,
} from './useExclusionSets';

vi.mock('./useYamlStore', () => ({
  useYamlStore: vi.fn(),
}));

const mockUseYamlStore = vi.mocked(useYamlStore);
const mockUseYamlStoreFn = mockUseYamlStore as unknown as ReturnType<typeof vi.fn>;

function makeSet(id: string, patterns: string[]): ExclusionSet {
  return {
    id,
    name: id,
    patterns,
  };
}

function mockYamlStore({
  sets,
  saveData,
  loaded = true,
}: {
  sets: ExclusionSet[];
  saveData: (nextSets: ExclusionSet[]) => Promise<void>;
  loaded?: boolean;
}) {
  mockUseYamlStoreFn.mockReturnValue({
    data: sets,
    saveData,
    loaded,
    setData: vi.fn(),
    error: null,
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useYamlStore<Record<string, unknown>>>);
}

describe('useExclusionSets defaults migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('appends only missing default sets and preserves existing customized sets', async () => {
    const saveData = vi.fn<(nextSets: ExclusionSet[]) => Promise<void>>().mockResolvedValue(undefined);
    const existing = [
      makeSet('system-defaults', ['.DS_Store']),
      makeSet('nodejs', ['custom-node-cache']),
      makeSet('python', ['custom-python-cache']),
      makeSet('git', ['.git']),
      makeSet('rust', ['target']),
    ];
    mockYamlStore({ sets: existing, saveData });

    renderHook(() => useExclusionSets());

    await waitFor(() => {
      expect(saveData).toHaveBeenCalledTimes(1);
    });

    const mergedSets = saveData.mock.calls[0][0];
    const nodeSet = mergedSets.find((set) => set.id === 'nodejs');
    expect(nodeSet?.patterns).toEqual(['custom-node-cache']);

    expect(mergedSets.some((set) => set.id === 'jvm-build')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'dotnet')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'ruby-rails')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'php-laravel')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'dart-flutter')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'swift-xcode')).toBe(true);
    expect(mergedSets.some((set) => set.id === 'infra-terraform')).toBe(true);

    await waitFor(() => {
      expect(localStorage.getItem(EXCLUSION_SETS_DEFAULTS_VERSION_KEY)).toBe(
        String(EXCLUSION_SETS_DEFAULTS_VERSION)
      );
    });
  });

  it('records defaults version without saving when no set is missing', async () => {
    const saveData = vi.fn<(nextSets: ExclusionSet[]) => Promise<void>>().mockResolvedValue(undefined);
    const allSets = [
      makeSet('system-defaults', ['.DS_Store']),
      makeSet('nodejs', ['node_modules']),
      makeSet('python', ['__pycache__']),
      makeSet('git', ['.git']),
      makeSet('rust', ['target']),
      makeSet('jvm-build', ['.gradle']),
      makeSet('dotnet', ['bin']),
      makeSet('ruby-rails', ['tmp']),
      makeSet('php-laravel', ['vendor']),
      makeSet('dart-flutter', ['.dart_tool']),
      makeSet('swift-xcode', ['DerivedData']),
      makeSet('infra-terraform', ['.terraform']),
    ];
    mockYamlStore({ sets: allSets, saveData });

    renderHook(() => useExclusionSets());

    await waitFor(() => {
      expect(localStorage.getItem(EXCLUSION_SETS_DEFAULTS_VERSION_KEY)).toBe(
        String(EXCLUSION_SETS_DEFAULTS_VERSION)
      );
    });
    expect(saveData).not.toHaveBeenCalled();
  });

  it('does not run defaults merge again after version has already been recorded', async () => {
    localStorage.setItem(
      EXCLUSION_SETS_DEFAULTS_VERSION_KEY,
      String(EXCLUSION_SETS_DEFAULTS_VERSION)
    );

    const saveData = vi.fn<(nextSets: ExclusionSet[]) => Promise<void>>().mockResolvedValue(undefined);
    const existing = [
      makeSet('system-defaults', ['.DS_Store']),
      makeSet('nodejs', ['custom-node-cache']),
      makeSet('python', ['custom-python-cache']),
      makeSet('git', ['.git']),
      makeSet('rust', ['target']),
    ];
    mockYamlStore({ sets: existing, saveData });

    renderHook(() => useExclusionSets());

    await waitFor(() => {
      expect(localStorage.getItem(EXCLUSION_SETS_DEFAULTS_VERSION_KEY)).toBe(
        String(EXCLUSION_SETS_DEFAULTS_VERSION)
      );
    });
    expect(saveData).not.toHaveBeenCalled();
  });

  it('keeps legacy storage when migration save fails', async () => {
    const legacySets = [makeSet('legacy', ['legacy-pattern'])];
    localStorage.setItem('exclusion_sets', JSON.stringify(legacySets));

    const saveData = vi
      .fn<(nextSets: ExclusionSet[]) => Promise<void>>()
      .mockRejectedValue(new Error('disk full'));
    const defaultsOnly = [
      makeSet('system-defaults', ['.DS_Store']),
      makeSet('nodejs', ['node_modules']),
      makeSet('python', ['__pycache__']),
      makeSet('git', ['.git']),
      makeSet('rust', ['target']),
    ];
    mockYamlStore({ sets: defaultsOnly, saveData });

    renderHook(() => useExclusionSets());

    await waitFor(() => {
      expect(saveData).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem('exclusion_sets')).toBe(JSON.stringify(legacySets));
  });
});
