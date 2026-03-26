import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ActivityLogView from './ActivityLogView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'activityLog.title': 'Activity Log',
        'common.refresh': 'Refresh',
      };
      return translations[key] ?? key;
    }),
  })),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe('ActivityLogView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads activity logs and renders task badge from task_id', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: '1',
        timestamp: '2026-02-10T12:00:00Z',
        level: 'info',
        message: 'Sync started',
        task_id: 'task-1',
        category: 'SyncStarted',
      },
    ]);

    render(<ActivityLogView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_system_logs');
    });

    expect(await screen.findByText('Sync started')).toBeInTheDocument();
    expect(screen.getByText('TASK:task-1')).toBeInTheDocument();
  });

  it('renders validation errors in the activity log', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: '2',
        timestamp: '2026-02-10T12:05:00Z',
        level: 'error',
        message: 'Validation blocked saving sync task',
        category: 'ValidationError',
      },
    ]);

    render(<ActivityLogView />);

    expect(
      await screen.findByText('Validation blocked saving sync task'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/TASK:/)).not.toBeInTheDocument();
  });

  it('filters non-activity entries from fetched logs', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: '3',
        timestamp: '2026-02-10T12:10:00Z',
        level: 'info',
        message: 'Copied file.txt',
        task_id: 'task-1',
        category: 'FileCopied',
      },
    ]);

    render(<ActivityLogView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_system_logs');
    });

    expect(screen.queryByText('Copied file.txt')).not.toBeInTheDocument();
  });

  it('filters task-scoped validation entries from fetched logs', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: '4',
        timestamp: '2026-02-10T12:15:00Z',
        level: 'error',
        message: 'Task scoped validation',
        task_id: 'task-9',
        category: 'ValidationError',
      },
    ]);

    render(<ActivityLogView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_system_logs');
    });

    expect(screen.queryByText('Task scoped validation')).not.toBeInTheDocument();
  });
});
