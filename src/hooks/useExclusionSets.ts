import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { YamlStoreError } from './useYamlStore';
import { listenConfigStoreChanged, parseConfigError, readConfigCollection, readConfigRecord } from '../utils/configStore';

export interface ExclusionSet {
    id: string;
    name: string;
    patterns: string[];
}

const DEFAULT_SETS: ExclusionSet[] = [
    {
        id: 'system-defaults',
        name: 'System Junk',
        patterns: [
            '.DS_Store',
            'Thumbs.db',
            '.Trash',
            'Desktop.ini',
            '.fseventsd',
            '.Spotlight-V100',
            '.Trashes',
            '.TemporaryItems'
        ]
    },
    {
        id: 'nodejs',
        name: 'Node.js',
        patterns: [
            'node_modules',
            '.pnpm',
            '.pnpm-store',
            '.npm',
            '.yarn/cache',
            '.yarn/unplugged',
            '.pnp',
            '.pnp.js',
            'jspm_packages',
            'web_modules',
            '.next',
            'out',
            '.nuxt',
            '.output',
            '.svelte-kit',
            '.angular',
            '.vite',
            '.parcel-cache',
            '.cache',
            '.docusaurus',
            '.turbo',
            '.nx',
            '.temp',
            '.tmp',
            'dist',
            'build',
            'coverage',
            '.serverless',
            '.firebase',
            '.vercel'
        ]
    },
    {
        id: 'python',
        name: 'Python',
        patterns: [
            '__pycache__',
            '*.pyc',
            '.venv',
            'venv',
            'env',
            'ENV',
            '.tox',
            '.nox',
            '.pytest_cache',
            '.mypy_cache',
            '.ruff_cache',
            '.hypothesis',
            '.pyre',
            '.pytype',
            '__pypackages__',
            '.pdm-build',
            '.pdm-python',
            '.pixi',
            '.ipynb_checkpoints',
            'htmlcov',
            '.eggs',
            '*.egg-info',
            'build',
            'dist',
            '.pybuilder',
            'cython_debug',
            'instance',
            '.scrapy'
        ]
    },
    {
        id: 'git',
        name: 'Git',
        patterns: ['.git', '.gitignore']
    },
    {
        id: 'rust',
        name: 'Rust (Tauri)',
        patterns: [
            'src-tauri/target',
            '**/src-tauri/target',
            'target',
            'debug',
            'Cargo.lock',
            '**/*.rs.bk',
            '**/mutants.out*'
        ]
    },
    {
        id: 'jvm-build',
        name: 'JVM (Java/Kotlin/Gradle)',
        patterns: ['.gradle', '.kotlin', 'build', 'out', 'target', '.gradletasknamecache', '.mtj.tmp']
    },
    {
        id: 'dotnet',
        name: '.NET',
        patterns: ['bin', 'obj', 'Debug', 'Release', 'artifacts', 'TestResults', 'CodeCoverage', 'Logs']
    },
    {
        id: 'ruby-rails',
        name: 'Ruby/Rails',
        patterns: [
            '.bundle',
            'vendor/bundle',
            'tmp',
            'log',
            'coverage',
            '.yardoc',
            '_yardoc',
            'public/packs',
            'public/packs-test',
            'public/assets'
        ]
    },
    {
        id: 'php-laravel',
        name: 'PHP/Laravel',
        patterns: ['vendor', 'bootstrap/cache', 'storage', 'public/storage', 'public/build', 'public/hot', '.vagrant']
    },
    {
        id: 'dart-flutter',
        name: 'Dart/Flutter',
        patterns: [
            '.dart_tool',
            '.pub',
            '.pub-preload-cache',
            '.flutter-plugins',
            '.flutter-plugins-dependencies',
            '.packages',
            '.packages.generated',
            'build',
            'coverage',
            '**/Flutter/ephemeral'
        ]
    },
    {
        id: 'swift-xcode',
        name: 'Swift/Xcode',
        patterns: ['DerivedData', '.build', 'Carthage/Build', 'Pods', 'xcuserdata']
    },
    {
        id: 'infra-terraform',
        name: 'Terraform',
        patterns: ['.terraform', '.terragrunt-cache']
    }
];

export const EXCLUSION_SETS_DEFAULTS_VERSION_KEY = 'exclusion_sets_defaults_version';
export const EXCLUSION_SETS_DEFAULTS_VERSION = 2;

export function mergeMissingDefaultSets(
    sets: ExclusionSet[],
    defaultSets: ExclusionSet[] = DEFAULT_SETS
): ExclusionSet[] {
    const existingIds = new Set(sets.map((set) => set.id));
    const missingDefaults = defaultSets.filter((set) => !existingIds.has(set.id));
    if (missingDefaults.length === 0) {
        return sets;
    }
    return [...sets, ...missingDefaults];
}

