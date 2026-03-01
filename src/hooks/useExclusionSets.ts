import { useCallback, useEffect, useRef } from 'react';
import { useYamlStore } from './useYamlStore';

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

const LEGACY_STORAGE_KEY = 'exclusion_sets';
export const EXCLUSION_SETS_DEFAULTS_VERSION_KEY = 'exclusion_sets_defaults_version';
export const EXCLUSION_SETS_DEFAULTS_VERSION = 2;
const EXCLUSION_SETS_FILE_NAME = 'exclusion_sets.yaml';

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

function sanitizeSet(raw: unknown): ExclusionSet | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const candidate = raw as Partial<ExclusionSet>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !Array.isArray(candidate.patterns)) {
        return null;
    }

    const patterns = candidate.patterns.filter((pattern): pattern is string => typeof pattern === 'string');
    return {
        id: candidate.id,
        name: candidate.name,
        patterns,
    };
}

export function useExclusionSets() {
    const {
        data: sets,
        saveData: saveSets,
        loaded,
        error,
        reload,
    } = useYamlStore<ExclusionSet[]>({
        fileName: EXCLUSION_SETS_FILE_NAME,
        defaultData: DEFAULT_SETS,
    });

    const didRunStartupMigrations = useRef(false);

    useEffect(() => {
        if (!loaded || didRunStartupMigrations.current) {
            return;
        }

        didRunStartupMigrations.current = true;

        try {
            let nextSets = sets;
            let shouldSave = false;
            let shouldRemoveLegacyStorage = false;

            const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacyRaw) {
                const parsed = JSON.parse(legacyRaw);
                if (Array.isArray(parsed)) {
                    const migratedSets = parsed
                        .map(sanitizeSet)
                        .filter((set): set is ExclusionSet => set !== null);

                    // Only apply migration when current file still has defaults.
                    const currentIsDefault = JSON.stringify(sets) === JSON.stringify(DEFAULT_SETS);
                    if (currentIsDefault && migratedSets.length > 0) {
                        nextSets = migratedSets;
                        shouldSave = true;
                        shouldRemoveLegacyStorage = true;
                        console.info('Migrated legacy exclusion sets from localStorage to YAML');
                    }
                }
            }

            const storedDefaultsVersionRaw = localStorage.getItem(EXCLUSION_SETS_DEFAULTS_VERSION_KEY);
            const storedDefaultsVersion = Number.parseInt(storedDefaultsVersionRaw ?? '0', 10);
            const shouldMigrateDefaults =
                Number.isNaN(storedDefaultsVersion) || storedDefaultsVersion < EXCLUSION_SETS_DEFAULTS_VERSION;

            if (shouldMigrateDefaults) {
                const mergedSets = mergeMissingDefaultSets(nextSets);
                if (mergedSets.length !== nextSets.length) {
                    nextSets = mergedSets;
                    shouldSave = true;
                    console.info('Merged missing default exclusion sets');
                }

                if (shouldSave) {
                    void saveSets(nextSets)
                        .then(() => {
                            if (shouldRemoveLegacyStorage) {
                                localStorage.removeItem(LEGACY_STORAGE_KEY);
                            }
                            localStorage.setItem(
                                EXCLUSION_SETS_DEFAULTS_VERSION_KEY,
                                String(EXCLUSION_SETS_DEFAULTS_VERSION)
                            );
                        })
                        .catch((err) => {
                            console.error('Failed to migrate exclusion set defaults:', err);
                        });
                } else {
                    localStorage.setItem(EXCLUSION_SETS_DEFAULTS_VERSION_KEY, String(EXCLUSION_SETS_DEFAULTS_VERSION));
                }
                return;
            }

            if (shouldSave && nextSets !== sets) {
                void saveSets(nextSets)
                    .then(() => {
                        if (shouldRemoveLegacyStorage) {
                            localStorage.removeItem(LEGACY_STORAGE_KEY);
                        }
                    })
                    .catch((err) => {
                        console.error('Failed to run exclusion set startup migrations:', err);
                    });
            }
        } catch (err) {
            console.error('Failed to run exclusion set startup migrations:', err);
        }
    }, [loaded, sets, saveSets]);

    const addSet = (name: string, patterns: string[]) => {
        const newSet: ExclusionSet = {
            id: crypto.randomUUID(),
            name,
            patterns
        };
        void saveSets([...sets, newSet]);
    };

    const updateSet = (id: string, updates: Partial<Omit<ExclusionSet, 'id'>>) => {
        const nextSets = sets.map((set) => (set.id === id ? { ...set, ...updates } : set));
        void saveSets(nextSets);
    };

    const deleteSet = (id: string) => {
        void saveSets(sets.filter((set) => set.id !== id));
    };

    const resetSets = () => {
        void saveSets(DEFAULT_SETS);
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
        reload,
    };
}
