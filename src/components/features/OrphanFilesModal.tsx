import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { IconFolder, IconFile, IconRefresh, IconSearch, IconTrash, IconArrowLeft } from '@tabler/icons-react';
import { CardAnimation } from '../ui/Animations';
import { useToast } from '../ui/Toast';

interface OrphanFile {
    path: string;
    size: number;
    is_dir: boolean;
}

interface DeleteOrphanResult {
    deleted_count: number;
    deleted_files_count: number;
    deleted_dirs_count: number;
    skipped_count: number;
    failures: Array<{ path: string; error: string }>;
}

interface TreeNode {
    name: string;
    fullPath: string;
    isDir: boolean;
    selectable: boolean;
    children: TreeNode[];
}

interface OrphanFilesModalProps {
    taskId: string;
    source: string;
    target: string;
    excludePatterns: string[];
    onBack: () => void;
}

function buildTree(files: OrphanFile[]): TreeNode[] {
    interface InternalNode extends TreeNode {
        childrenMap: Map<string, InternalNode>;
    }

    const root = new Map<string, InternalNode>();

    for (const file of files) {
        const parts = file.path.split('/').filter(Boolean);
        let current = root;
        let accum = '';

        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            accum = accum ? `${accum}/${part}` : part;
            const isLast = i === parts.length - 1;
            const existing = current.get(part);
            const node: InternalNode = existing ?? {
                name: part,
                fullPath: accum,
                isDir: !isLast || file.is_dir,
                selectable: false,
                children: [],
                childrenMap: new Map<string, InternalNode>(),
            };

            if (isLast) {
                node.isDir = file.is_dir;
                node.selectable = true;
            }

            if (!existing) {
                current.set(part, node);
            }

            current = node.childrenMap;
        }
    }

    const sortNodes = (nodes: InternalNode[]): TreeNode[] =>
        [...nodes]
            .sort((a, b) => {
                if (a.isDir !== b.isDir) {
                    return a.isDir ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            })
            .map((node) => {
                const { childrenMap, ...rest } = node;
                return {
                    ...rest,
                    children: sortNodes(Array.from(childrenMap.values())),
                };
            });

    return sortNodes(Array.from(root.values()));
}

function filterNodes(nodes: TreeNode[], keyword: string): TreeNode[] {
    if (!keyword) {
        return nodes;
    }
    const lower = keyword.toLowerCase();

    const visit = (node: TreeNode): TreeNode | null => {
        const matchedSelf = node.fullPath.toLowerCase().includes(lower);
        const children = node.children
            .map(visit)
            .filter((child): child is TreeNode => child !== null);

        if (matchedSelf || children.length > 0) {
            return {
                ...node,
                children,
            };
        }
        return null;
    };

    return nodes
        .map(visit)
        .filter((node): node is TreeNode => node !== null);
}

function buildSelectablePathMap(nodes: TreeNode[]): Map<string, string[]> {
    const map = new Map<string, string[]>();

    const walk = (node: TreeNode): string[] => {
        const own = node.selectable ? [node.fullPath] : [];
        const descendants = node.children.flatMap(walk);
        const all = [...own, ...descendants];
        map.set(node.fullPath, all);
        return all;
    };

    nodes.forEach(walk);
    return map;
}

function collectVisibleSelectablePaths(nodes: TreeNode[]): string[] {
    const paths: string[] = [];

    const visit = (node: TreeNode) => {
        if (node.selectable) {
            paths.push(node.fullPath);
        }
        node.children.forEach(visit);
    };

    nodes.forEach(visit);
    return paths;
}

function renderTree(
    nodes: TreeNode[],
    selected: Set<string>,
    toggleNode: (node: TreeNode) => void,
    selectablePathMap: Map<string, string[]>,
    depth = 0
): JSX.Element[] {
    const rows: JSX.Element[] = [];

    const isNodeChecked = (node: TreeNode): boolean => {
        const paths = selectablePathMap.get(node.fullPath) ?? [];
        if (paths.length === 0) {
            return false;
        }
        return paths.every((path) => selected.has(path));
    };

    for (const node of nodes) {
        const checked = isNodeChecked(node);
        rows.push(
            <div key={node.fullPath} className="py-1" style={{ paddingLeft: `${depth * 16}px` }}>
                <label className="flex items-center gap-2 cursor-pointer font-mono text-xs">
                    <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleNode(node)}
                        className="w-4 h-4"
                    />
                    {node.isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
                    <span className="break-all">{node.name}</span>
                </label>
                {node.children.length > 0 && renderTree(node.children, selected, toggleNode, selectablePathMap, depth + 1)}
            </div>
        );
    }

    return rows;
}

