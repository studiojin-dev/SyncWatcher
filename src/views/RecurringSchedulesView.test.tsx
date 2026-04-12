import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import RecurringSchedulesView from './RecurringSchedulesView';
import type { SyncTask } from '../hooks/useSyncTasks';
import type { RecurringScheduleHistoryEntry } from '../utils/recurringSchedules';

const mockState = vi.hoisted(() => ({
  updateTask: vi.fn(),
  showToast: vi.fn(),
  tasks: [] as SyncTask[],
  historyByScheduleId: {} as Record<string, RecurringScheduleHistoryEntry[]>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
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
        'recurringSchedules.viewLogs': 'View logs',
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
        'recurringSchedules.history.startedAt': 'Started',
        'recurringSchedules.history.finishedAt': 'Finished',
        'recurringSchedules.history.conflictCount': 'Conflicts',
        'recurringSchedules.history.status.success': 'Success',
        'recurringSchedules.history.status.failure': 'Failure',
        'recurringSchedules.logs.title': 'Schedule Logs',
        'recurringSchedules.logs.runListTitle': 'Runs',
        'recurringSchedules.logs.detailTitle': 'Run Details',
        'recurringSchedules.logs.emptyRuns': 'No recorded runs yet.',
        'recurringSchedules.logs.emptyDetails': 'No detailed file activity was saved for this run.',
        'recurringSchedules.logs.noRunSelected': 'Select a run to inspect its details.',
        'recurringSchedules.logs.runCount': `${options?.count ?? 0} runs`,
        'recurringSchedules.logs.detailCount': `${options?.count ?? 0} detail entries`,
        'recurringSchedules.toasts.historyCleared': 'Recurring schedule history cleared.',
        'recurringSchedules.toasts.clearHistoryFailed': 'Failed to clear recurring schedule history.',
        'recurringSchedules.toasts.updated': 'Recurring schedule updated.',
        'common.loading': 'Loading...',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'common.back': 'Back',
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

function buildHistoryEntry(
  message: string,
  detailMessage: string,
  overrides: Partial<RecurringScheduleHistoryEntry> = {},
): RecurringScheduleHistoryEntry {
  return {
    scheduledFor: '2026-03-30T01:00:00Z',
    startedAt: '2026-03-30T01:00:05Z',
    finishedAt: '2026-03-30T01:00:10Z',
    status: 'success',
    checksumMode: false,
    cronExpression: '0 * * * *',
    timezone: 'Asia/Seoul',
    message,
    errorDetail: null,
    conflictCount: 0,
    detailEntries: [
      {
        timestamp: '2026-03-30T01:00:06Z',
        level: 'info',
        category: 'FileCopied',
        message: detailMessage,
      },
    ],
    ...overrides,
  };
}

describe('RecurringSchedulesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.historyByScheduleId = {};
    vi.mocked(invoke).mockImplementation(async (...args: Parameters<typeof invoke>) => {
      const [command, payload] = args;
      const scheduleId =
        typeof payload === 'object' &&
        payload !== null &&
        'scheduleId' in payload &&
        typeof payload.scheduleId === 'string'
          ? payload.scheduleId
          : '';

      if (command === 'list_supported_timezones') {
        return ['Asia/Seoul', 'UTC'];
      }

      if (command === 'get_recurring_schedule_history') {
        return mockState.historyByScheduleId[scheduleId] ?? [];
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

  it('opens a logs drill-in and selects the latest run by default', async () => {
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
            cronExpression: '55 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];
    mockState.historyByScheduleId['schedule-1'] = [
      buildHistoryEntry('Latest run summary', 'Delete: /tmp/b.txt'),
      buildHistoryEntry('Older run summary', 'Copy: /tmp/a.txt', {
        scheduledFor: '2026-03-29T01:00:00Z',
        startedAt: '2026-03-29T01:00:05Z',
        finishedAt: '2026-03-29T01:00:10Z',
      }),
    ];

    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'View logs' }));

    expect(await screen.findByText('Schedule Logs')).toBeInTheDocument();
    expect(screen.getByText('Latest run summary')).toBeInTheDocument();
    expect(screen.getByText('Delete: /tmp/b.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Older run summary'));
    expect(await screen.findByText('Copy: /tmp/a.txt')).toBeInTheDocument();
  });

  it('clears schedule history from the logs drill-in', async () => {
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
            cronExpression: '55 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];
    mockState.historyByScheduleId['schedule-1'] = [
      buildHistoryEntry('Latest run summary', 'Delete: /tmp/b.txt'),
    ];

    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'View logs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear recurring schedule history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('clear_recurring_schedule_history', {
        taskId: 'task-1',
        scheduleId: 'schedule-1',
      });
    });

    expect(await screen.findByText('No recorded runs yet.')).toBeInTheDocument();
  });

  it('saves retention count from the logs drill-in', async () => {
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
            cronExpression: '55 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];
    mockState.historyByScheduleId['schedule-1'] = [
      buildHistoryEntry('Latest run summary', 'Delete: /tmp/b.txt'),
    ];

    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'View logs' }));
    const retentionInput = await screen.findByRole('spinbutton', { name: 'History Retention' });
    fireEvent.change(retentionInput, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockState.updateTask).toHaveBeenCalledWith('task-1', {
        recurringSchedules: [
          expect.objectContaining({
            id: 'schedule-1',
            retentionCount: 5,
          }),
        ],
      });
    });
  });

  it('shows error detail together with saved detail entries in the logs drill-in', async () => {
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
            cronExpression: '55 * * * *',
            timezone: 'Asia/Seoul',
            enabled: true,
            checksumMode: false,
            retentionCount: 20,
          },
        ],
      },
    ];
    mockState.historyByScheduleId['schedule-1'] = [
      buildHistoryEntry('Failed run summary', 'Copy: /tmp/a.txt', {
        status: 'failure',
        errorDetail: 'Permission denied while copying /tmp/a.txt',
      }),
    ];

    render(<RecurringSchedulesView />);

    fireEvent.click(await screen.findByRole('button', { name: 'View logs' }));

    expect(await screen.findByText('Failed run summary')).toBeInTheDocument();
    expect(screen.getByText('Copy: /tmp/a.txt')).toBeInTheDocument();
    expect(screen.getByText('Permission denied while copying /tmp/a.txt')).toBeInTheDocument();
  });

  it('removes history from the edit modal', async () => {
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
            cronExpression: '0 11 * * *',
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

    expect(screen.queryByText('Recent History')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload recurring schedule history' })).not.toBeInTheDocument();
  });
});