export function useExclusionSets() {
    const [sets, setSets] = useState<ExclusionSet[]>(DEFAULT_SETS);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<YamlStoreError | null>(null);
    const setsRef = useRef<ExclusionSet[]>(DEFAULT_SETS);

    useEffect(() => {
        setsRef.current = sets;
    }, [sets]);

    const loadSets = useCallback(async () => {
        try {
            const response = await invoke<unknown>('list_exclusion_sets');
            const responseError = readConfigRecord<YamlStoreError>(response, ['error']);
            if (responseError && responseError.type === 'PARSE_ERROR') {
                setSets(DEFAULT_SETS);
                setError(responseError as YamlStoreError);
                return;
            }

            const nextSets = readConfigCollection<ExclusionSet>(response, ['sets', 'exclusionSets']);
            setSets(nextSets.length > 0 ? nextSets : DEFAULT_SETS);
            setError(null);
        } catch (err) {
            const parsedError = parseConfigError(err);
            const nextError = readConfigRecord<YamlStoreError>(parsedError, ['error']);
            setSets(DEFAULT_SETS);
            setError(nextError && nextError.type === 'PARSE_ERROR' ? nextError as YamlStoreError : null);
            console.error('Failed to load exclusion sets:', err);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void loadSets();

        let disposed = false;
        const unlistenPromise = listenConfigStoreChanged(['exclusionSets'], () => {
            if (!disposed) {
                void loadSets();
            }
        });

        return () => {
            disposed = true;
            void unlistenPromise
                .then((unlisten) => unlisten())
                .catch((error) => {
                    console.warn('Failed to unlisten config-store-changed for exclusion sets', error);
                });
        };
    }, [loadSets]);

    const addSet = (name: string, patterns: string[]) => {
        const newSet: ExclusionSet = {
            id: crypto.randomUUID(),
            name,
            patterns
        };
        const nextSets = [...setsRef.current, newSet];
        setsRef.current = nextSets;
        setSets(nextSets);

        void invoke<unknown>('create_exclusion_set', { set: newSet })
            .then((response) => {
                const persistedSet = readConfigRecord<ExclusionSet>(response, ['set', 'exclusionSet']);
                if (persistedSet) {
                    const persistedSets = nextSets.map((candidate) =>
                        candidate.id === newSet.id ? persistedSet as ExclusionSet : candidate
                    );
                    setsRef.current = persistedSets;
                    setSets(persistedSets);
                }
                setError(null);
            })
            .catch((err) => {
                console.error('Failed to create exclusion set:', err);
                const revertedSets = setsRef.current.filter((candidate) => candidate.id !== newSet.id);
                setsRef.current = revertedSets;
                setSets(revertedSets);
            });
    };

    const updateSet = (id: string, updates: Partial<Omit<ExclusionSet, 'id'>>) => {
        const previousSets = setsRef.current;
        const nextSets = previousSets.map((set) => (set.id === id ? { ...set, ...updates } : set));
        setsRef.current = nextSets;
        setSets(nextSets);

        void invoke<unknown>('update_exclusion_set', { id, updates })
            .then((response) => {
                const persistedSet = readConfigRecord<ExclusionSet>(response, ['set', 'exclusionSet']);
                if (persistedSet) {
                    const persistedSets = nextSets.map((candidate) =>
                        candidate.id === id ? persistedSet as ExclusionSet : candidate
                    );
                    setsRef.current = persistedSets;
                    setSets(persistedSets);
                }
                setError(null);
            })
            .catch((err) => {
                console.error('Failed to update exclusion set:', err);
                setsRef.current = previousSets;
                setSets(previousSets);
            });
    };

    const deleteSet = (id: string) => {
        const previousSets = setsRef.current;
        const nextSets = previousSets.filter((set) => set.id !== id);
        setsRef.current = nextSets;
        setSets(nextSets);

        void invoke('delete_exclusion_set', { id })
            .then(() => {
                setError(null);
            })
            .catch((err) => {
                console.error('Failed to delete exclusion set:', err);
                setsRef.current = previousSets;
                setSets(previousSets);
            });
    };

    const resetSets = () => {
        setsRef.current = DEFAULT_SETS;
        setSets(DEFAULT_SETS);

        void invoke<unknown>('reset_exclusion_sets')
            .then((response) => {
                const nextSets = readConfigCollection<ExclusionSet>(response, ['sets', 'exclusionSets']);
                if (nextSets.length > 0) {
                    setsRef.current = nextSets;
                    setSets(nextSets);
                }
                setError(null);
            })
            .catch((err) => {
                console.error('Failed to reset exclusion sets:', err);
                void loadSets();
            });
    };

    const getPatternsForSets = useCallback((setIds: string[]): string[] => {
        return sets
            .filter(s => setIds.includes(s.id))
            .flatMap(s => s.patterns);
    }, [sets]);

    return {
        sets,
        loaded,
        addSet,
        updateSet,
        deleteSet,
        resetSets,
        getPatternsForSets,
        error,
        reload: loadSets,
    };
}
