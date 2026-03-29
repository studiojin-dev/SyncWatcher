import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import RecurringSchedulesView from './RecurringSchedulesView';
import type { SyncTask } from '../hooks/useSyncTasks';

const mockState = vi.hoisted(() => ({
  updateTask: vi.fn(),
  showToast: vi.fn(),
  tasks: [] as SyncTask[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'recurringSchedules.title': 'Recurring Schedules',
        'recurringSchedules.runtimeNotice':
          'Recurring schedules only run while the SyncWatcher process is alive.',
        'recurringSchedules.taskSummary': `${options?.count ?? 0} schedules`,
        'recurringSchedules.disableSchedule': 'Disable schedule',
        'recurringSchedules.enableSchedule': 'Enable schedule',
        'recurringSchedules.editSchedule': 'Edit schedule',
        'recurringSchedules.deleteSchedule': 'Delete schedule',
        'recurringSchedules.showRuntimeNotice': 'Show recurring schedule runtime notice',
        'recurringSchedules.history.clear': 'Clear recurring schedule history',
        'recurringSchedules.history.reload': 'Reload recurring schedule history',
        'recurringSchedules.history.title': 'Recent History',
        'recurringSchedules.history.description': 'Saved success and failure records.',
        'recurringSchedules.history.empty': 'No recorded runs yet.',
        'recurringSchedules.history.status.success': 'Success',
        'recurringSchedules.history.status.failure': 'Failure',
        'recurringSchedules.history.startedAt': 'Started',
        'recurringSchedules.history.finishedAt': 'Finished',
        'recurringSchedules.history.conflictCount': 'Conflicts',
        'recurringSchedules.badges.checksumOn': 'Checksum on',
        'recurringSchedules.badges.checksumOff': 'Checksum off',
        'recurringSchedules.badges.enabled': 'Enabled',
        'recurringSchedules.badges.disabled': 'Disabled',
        'recurringSchedules.modal.editTitle': 'Edit Recurring Schedule',
        'recurringSchedules.confirmDeleteTitle': 'Delete recurring schedule',
        'recurringSchedules.confirmDeleteMessage': 'Delete recurring schedule?',
        'recurringSchedules.clearHistoryConfirmTitle': 'Clear recurring schedule history',
        'recurringSchedules.clearHistoryConfirmMessage': 'Clear recurring schedule history?',
        'recurringSchedules.fields.enabled': 'Enabled',
        'recurringSchedules.fields.checksumMode': 'Checksum Mode',
        'recurringSchedules.fields.editorMode': 'Editor Mode',
        'recurringSchedules.fields.frequency': 'Frequency',
        'recurringSchedules.fields.time': 'Time',
        'recurringSchedules.fields.timezone': 'Timezone',
        'recurringSchedules.fields.weekdays': 'Weekdays',
        'recurringSchedules.fields.dayOfMonth': 'Day of month',
        'recurringSchedules.fields.cronExpression': 'Cron Expression',
        'recurringSchedules.fields.retentionCount': 'History Retention',
        'recurringSchedules.fields.cronPreview': 'Cron Preview',
        'recurringSchedules.editorModes.guided': 'Guided',
        'recurringSchedules.editorModes.advanced': 'Advanced',
        'recurringSchedules.presets.hourly': 'Hourly',
        'recurringSchedules.presets.daily': 'Daily',
        'recurringSchedules.presets.weekly': 'Weekly',
        'recurringSchedules.presets.monthly': 'Monthly',
        'recurringSchedules.weekdays.mon': 'Mon',
        'recurringSchedules.weekdays.tue': 'Tue',
        'recurringSchedules.weekdays.wed': 'Wed',
        'recurringSchedules.weekdays.thu': 'Thu',
        'recurringSchedules.weekdays.fri': 'Fri',
        'recurringSchedules.weekdays.sat': 'Sat',
        'recurringSchedules.weekdays.sun': 'Sun',
        'recurringSchedules.summary.weekly': `Every week ${options?.days ?? ''} ${options?.time ?? ''}`.trim(),
        'recurringSchedules.summary.daily': `Every day ${options?.time ?? ''}`.trim(),
        'recurringSchedules.summary.hourly': `Every hour at :${options?.minute ?? ''}`.trim(),
        'recurringSchedules.summary.monthly': `Every month day ${options?.day ?? ''} ${options?.time ?? ''}`.trim(),
        'recurringSchedules.summary.custom': `Custom cron ${options?.cron ?? ''}`.trim(),
        'recurringSchedules.toasts.updated': 'Recurring schedule updated.',
        'recurringSchedules.toasts.historyCleared': 'Recurring schedule history cleared.',
        'common.loading': 'Loading...',
        'common.cancel': 'Cancel',
        'common.save': 'Save',
        'common.close': 'Close',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../context/SyncTasksContext', () => ({
  useSyncTasksContext: () => ({
    tasks: mockState.tasks,
    updateTask: mockState.updateTask,
  }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({
    showToast: mockState.showToast,
  }),
}));

describe('RecurringSchedulesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.tasks = [
      {
        id: 'task-1',
        name: 'SyncTask 1',
        source: '/Volumes/CARD',
        target: '/Volumes/Backup',
        checksumMode: false,
        recurringSchedules: [
          {
            id: 'schedule-1',
            cronExpression: '15 9 * * 1,3',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: true,
            retentionCount: 20,
          },
        ],
      },
    ];
    vi.mocked(ask).mockResolvedValue(true);

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'list_supported_timezones') {
        return ['Asia/Seoul', 'UTC'];
      }

      if (command === 'get_recurring_schedule_history') {
        return [
          {
            scheduledFor: '2026-03-28T00:15:00Z',
            startedAt: '2026-03-28T00:15:01Z',
            finishedAt: '2026-03-28T00:15:05Z',
            status: 'failure',
            checksumMode: true,
            cronExpression: '15 9 * * 1,3',
            timezone: 'Asia/Seoul',
            message: 'Scheduled sync failed for task.',
            errorDetail: 'Disk is busy',
            conflictCount: 0,
          },
        ];
      }

      if (command === 'clear_recurring_schedule_history') {
        return { deleted: true };
      }

      return undefined;
    });
  });

  it('updates recurring schedule enabled state from the task card', async () => {
    render(<RecurringSchedulesView />);

    const toggleButton = await screen.findByRole('button', { name: 'Disable schedule' });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(mockState.updateTask).toHaveBeenCalledWith('task-1', {
        recurringSchedules: [
          expect.objectContaining({
            id: 'schedule-1',
            enabled: false,
          }),
        ],
      });
    });
  });

  it('loads history in the modal and clears it after confirmation', async () => {
    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));

    expect(await screen.findByText('Edit Recurring Schedule')).toBeInTheDocument();
    expect(await screen.findByText('Scheduled sync failed for task.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show recurring schedule runtime notice' }));
    expect(
      screen.getAllByText('Recurring schedules only run while the SyncWatcher process is alive.')[0]
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear recurring schedule history' }));

    await waitFor(() => {
      expect(ask).toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith('clear_recurring_schedule_history', {
        taskId: 'task-1',
        scheduleId: 'schedule-1',
      });
    });
  });
});
