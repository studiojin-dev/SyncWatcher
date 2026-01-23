import { useState } from 'react';
import { IconPlus, IconTrash, IconEdit, IconX, IconCheck } from '@tabler/icons-react';
import { useExclusionSets, ExclusionSet } from '../../hooks/useExclusionSets';


export function ExclusionSetsManager() {
    const { sets, addSet, updateSet, deleteSet } = useExclusionSets();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    // Form state
    const [name, setName] = useState('');
    const [patterns, setPatterns] = useState('');

    const startCreating = () => {
        setIsCreating(true);
        setEditingId(null);
        setName('');
        setPatterns('');
    };

    const startEditing = (set: ExclusionSet) => {
        setEditingId(set.id);
        setIsCreating(false);
        setName(set.name);
        setPatterns(set.patterns.join('\n'));
    };

    const cancel = () => {
        setIsCreating(false);
        setEditingId(null);
        setName('');
        setPatterns('');
    };

    const save = () => {
        const patternList = patterns.split('\n').map(p => p.trim()).filter(p => p.length > 0);

        if (isCreating) {
            addSet(name, patternList);
        } else if (editingId) {
            updateSet(editingId, { name, patterns: patternList });
        }
        cancel();
    };

    return (
        <section>
            <h2 className="text-lg font-bold uppercase mb-4 pl-2 border-l-4 border-[var(--accent-main)]">
                Exclusion Sets
            </h2>
            <div className="neo-box p-6 space-y-6">
                <div className="space-y-4">
                    {sets.map(set => (
                        <div key={set.id} className="border-2 border-[var(--border-main)] p-4 bg-[var(--bg-primary)]">
                            {editingId === set.id ? (
                                <div className="space-y-3">
                                    <input
                                        className="neo-input w-full"
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        placeholder="Set Name"
                                    />
                                    <textarea
                                        className="neo-input w-full font-mono text-sm h-24"
                                        value={patterns}
                                        onChange={e => setPatterns(e.target.value)}
                                        placeholder="*.log&#10;node_modules&#10;.DS_Store"
                                    />
                                    <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] p-2 border border-[var(--border-main)] font-mono">
                                        <p className="font-bold mb-1">Pattern Syntax:</p>
                                        <ul className="list-disc pl-4 space-y-0.5">
                                            <li>Use <code>*</code> for wildcards (e.g., <code>*.txt</code>)</li>
                                            <li>Use <code>**</code> for nested directories (e.g., <code>node_modules/**</code>)</li>
                                            <li>One pattern per line</li>
                                            <li>Max 100 patterns, 255 chars each</li>
                                        </ul>
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <button onClick={cancel} className="p-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]">
                                            <IconX size={18} />
                                        </button>
                                        <button onClick={save} className="p-2 border-2 border-[var(--border-main)] bg-[var(--accent-main)] text-white">
                                            <IconCheck size={18} />
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div>
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-bold uppercase">{set.name}</h3>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => startEditing(set)}
                                                className="p-1 hover:text-[var(--accent-main)]"
                                                title="Edit"
                                            >
                                                <IconEdit size={18} />
                                            </button>
                                            <button
                                                onClick={() => deleteSet(set.id)}
                                                className="p-1 hover:text-[var(--color-accent-error)]"
                                                title="Delete"
                                            >
                                                <IconTrash size={18} />
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {set.patterns.map((p, i) => (
                                            <span key={i} className="text-xs font-mono bg-[var(--bg-secondary)] px-1 border border-[var(--border-main)]">
                                                {p}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {isCreating ? (
                    <div className="border-2 border-[var(--border-main)] p-4 bg-[var(--bg-secondary)]">
                        <div className="space-y-3">
                            <input
                                className="neo-input w-full"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="New Set Name"
                                autoFocus
                            />
                            <textarea
                                className="neo-input w-full font-mono text-sm h-24"
                                value={patterns}
                                onChange={e => setPatterns(e.target.value)}
                                placeholder="*.tmp&#10;.git"
                            />
                            <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-primary)] p-2 border border-[var(--border-main)] font-mono">
                                <p className="font-bold mb-1">Pattern Syntax:</p>
                                <ul className="list-disc pl-4 space-y-0.5">
                                    <li>Use <code>*</code> for wildcards (e.g., <code>*.txt</code>)</li>
                                    <li>Use <code>**</code> for nested directories (e.g., <code>node_modules/**</code>)</li>
                                    <li>One pattern per line</li>
                                    <li>Max 100 patterns, 255 chars each</li>
                                </ul>
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={cancel} className="px-4 py-2 border-2 border-[var(--border-main)] font-bold uppercase">
                                    Cancel
                                </button>
                                <button onClick={save} className="px-4 py-2 border-2 border-[var(--border-main)] bg-[var(--accent-main)] text-white font-bold uppercase shadow-[2px_2px_0_0_black]">
                                    Save
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <button
                        onClick={startCreating}
                        className="w-full py-2 border-2 border-dashed border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] flex justify-center items-center gap-2 font-bold uppercase"
                    >
                        <IconPlus size={20} />
                        Add Exclusion Set
                    </button>
                )}
            </div>
        </section>
    );
}
