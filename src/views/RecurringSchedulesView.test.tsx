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
        'recurringSchedules.addSchedule': 'Add schedule',
        'recurringSchedules.deleteAll': 'Delete all schedules',
        'recurringSchedules.fields.enabled': 'Enabled',
        'recurringSchedules.fields.checksumMode': 'Checksum Mode',
        'recurringSchedules.fields.frequency': 'Frequency',
        'recurringSchedules.fields.time': 'Time',
        'recurringSchedules.fields.timezone': 'Timezone',
        'recurringSchedules.fields.weekdays': 'Weekdays',
        'recurringSchedules.fields.dayOfMonth': 'Day of month',
        'recurringSchedules.fields.minute': 'Minute',
        'recurringSchedules.fields.hourlyMinuteHelp': 'Enter a minute from 0 to 59.',
        'recurringSchedules.fields.retentionCount': 'History Retention',
        'recurringSchedules.fields.cronPreview': 'Cron Preview',
        'recurringSchedules.presets.hourly': 'Hourly',
        'recurringSchedules.presets.daily': 'Daily',
        'recurringSchedules.presets.weekly': 'Weekly',
        'recurringSchedules.presets.monthly': 'Monthly',
        'recurringSchedules.modal.editTitle': 'Edit Recurring Schedule',
        'recurringSchedules.modal.addTitle': 'Add Recurring Schedule',
        'recurringSchedules.summary.daily': `Every day ${options?.time ?? ''}`.trim(),
        'recurringSchedules.summary.hourly': `Every hour at :${options?.minute ?? ''}`.trim(),
        'recurringSchedules.summary.unsupportedCustom': `Unsupported custom cron ${options?.cron ?? ''}`.trim(),
        'recurringSchedules.badges.checksumOn': 'Checksum on',
        'recurringSchedules.badges.checksumOff': 'Checksum off',
        'recurringSchedules.badges.enabled': 'Enabled',
        'recurringSchedules.badges.disabled': 'Disabled',
        'recurringSchedules.badges.unsupported': 'Unsupported',
        'recurringSchedules.errors.hourlyMinuteRange': 'Minute must be between 0 and 59.',
        'recurringSchedules.errors.unsupportedCustom':
          'This schedule uses a custom cron expression that can no longer be edited here.',
        'recurringSchedules.unsupported.title': 'Unsupported custom cron',
        'recurringSchedules.unsupported.description':
          'This schedule cannot be edited in the guided editor.',
        'recurringSchedules.unsupported.deleteHint':
          'Delete this schedule and create a new guided schedule instead.',
        'recurringSchedules.history.title': 'Recent History',
        'recurringSchedules.history.description': 'Saved success and failure records.',
        'recurringSchedules.history.empty': 'No recorded runs yet.',
        'recurringSchedules.history.reload': 'Reload recurring schedule history',
        'recurringSchedules.history.clear': 'Clear recurring schedule history',
        'common.loading': 'Loading...',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
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
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'list_supported_timezones') {
        return ['Asia/Seoul', 'UTC'];
      }

      if (command === 'get_recurring_schedule_history') {
        return [];
      }

      if (command === 'clear_recurring_schedule_history') {
        return { deleted: true };
      }

      return undefined;
    });
  });

  it('shows an unpadded hourly minute draft and saves normalized minute input', async () => {
    mockState.tasks = [
      {
        id: 'task-1',
        name: 'Repo->evo',
        source: '/src',
        target: '/dst',
        checksumMode: false,
        recurringSchedules: [
          {
            id: 'schedule-1',
            cronExpression: '5 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];

    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));

    expect(screen.queryByText('Editor Mode')).not.toBeInTheDocument();
    const minuteInput = screen.getByRole('textbox', { name: 'Minute' });
    expect(minuteInput).toHaveValue('5');

    fireEvent.change(minuteInput, { target: { value: '0055' } });
    expect(minuteInput).toHaveValue('55');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockState.updateTask).toHaveBeenCalledWith('task-1', {
        recurringSchedules: [
          expect.objectContaining({
            id: 'schedule-1',
            cronExpression: '55 * * * *',
          }),
        ],
      });
    });
  });

  it('filters non-digit input from hourly minute draft', async () => {
    mockState.tasks = [
      {
        id: 'task-1',
        name: 'Repo->evo',
        source: '/src',
        target: '/dst',
        checksumMode: false,
        recurringSchedules: [
          {
            id: 'schedule-1',
            cronExpression: '0 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];

    render(<RecurringSchedulesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));

    const minuteInput = screen.getByRole('textbox', { name: 'Minute' });
    expect(minuteInput).toHaveValue('0');
    fireEvent.change(minuteInput, { target: { value: '5abc' } });

    expect(minuteInput).toHaveValue('5');
    expect(screen.queryByText('Minute must be between 0 and 59.')).not.toBeInTheDocument();
  });

  it('shows an error and disables save when the hourly minute is invalid', async () => {
    mockState.tasks = [
      {
        id: 'task-1',
        name: 'Repo->evo',
        source: '/src',
        target: '/dst',
        checksumMode: false,
        recurringSchedules: [
          {
            id: 'schedule-1',
            cronExpression: '5 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];

    render(<RecurringSchedulesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));

    const minuteInput = screen.getByRole('textbox', { name: 'Minute' });
    const saveButton = screen.getByRole('button', { name: 'Save' });

    fireEvent.change(minuteInput, { target: { value: '' } });
    expect(await screen.findByText('Minute must be between 0 and 59.')).toBeInTheDocument();
    expect(saveButton).toBeDisabled();
    expect(screen.getByText('5 * * * *')).toBeInTheDocument();

    fireEvent.change(minuteInput, { target: { value: '72' } });

    expect(await screen.findByText('Minute must be between 0 and 59.')).toBeInTheDocument();
    expect(saveButton).toBeDisabled();
    expect(screen.getByText('5 * * * *')).toBeInTheDocument();
    expect(mockState.updateTask).not.toHaveBeenCalled();
  });

  it('shows unsupported custom cron guidance and blocks saving', async () => {
    mockState.tasks = [
      {
        id: 'task-1',
        name: 'Repo->evo',
        source: '/src',
        target: '/dst',
        checksumMode: false,
        recurringSchedules: [
          {
            id: 'schedule-1',
            cronExpression: '*/15 9-17 * * 1-5',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];

    render(<RecurringSchedulesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit schedule' }));

    expect(await screen.findByText('Unsupported custom cron')).toBeInTheDocument();
    expect(
      screen.getByText('Delete this schedule and create a new guided schedule instead.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
