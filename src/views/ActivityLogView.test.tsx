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
});
