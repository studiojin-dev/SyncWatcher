import { describe, expect, it } from 'vitest';
import {
  appendResultTreeEntries,
  createEmptyResultTreeState,
  flattenVisibleRows,
  rebuildResultTreeState,
  type ResultTreeEntry,
} from './resultTreeState';

function entry(
  path: string,
  sourceSize: number,
  targetSize: number | null = null,
): ResultTreeEntry {
  return {
    path,
    typeLabel: 'Copied',
    sourceSize,
    targetSize,
    icon: 'new',
  };
}

describe('resultTreeState', () => {
  it('supports incremental append without rebuilding previous rows', () => {
    const firstState = appendResultTreeEntries(createEmptyResultTreeState(), [
      entry('dir/a.txt', 10, 0),
    ]);
    const secondState = appendResultTreeEntries(firstState, [
      entry('dir/sub/b.txt', 5, 2),
    ]);

    expect(secondState.nodes.get('dir')).toBe(firstState.nodes.get('dir'));
    expect(secondState.nodes.get('dir')?.aggregateCount).toBe(2);
    expect(secondState.nodes.get('dir')?.aggregateSourceSize).toBe(15);
  });

  it('rebuilds a stable visible row list respecting collapsed paths', () => {
    const state = rebuildResultTreeState([
      entry('dir/a.txt', 10, 0),
      entry('dir/sub/b.txt', 5, 2),
    ]);

    expect(flattenVisibleRows(state, new Set()).map((row) => row.key)).toEqual([
      'dir',
      'dir/sub',
      'dir/sub/b.txt',
      'dir/a.txt',
    ]);

    expect(
      flattenVisibleRows(state, new Set(['dir'])).map((row) => row.key),
    ).toEqual(['dir']);
  });
});
