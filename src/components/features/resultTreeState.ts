import type { DataUnitSystem } from '../../utils/formatBytes';

export interface ResultTreeEntry {
  path: string;
  typeLabel: string;
  sourceSize: number | null;
  targetSize: number | null;
  icon: 'new' | 'modified' | 'failed';
  tone?: 'default' | 'error';
}

export interface ResultTreeNodeState {
  id: string;
  name: string;
  fullPath: string;
  isDir: boolean;
  parentId: string | null;
  childIds: string[];
  aggregateCount: number;
  aggregateSourceSize: number;
  aggregateTargetSize: number;
  entry?: ResultTreeEntry;
}

export interface ResultTreeRow {
  key: string;
  nodeId: string;
  depth: number;
}

export interface ResultTreeState {
  rootIds: string[];
  pathToNodeId: Map<string, string>;
  nodes: Map<string, ResultTreeNodeState>;
  treeVersion: number;
  entryCount: number;
}

export function createEmptyResultTreeState(): ResultTreeState {
  return {
    rootIds: [],
    pathToNodeId: new Map(),
    nodes: new Map(),
    treeVersion: 0,
    entryCount: 0,
  };
}

function nodeComparator(
  leftId: string,
  rightId: string,
  nodes: Map<string, ResultTreeNodeState>,
): number {
  const left = nodes.get(leftId);
  const right = nodes.get(rightId);
  if (!left || !right) {
    return 0;
  }
  if (left.isDir !== right.isDir) {
    return left.isDir ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function insertSortedChild(
  childIds: string[],
  childId: string,
  nodes: Map<string, ResultTreeNodeState>,
): string[] {
  if (childIds.includes(childId)) {
    return childIds;
  }

  const next = [...childIds, childId];
  next.sort((leftId, rightId) => nodeComparator(leftId, rightId, nodes));
  return next;
}

function numericValue(value: number | null | undefined): number {
  return value ?? 0;
}

function updateAncestorAggregates(
  state: ResultTreeState,
  leafId: string,
  sourceDelta: number,
  targetDelta: number,
  countDelta: number,
) {
  let currentId: string | null = leafId;

  while (currentId) {
    const node = state.nodes.get(currentId);
    if (!node) {
      break;
    }

    node.aggregateSourceSize += sourceDelta;
    node.aggregateTargetSize += targetDelta;
    node.aggregateCount += countDelta;
    currentId = node.parentId;
  }
}

function ensureNode(
  state: ResultTreeState,
  name: string,
  fullPath: string,
  isDir: boolean,
  parentId: string | null,
): ResultTreeNodeState {
  const existingId = state.pathToNodeId.get(fullPath);
  if (existingId) {
    const existing = state.nodes.get(existingId);
    if (!existing) {
      throw new Error(`Result tree invariant failed for ${fullPath}`);
    }
    if (!isDir) {
      existing.isDir = false;
    }
    return existing;
  }

  const node: ResultTreeNodeState = {
    id: fullPath,
    name,
    fullPath,
    isDir,
    parentId,
    childIds: [],
    aggregateCount: 0,
    aggregateSourceSize: 0,
    aggregateTargetSize: 0,
  };
  state.pathToNodeId.set(fullPath, node.id);
  state.nodes.set(node.id, node);

  if (parentId) {
    const parent = state.nodes.get(parentId);
    if (!parent) {
      throw new Error(`Missing parent node for ${fullPath}`);
    }
    parent.childIds = insertSortedChild(parent.childIds, node.id, state.nodes);
  } else {
    state.rootIds = insertSortedChild(state.rootIds, node.id, state.nodes);
  }

  return node;
}

function appendEntry(state: ResultTreeState, entry: ResultTreeEntry) {
  const parts = entry.path.split('/').filter(Boolean);
  let parentId: string | null = null;
  let accum = '';

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    accum = accum ? `${accum}/${part}` : part;
    const isLast = index === parts.length - 1;
    const node = ensureNode(state, part, accum, !isLast, parentId);
    parentId = node.id;

    if (isLast) {
      const previousEntry = node.entry;
      const previousSource = numericValue(previousEntry?.sourceSize);
      const previousTarget = numericValue(previousEntry?.targetSize);
      const sourceDelta = numericValue(entry.sourceSize) - previousSource;
      const targetDelta = numericValue(entry.targetSize) - previousTarget;
      const countDelta = previousEntry ? 0 : 1;

      node.isDir = false;
      node.entry = entry;

      updateAncestorAggregates(state, node.id, sourceDelta, targetDelta, countDelta);
    }
  }

  state.entryCount += 1;
}

export function appendResultTreeEntries(
  previousState: ResultTreeState,
  entries: ResultTreeEntry[],
): ResultTreeState {
  if (entries.length === 0) {
    return previousState;
  }

  const nextState: ResultTreeState = {
    ...previousState,
    rootIds: [...previousState.rootIds],
    pathToNodeId: new Map(previousState.pathToNodeId),
    nodes: new Map(previousState.nodes),
    treeVersion: previousState.treeVersion + 1,
  };

  for (const entry of entries) {
    appendEntry(nextState, entry);
  }

  return nextState;
}

export function rebuildResultTreeState(entries: ResultTreeEntry[]): ResultTreeState {
  return appendResultTreeEntries(createEmptyResultTreeState(), entries);
}

export function flattenVisibleRows(
  state: ResultTreeState,
  collapsedPaths: Set<string>,
): ResultTreeRow[] {
  const rows: ResultTreeRow[] = [];

  const walk = (nodeId: string, depth: number) => {
    const node = state.nodes.get(nodeId);
    if (!node) {
      return;
    }

    rows.push({
      key: node.fullPath,
      nodeId,
      depth,
    });

    if (node.isDir && !collapsedPaths.has(node.fullPath)) {
      for (const childId of node.childIds) {
        walk(childId, depth + 1);
      }
    }
  };

  for (const rootId of state.rootIds) {
    walk(rootId, 0);
  }

  return rows;
}

export function formatDisplaySize(
  value: number | null | undefined,
  unitSystem: DataUnitSystem,
  formatBytesFn: (value: number, unitSystem: DataUnitSystem) => string,
): string {
  if (value === null || value === undefined) {
    return '-';
  }

  return formatBytesFn(value, unitSystem);
}