export default function OrphanFilesModal({
    taskId,
    source,
    target,
    excludePatterns,
    onBack,
}: OrphanFilesModalProps) {
    const { t } = useTranslation();
    const { showToast } = useToast();
    const [loading, setLoading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [query, setQuery] = useState('');
    const [orphans, setOrphans] = useState<OrphanFile[]>([]);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const excludePatternsKey = useMemo(() => JSON.stringify(excludePatterns), [excludePatterns]);
    const stableExcludePatterns = useMemo(() => {
        try {
            const parsed = JSON.parse(excludePatternsKey);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.filter((pattern): pattern is string => typeof pattern === 'string');
        } catch {
            return [];
        }
    }, [excludePatternsKey]);

    const scanOrphans = useCallback(async () => {
        try {
            setLoading(true);
            const result = await invoke<OrphanFile[]>('find_orphan_files', {
                taskId,
                source,
                target,
                excludePatterns: stableExcludePatterns,
            });
            setOrphans(result);
            setSelectedPaths(new Set());
        } catch (error) {
            showToast(String(error), 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast, source, stableExcludePatterns, target, taskId]);

    useEffect(() => {
        void scanOrphans();
    }, [scanOrphans]);

    const tree = useMemo(() => buildTree(orphans), [orphans]);
    const filteredTree = useMemo(() => filterNodes(tree, query), [tree, query]);
    const selectablePathMap = useMemo(() => buildSelectablePathMap(tree), [tree]);
    const visibleSelectablePaths = useMemo(
        () => collectVisibleSelectablePaths(filteredTree),
        [filteredTree]
    );

    const toggleNode = (node: TreeNode) => {
        const nodePaths = selectablePathMap.get(node.fullPath) ?? [];
        setSelectedPaths((prev) => {
            const next = new Set(prev);
            const allSelected = nodePaths.length > 0 && nodePaths.every((path) => next.has(path));
            for (const path of nodePaths) {
                if (allSelected) {
                    next.delete(path);
                } else {
                    next.add(path);
                }
            }
            return next;
        });
    };

    const handleSelectVisible = () => {
        const visiblePaths = new Set(visibleSelectablePaths);
        setSelectedPaths(visiblePaths);
    };

    const handleDeselectAll = () => {
        setSelectedPaths(new Set());
    };

    const handleDeleteSelected = async () => {
        if (selectedPaths.size === 0) {
            return;
        }

        const confirmed = await ask(
            t('orphan.confirmDelete', { count: selectedPaths.size, defaultValue: `Delete ${selectedPaths.size} selected items?` }),
            {
                title: t('syncTasks.deleteTask', { defaultValue: 'Delete' }),
                kind: 'warning',
            }
        );

        if (!confirmed) {
            return;
        }

        try {
            setDeleting(true);
            const result = await invoke<DeleteOrphanResult>('delete_orphan_files', {
                taskId,
                target,
                paths: Array.from(selectedPaths),
            });

            showToast(
                t('orphan.deleteSuccess', {
                    files: result.deleted_files_count,
                    dirs: result.deleted_dirs_count,
                    skipped: result.skipped_count,
                    failed: result.failures.length,
                    defaultValue: `Deleted files ${result.deleted_files_count}, dirs ${result.deleted_dirs_count}, skipped ${result.skipped_count}, failed ${result.failures.length}`,
                }),
                result.failures.length > 0 ? 'warning' : 'success'
            );

            await scanOrphans();
        } catch (error) {
            showToast(String(error), 'error');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="w-full">
            <CardAnimation>
                <div className="neo-box p-5 w-full bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)] flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-xl font-heading font-bold uppercase">
                                {t('orphan.title', { defaultValue: 'Orphan Files' })}
                            </h3>
                            <p className="text-xs font-mono text-[var(--text-secondary)]">
                                {t('orphan.foundCount', {
                                    count: orphans.length,
                                    defaultValue: `${orphans.length} items`,
                                })}
                            </p>
                        </div>
                        <button
                            type="button"
                            className="px-3 py-2 border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] font-mono text-xs inline-flex items-center gap-1"
                            onClick={onBack}
                        >
                            <IconArrowLeft size={14} />
                            {t('common.back', { defaultValue: 'Back' })}
                        </button>
                    </div>

                    <div className="flex flex-wrap gap-2 items-center">
                        <button
                            type="button"
                            className="px-3 py-1 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)]"
                            onClick={scanOrphans}
                            disabled={loading || deleting}
                        >
                            <span className="inline-flex items-center gap-1"><IconRefresh size={14} />{t('common.refresh', { defaultValue: 'Refresh' })}</span>
                        </button>
                        <button
                            type="button"
                            className="px-3 py-1 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)]"
                            onClick={handleSelectVisible}
                            disabled={loading || deleting || visibleSelectablePaths.length === 0}
                        >
                            {t('orphan.selectVisible', { defaultValue: 'Select visible' })}
                        </button>
                        <button
                            type="button"
                            className="px-3 py-1 border-2 border-[var(--border-main)] font-mono text-xs hover:bg-[var(--bg-tertiary)]"
                            onClick={handleDeselectAll}
                            disabled={loading || deleting || selectedPaths.size === 0}
                        >
                            {t('orphan.deselectAll', { defaultValue: 'Clear selection' })}
                        </button>
                        <button
                            type="button"
                            className="px-3 py-1 border-2 border-[var(--border-main)] font-mono text-xs bg-[var(--color-accent-error)] text-white disabled:opacity-50"
                            onClick={handleDeleteSelected}
                            disabled={loading || deleting || selectedPaths.size === 0}
                        >
                            <span className="inline-flex items-center gap-1"><IconTrash size={14} />{t('orphan.deleteSelected', { count: selectedPaths.size, defaultValue: `Delete selected (${selectedPaths.size})` })}</span>
                        </button>
                        <div className="flex items-center gap-2 ml-auto border-2 border-[var(--border-main)] px-2 py-1">
                            <IconSearch size={14} />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={t('orphan.search', { defaultValue: 'Search path...' })}
                                className="bg-transparent outline-none font-mono text-xs"
                            />
                        </div>
                    </div>

                    <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-2 overflow-auto min-h-[260px] max-h-[520px]">
                        {loading ? (
                            <div className="font-mono text-sm text-[var(--text-secondary)]">{t('orphan.scanning', { defaultValue: 'Scanning...' })}</div>
                        ) : filteredTree.length === 0 ? (
                            <div className="font-mono text-sm text-[var(--text-secondary)]">{t('orphan.noOrphans', { defaultValue: 'No orphan files found.' })}</div>
                        ) : (
                            renderTree(filteredTree, selectedPaths, toggleNode, selectablePathMap)
                        )}
                    </div>
                </div>
            </CardAnimation>
        </div>
    );
}
