import { useState, useEffect } from 'react';

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
    }
];

export function useExclusionSets() {
    const [sets, setSets] = useState<ExclusionSet[]>([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        const load = () => {
            const stored = localStorage.getItem('exclusion_sets');
            if (stored) {
                try {
                    setSets(JSON.parse(stored));
                } catch (e) {
                    console.error("Failed to parse exclusion sets", e);
                    setSets(DEFAULT_SETS);
                }
            } else {
                setSets(DEFAULT_SETS);
            }
            setLoaded(true);
        };
        load();
    }, []);

    useEffect(() => {
        if (loaded) {
            localStorage.setItem('exclusion_sets', JSON.stringify(sets));
        }
    }, [sets, loaded]);

    const addSet = (name: string, patterns: string[]) => {
        const newSet: ExclusionSet = {
            id: crypto.randomUUID(),
            name,
            patterns
        };
        setSets(prev => [...prev, newSet]);
    };

    const updateSet = (id: string, updates: Partial<Omit<ExclusionSet, 'id'>>) => {
        setSets(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
    };

    const deleteSet = (id: string) => {
        setSets(prev => prev.filter(s => s.id !== id));
    };

    const resetSets = () => {
        setSets(DEFAULT_SETS);
    };

    const getPatternsForSets = (setIds: string[]): string[] => {
        return sets
            .filter(s => setIds.includes(s.id))
            .flatMap(s => s.patterns);
    };

    return {
        sets,
        loaded,
        addSet,
        updateSet,
        deleteSet,
        resetSets,
        getPatternsForSets
    };
}
