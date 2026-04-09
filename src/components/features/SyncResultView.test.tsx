import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import SyncResultView from './SyncResultView';

const sessionState = vi.hoisted(() => ({
  current: undefined as
    | {
        taskId: string;
        taskName: string;
        status: 'running' | 'completed' | 'cancelled' | 'failed';
        result: {
          entries: Array<{
            path: string;
            kind: 'New' | 'Modified';
            status: 'copied' | 'failed';
            source_size: number | null;
            target_size: number | null;
            error?: string;
          }>;
          files_copied: number;
          bytes_copied: number;
          errors: Array<{ path: string; message: string; kind: string }>;
          conflictCount: number;
          hasPendingConflicts: boolean;
          targetPreflight: null;
        };
        progress?: {
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
  useSyncSession: () => sessionState.current,
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
    t: (key: string) => key,
  }),
}));

describe('SyncResultView', () => {
  beforeEach(() => {
    sessionState.current = undefined;
  });

  it('renders running progress and copied entries', () => {
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task 1',
      status: 'running',
      result: {
        entries: [
          {
            path: 'dir/a.txt',
            kind: 'New',
            status: 'copied',
            source_size: 1024,
            target_size: 0,
          },
          {
            path: 'dir/sub/b.txt',
            kind: 'Modified',
            status: 'failed',
            source_size: 2048,
            target_size: 1024,
            error: 'copy failed',
          },
        ],
        files_copied: 1,
        bytes_copied: 1024,
        errors: [{ path: 'dir/sub/b.txt', message: 'copy failed', kind: 'CopyFailed' }],
        conflictCount: 0,
        hasPendingConflicts: false,
        targetPreflight: null,
      },
      progress: {
        message: 'dir/sub/b.txt',
        current: 1,
        total: 2,
        processedBytes: 1024,
        totalBytes: 4096,
      },
    };

    render(
      <SyncResultView taskId="task-1" taskName="Task 1" onBack={vi.fn()} />,
    );

    expect(screen.getByText('syncTasks.startSync · Task 1')).toBeInTheDocument();
    expect(screen.getByText('sync.statusRunning')).toBeInTheDocument();
    expect(screen.getAllByText(/25%/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('result-tree-row-dir')).toHaveTextContent('3 KiB');
    expect(screen.getByTestId('result-tree-row-dir/sub/b.txt')).toHaveTextContent(
      'sync.fileFailed',
    );
  });

  it('shows rerun action for terminal sessions', () => {
    const onRequestRerun = vi.fn();
    sessionState.current = {
      taskId: 'task-1',
      taskName: 'Task 1',
      status: 'completed',
      result: {
        entries: [],
        files_copied: 0,
        bytes_copied: 0,
        errors: [],
        conflictCount: 0,
        hasPendingConflicts: false,
        targetPreflight: null,
      },
    };

    render(
      <SyncResultView
        taskId="task-1"
        taskName="Task 1"
        onBack={vi.fn()}
        onRequestRerun={onRequestRerun}
      />,
    );

    fireEvent.click(screen.getByText('common.retry'));
    expect(onRequestRerun).toHaveBeenCalledTimes(1);
  });
});
