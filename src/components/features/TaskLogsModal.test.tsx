import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import TaskLogsModal from './TaskLogsModal';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../ui/Animations', () => ({
  CardAnimation: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef<HTMLDivElement, { data: any[]; itemContent: (index: number, item: any) => ReactNode }>(
    ({ data, itemContent }, _ref) => (
      <div data-testid="virtuoso-list">
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
      </div>
    ),
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string, fallback?: { defaultValue?: string }) => fallback?.defaultValue ?? key),
  })),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

type ListenerMap = Record<string, ((event: any) => void) | undefined>;

describe('TaskLogsModal', () => {
  let listeners: ListenerMap;

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = {};

    mockListen.mockImplementation(async (eventName: string, handler: (event: any) => void) => {
      listeners[eventName] = handler;
      return vi.fn();
    });
  });

  it('shows only allowed task log categories from fetch and events', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: '1',
        timestamp: '2026-02-10T12:00:00Z',
        level: 'info',
        message: 'Sync started',
        task_id: 'task-1',
        category: 'SyncStarted',
      },
      {
        id: '2',
        timestamp: '2026-02-10T12:00:01Z',
        level: 'info',
        message: 'Copy: /a.txt',
        task_id: 'task-1',
        category: 'FileCopied',
      },
      {
        id: '3',
        timestamp: '2026-02-10T12:00:02Z',
        level: 'warning',
        message: 'Operation cancelled by user',
        task_id: 'task-1',
        category: 'Other',
      },
    ]);

    render(<TaskLogsModal taskId="task-1" taskName="Task 1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_task_logs', { taskId: 'task-1' });
    });

    expect(await screen.findByText('Sync started')).toBeInTheDocument();
    expect(screen.getByText('Copy: /a.txt')).toBeInTheDocument();
    expect(screen.queryByText('Operation cancelled by user')).not.toBeInTheDocument();

    await act(async () => {
      listeners['new-log-task']?.({
        payload: {
          task_id: 'task-1',
          entry: {
            id: '4',
            timestamp: '2026-02-10T12:00:03Z',
            level: 'warning',
            message: 'Dry run started',
            task_id: 'task-1',
            category: 'Other',
          },
        },
      });
    });

    expect(screen.queryByText('Dry run started')).not.toBeInTheDocument();

    await act(async () => {
      listeners['new-logs-batch']?.({
        payload: {
          task_id: 'task-1',
          entries: [
            {
              id: '5',
              timestamp: '2026-02-10T12:00:04Z',
              level: 'info',
              message: 'Delete: /b.txt',
              task_id: 'task-1',
              category: 'FileDeleted',
            },
            {
              id: '6',
              timestamp: '2026-02-10T12:00:05Z',
              level: 'warning',
              message: 'Sync skipped: task already syncing',
              task_id: 'task-1',
              category: 'Other',
            },
          ],
        },
      });
    });

    expect(await screen.findByText('Delete: /b.txt')).toBeInTheDocument();
    expect(screen.queryByText('Sync skipped: task already syncing')).not.toBeInTheDocument();
  });
});
