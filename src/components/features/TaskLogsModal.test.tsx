import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import TaskLogsModal from './TaskLogsModal';

interface MockLogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  task_id?: string;
  category?: string;
}

interface MockSingleLogEvent {
  payload: {
    task_id?: string;
    entry: MockLogEntry;
  };
}

interface MockBatchLogEvent {
  payload: {
    task_id?: string;
    entries: MockLogEntry[];
  };
}

const { MockChannel } = vi.hoisted(() => {
  class MockChannel<T = unknown> {
    id = Math.floor(Math.random() * 1000);
    onmessage: (response: T) => void;

    constructor(onmessage?: (response: T) => void) {
      this.onmessage = onmessage ?? (() => undefined);
    }
  }

  return { MockChannel };
});

vi.mock('@tauri-apps/api/core', () => ({
  Channel: MockChannel,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../ui/Animations', () => ({
  CardAnimation: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef<
    HTMLDivElement,
    {
      data: MockLogEntry[];
      itemContent: (index: number, item: MockLogEntry) => ReactNode;
    }
  >(
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

type MockListenerEvent = MockSingleLogEvent | MockBatchLogEvent;
type ListenerMap = Record<string, ((event: MockListenerEvent) => void) | undefined>;

function getInvokeArgs(command: string) {
  const call = mockInvoke.mock.calls.find(([name]) => name === command);
  expect(call).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

describe('TaskLogsModal', () => {
  let listeners: ListenerMap;

  beforeEach(() => {
    vi.clearAllMocks();
    listeners = {};

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_task_logs') {
        return [
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
        ];
      }
      if (command === 'subscribe_task_log_batches') {
        return 'sub-1';
      }
      if (command === 'unsubscribe_task_log_batches') {
        return true;
      }
      return undefined;
    });

    mockListen.mockImplementation(async (eventName: string, handler: (event: MockListenerEvent) => void) => {
      listeners[eventName] = handler;
      return vi.fn();
    });
  });

  it('shows all task log categories from fetch and events', async () => {
    const { unmount } = render(<TaskLogsModal taskId="task-1" taskName="Task 1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_task_logs', { taskId: 'task-1' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'subscribe_task_log_batches',
        expect.objectContaining({
          taskId: 'task-1',
          batchChannel: expect.any(MockChannel),
        }),
      );
    });

    expect(await screen.findByText('Sync started')).toBeInTheDocument();
    expect(screen.getByText('Copy: /a.txt')).toBeInTheDocument();
    expect(screen.getByText('Operation cancelled by user')).toBeInTheDocument();

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

    expect(screen.getByText('Dry run started')).toBeInTheDocument();

    await act(async () => {
      (getInvokeArgs('subscribe_task_log_batches').batchChannel as InstanceType<typeof MockChannel>).onmessage({
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
      });
    });

    expect(await screen.findByText('Delete: /b.txt')).toBeInTheDocument();
    expect(screen.getByText('Sync skipped: task already syncing')).toBeInTheDocument();

    unmount();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('unsubscribe_task_log_batches', {
        subscriptionId: 'sub-1',
      });
    });
  });

  it('keeps receiving legacy new-logs-batch events when channel subscription fails', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_task_logs') {
        return [];
      }
      if (command === 'subscribe_task_log_batches') {
        throw new Error('subscription failed');
      }
      return undefined;
    });

    render(<TaskLogsModal taskId="task-1" taskName="Task 1" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('subscribe_task_log_batches', expect.anything());
    });

    await act(async () => {
      listeners['new-logs-batch']?.({
        payload: {
          task_id: 'task-1',
          entries: [
            {
              id: '7',
              timestamp: '2026-02-10T12:00:06Z',
              level: 'info',
              message: 'Copy: /fallback.txt',
              task_id: 'task-1',
              category: 'FileCopied',
            },
          ],
        },
      });
    });

    expect(await screen.findByText('Copy: /fallback.txt')).toBeInTheDocument();
  });
});
