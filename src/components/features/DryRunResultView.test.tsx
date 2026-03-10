import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DryRunResult as DryRunResultModel } from '../../types/syncEngine';
import DryRunResultView from './DryRunResultView';

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ settings: { dataUnitSystem: 'binary' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { path?: string }) =>
      options?.path ? `${key} ${options.path}` : key,
  }),
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: DryRunResultModel['diffs'];
    itemContent: (
      index: number,
      item: DryRunResultModel['diffs'][number],
    ) => ReactNode;
  }) => (
    <div data-testid="virtuoso-list">
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

describe('DryRunResultView', () => {
  it('renders summary and empty state', () => {
    render(
      <DryRunResultView
        taskName="Task A"
        result={{
          diffs: [],
          total_files: 12,
          files_to_copy: 0,
          files_modified: 0,
          bytes_to_copy: 0,
          targetPreflight: null,
        }}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('syncTasks.dryRun · Task A')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('dryRun.noChanges')).toBeInTheDocument();
  });

  it('renders diff rows', () => {
    render(
      <DryRunResultView
        taskName="Task A"
        result={{
          diffs: [
            {
              path: 'a.txt',
              kind: 'New',
              source_size: 1024,
              target_size: null,
              checksum_source: null,
              checksum_target: null,
            },
            {
              path: 'b.txt',
              kind: 'Modified',
              source_size: 2048,
              target_size: 1024,
              checksum_source: null,
              checksum_target: null,
            },
          ],
          total_files: 2,
          files_to_copy: 2,
          files_modified: 1,
          bytes_to_copy: 3072,
          targetPreflight: null,
        }}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.getByText('dryRun.newFile')).toBeInTheDocument();
    expect(screen.getByText('dryRun.modifiedFile')).toBeInTheDocument();
  });

  it('renders a banner when target directory will be created later', () => {
    render(
      <DryRunResultView
        taskName="Task A"
        result={{
          diffs: [],
          total_files: 0,
          files_to_copy: 0,
          files_modified: 0,
          bytes_to_copy: 0,
          targetPreflight: {
            kind: 'willCreateDirectory',
            path: '/tmp/missing-target',
          },
        }}
        onBack={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/dryRun.targetWillBeCreatedBanner/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/missing-target/)).toBeInTheDocument();
  });
});
