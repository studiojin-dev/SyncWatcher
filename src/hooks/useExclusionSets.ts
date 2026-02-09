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
        patterns: ['.DS_Store', 'Thumbs.db', '.Trash', 'Desktop.ini']
    },
    {
        id: 'nodejs',
        name: 'Node.js',
        patterns: ['node_modules', 'dist', 'build', '.npm', 'coverage']
    },
    {
        id: 'python',
        name: 'Python',
        patterns: ['__pycache__', '*.pyc', '.venv', 'venv', '.env']
    },
    {
        id: 'git',
        name: 'Git',
        patterns: ['.git', '.gitignore']
    },
    {
        id: 'rust',
        name: 'Rust (Tauri)',
        patterns: ['src-tauri/target', '**/src-tauri/target', 'Cargo.lock', '**/*.rs.bk']
    }
];

const LEGACY_STORAGE_KEY = 'exclusion_sets';
const EXCLUSION_SETS_FILE_NAME = 'exclusion_sets.yaml';

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

    const didMigrateLegacyStorage = useRef(false);

    useEffect(() => {
        if (!loaded || didMigrateLegacyStorage.current) {
            return;
        }

        didMigrateLegacyStorage.current = true;

        try {
            const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (!legacyRaw) {
                return;
            }

            const parsed = JSON.parse(legacyRaw);
            if (!Array.isArray(parsed)) {
                return;
            }

            const migratedSets = parsed
                .map(sanitizeSet)
                .filter((set): set is ExclusionSet => set !== null);

            if (migratedSets.length === 0) {
                return;
            }

            // Only apply migration when current file still has defaults.
            const currentIsDefault = JSON.stringify(sets) === JSON.stringify(DEFAULT_SETS);
            if (!currentIsDefault) {
                return;
            }

            void saveSets(migratedSets);
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            console.info('Migrated legacy exclusion sets from localStorage to YAML');
        } catch (err) {
            console.error('Failed to migrate legacy exclusion sets:', err);
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
