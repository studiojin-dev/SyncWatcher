import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DryRunResult as DryRunResultModel } from '../../types/syncEngine';
import type { ReactNode } from 'react';
import DryRunResultView from './DryRunResultView';

const sessionState = vi.hoisted(() => ({
  current: undefined as
    | {
        taskId: string;
        taskName: string;
        status: 'running' | 'completed' | 'cancelled' | 'failed';
        result: DryRunResultModel;
        progress?: {
          phase?: string;
          message?: string;
          current?: number;
          total?: number;
          processedBytes?: number;
          totalBytes?: number;
        };
        error?: string;
      }
    | undefined,
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ settings: { dataUnitSystem: 'binary' } }),
}));

vi.mock('../../hooks/useSyncTaskStatus', () => ({
  useDryRunSession: () => sessionState.current,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { path?: string }) =>
      options?.path ? `${key} ${options.path}` : key,
  }),
}));

describe('DryRunResultView', () => {
  beforeEach(() => {
    sessionState.current = undefined;
  });

  it('renders summary and empty state', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'completed',
      result: {
        diffs: [],
        total_files: 12,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: null,
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('syncTasks.dryRun · Task A')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('dryRun.noChanges')).toBeInTheDocument();
  });

  it('renders diffs in a four-column tree table', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'completed',
      result: {
        diffs: [
          {
            path: 'dir/a.txt',
            kind: 'New',
            source_size: 1024,
            target_size: null,
            checksum_source: null,
            checksum_target: null,
          },
          {
            path: 'dir/sub/b.txt',
            kind: 'Modified',
            source_size: 2048,
            target_size: 1024,
            checksum_source: null,
            checksum_target: null,
          },
          {
            path: 'root.txt',
            kind: 'New',
            source_size: 512,
            target_size: null,
            checksum_source: null,
            checksum_target: null,
          },
        ],
        total_files: 3,
        files_to_copy: 3,
        files_modified: 1,
        bytes_to_copy: 3584,
        targetPreflight: null,
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('dryRun.colPath')).toBeInTheDocument();
    expect(screen.getByText('dryRun.colType')).toBeInTheDocument();
    expect(screen.getByText('dryRun.colSourceSize')).toBeInTheDocument();
    expect(screen.getByText('dryRun.colTargetSize')).toBeInTheDocument();
    expect(screen.getByText('dir')).toBeInTheDocument();
    expect(screen.getByText('sub')).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(screen.getByText('root.txt')).toBeInTheDocument();
    expect(screen.getAllByText('dryRun.newFile')).toHaveLength(2);
    expect(screen.getByText('dryRun.modifiedFile')).toBeInTheDocument();
    expect(screen.getAllByText('1 KiB').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('2 KiB').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('result-tree-row-dir')).toHaveTextContent('2');
    expect(screen.getByTestId('result-tree-row-dir')).toHaveTextContent('3 KiB');
    expect(screen.getByTestId('result-tree-row-dir')).toHaveTextContent('1 KiB');
  });

  it('collapses and expands directory rows', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'completed',
      result: {
        diffs: [
          {
            path: 'dir/a.txt',
            kind: 'New',
            source_size: 1024,
            target_size: null,
            checksum_source: null,
            checksum_target: null,
          },
          {
            path: 'dir/sub/b.txt',
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
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('common.collapseDirectory')[0]);
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('sub')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('common.expandDirectory')[0]);
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('sub')).toBeInTheDocument();
  });

  it('renders a banner when target directory will be created later', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'completed',
      result: {
        diffs: [],
        total_files: 0,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: {
          kind: 'willCreateDirectory',
          path: '/tmp/missing-target',
        },
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/dryRun.targetWillBeCreatedBanner/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/missing-target/)).toBeInTheDocument();
  });

  it('shows live scanning state while dry-run is running', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'running',
      result: {
        diffs: [],
        total_files: 0,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: null,
      },
      progress: {
        phase: 'scanningSource',
        message: 'Scanning source',
        current: 3,
        total: 10,
        processedBytes: 1536,
        totalBytes: 0,
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('dryRun.statusRunning')).toBeInTheDocument();
    expect(screen.getAllByText(/dryRun.phaseScanningSource/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/30%/).length).toBeGreaterThan(0);
  });

  it('shows a rerun action for terminal sessions', () => {
    const onRequestRerun = vi.fn();
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task A',
      status: 'completed',
      result: {
        diffs: [],
        total_files: 0,
        files_to_copy: 0,
        files_modified: 0,
        bytes_to_copy: 0,
        targetPreflight: null,
      },
    };

    render(
      <DryRunResultView
        taskId="task-1"
        taskName="Task A"
        onBack={vi.fn()}
        onRequestRerun={onRequestRerun}
      />,
    );

    fireEvent.click(screen.getByText('common.retry'));
    expect(onRequestRerun).toHaveBeenCalledTimes(1);
  });
});
