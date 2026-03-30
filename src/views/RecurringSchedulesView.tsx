import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  IconCalendarRepeat,
  IconEdit,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconReload,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CardAnimation, FadeIn } from '../components/ui/Animations';
import { useToast } from '../components/ui/Toast';
import { useSyncTasksContext } from '../context/SyncTasksContext';
import type { SyncTask } from '../hooks/useSyncTasks';
import {
  buildCronExpressionFromPreset,
  getSystemTimezone,
  normalizeRecurringSchedule,
  normalizeRecurringSchedules,
  parseCronExpressionToBuilder,
  type ParsedRecurringScheduleBuilder,
  type RecurringSchedule,
  type RecurringScheduleHistoryEntry,
  type RecurringSchedulePreset,
} from '../utils/recurringSchedules';

type EditorMode = 'create' | 'edit';

interface ScheduleModalState {
  mode: EditorMode;
  task: SyncTask;
  schedule: RecurringSchedule;
}

const WEEKDAY_KEYS: Array<{ value: string; key: string }> = [
  { value: '1', key: 'recurringSchedules.weekdays.mon' },
  { value: '2', key: 'recurringSchedules.weekdays.tue' },
  { value: '3', key: 'recurringSchedules.weekdays.wed' },
  { value: '4', key: 'recurringSchedules.weekdays.thu' },
  { value: '5', key: 'recurringSchedules.weekdays.fri' },
  { value: '6', key: 'recurringSchedules.weekdays.sat' },
  { value: '0', key: 'recurringSchedules.weekdays.sun' },
];

const RECURRING_RUNTIME_NOTICE_KEY = 'recurringSchedules.runtimeNotice';

function formatTimeValue(time: string): string {
  const [hour = '0', minute = '0'] = time.split(':');
  const date = new Date(Date.UTC(2000, 0, 1, Number(hour), Number(minute)));
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

function formatHistoryTimestamp(value: string, timezone: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone || 'UTC',
  }).format(parsed);
}

function isSupportedGuidedSchedule(schedule: RecurringSchedule): boolean {
  return parseCronExpressionToBuilder(schedule.cronExpression) !== null;
}

function isValidMinuteValue(value: string): boolean {
  if (!/^\d{1,2}$/.test(value)) {
    return false;
  }

  const numeric = Number(value);
  return numeric >= 0 && numeric <= 59;
}

function formatMinuteValue(value: string): string {
  return value.padStart(2, '0');
}

function describeRecurringSchedule(
  schedule: RecurringSchedule,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = parseCronExpressionToBuilder(schedule.cronExpression);
  if (!parsed) {
    return t('recurringSchedules.summary.unsupportedCustom', {
      cron: schedule.cronExpression,
      defaultValue: `Unsupported custom cron ${schedule.cronExpression}`,
    });
  }

  const formattedTime = formatTimeValue(parsed.time);

  switch (parsed.preset) {
    case 'hourly':
      return t('recurringSchedules.summary.hourly', {
        minute: parsed.time.slice(3, 5),
        defaultValue: `Every hour at :${parsed.time.slice(3, 5)}`,
      });
    case 'daily':
      return t('recurringSchedules.summary.daily', {
        time: formattedTime,
        defaultValue: `Every day ${formattedTime}`,
      });
    case 'weekly':
      return t('recurringSchedules.summary.weekly', {
        days: parsed.weekdays
          .map((day) => {
            const weekdayKey = WEEKDAY_KEYS.find((item) => item.value === day)?.key;
            return weekdayKey ? t(weekdayKey) : day;
          })
          .join(', '),
        time: formattedTime,
        defaultValue: `Every week ${formattedTime}`,
      });
    case 'monthly':
      return t('recurringSchedules.summary.monthly', {
        day: Number(parsed.dayOfMonth),
        time: formattedTime,
        defaultValue: `Every month day ${parsed.dayOfMonth} ${formattedTime}`,
      });
  }
}

function buildDefaultSchedule(task: SyncTask): RecurringSchedule {
  const timezone = getSystemTimezone();
  return normalizeRecurringSchedule({
    id: crypto.randomUUID(),
    cronExpression: '0 9 * * *',
    timezone,
    enabled: true,
    checksumMode: task.checksumMode,
  });
}

function RecurringSchedulesView() {
  const { t } = useTranslation();
  const { tasks, updateTask } = useSyncTasksContext();
  const { showToast } = useToast();
  const [timezones, setTimezones] = useState<string[]>([getSystemTimezone()]);
  const [modalState, setModalState] = useState<ScheduleModalState | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadTimezones = async () => {
      try {
        const nextTimezones = await invoke<string[]>('list_supported_timezones');
        if (!cancelled && Array.isArray(nextTimezones) && nextTimezones.length > 0) {
          setTimezones(nextTimezones);
        }
      } catch (error) {
        console.error('Failed to load supported timezones:', error);
      }
    };

    void loadTimezones();

    return () => {
      cancelled = true;
    };
  }, []);

  const persistSchedules = async (task: SyncTask, nextSchedules: RecurringSchedule[]) => {
    await updateTask(task.id, {
      recurringSchedules: normalizeRecurringSchedules(nextSchedules),
    });
  };

  const handleToggleAllSchedules = async (task: SyncTask) => {
    const schedules = normalizeRecurringSchedules(task.recurringSchedules);
    if (!schedules.length) {
      return;
    }

    const nextEnabled = schedules.some((schedule) => !schedule.enabled);
    try {
      await persistSchedules(
        task,
        schedules.map((schedule) => ({
          ...schedule,
          enabled: nextEnabled,
        })),
      );
      showToast(
        nextEnabled
          ? t('recurringSchedules.toasts.enabledAll')
          : t('recurringSchedules.toasts.disabledAll'),
        'success',
      );
    } catch (error) {
      console.error('Failed to toggle recurring schedules:', error);
      showToast(t('recurringSchedules.toasts.saveFailed'), 'error');
    }
  };

  const handleDeleteAllSchedules = async (task: SyncTask) => {
    const schedules = normalizeRecurringSchedules(task.recurringSchedules);
    if (!schedules.length) {
      return;
    }

    const confirmed = await ask(
      t('recurringSchedules.confirmDeleteAllMessage', { taskName: task.name }),
      {
        title: t('recurringSchedules.confirmDeleteAllTitle'),
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }

    try {
      await persistSchedules(task, []);
      showToast(t('recurringSchedules.toasts.deletedAll'), 'success');
    } catch (error) {
      console.error('Failed to delete recurring schedules:', error);
      showToast(t('recurringSchedules.toasts.deleteFailed'), 'error');
    }
  };

  const handleToggleSchedule = async (task: SyncTask, scheduleId: string) => {
    const schedules = normalizeRecurringSchedules(task.recurringSchedules);
    const nextSchedules = schedules.map((schedule) =>
      schedule.id === scheduleId
        ? { ...schedule, enabled: !schedule.enabled }
        : schedule,
    );

    try {
      await persistSchedules(task, nextSchedules);
      showToast(t('recurringSchedules.toasts.updated'), 'success');
    } catch (error) {
      console.error('Failed to update recurring schedule:', error);
      showToast(t('recurringSchedules.toasts.saveFailed'), 'error');
    }
  };

  const handleDeleteSchedule = async (task: SyncTask, scheduleId: string) => {
    const schedule = normalizeRecurringSchedules(task.recurringSchedules).find(
      (candidate) => candidate.id === scheduleId,
    );
    if (!schedule) {
      return;
    }

    const confirmed = await ask(
      t('recurringSchedules.confirmDeleteMessage', {
        summary: describeRecurringSchedule(schedule, t),
      }),
      {
        title: t('recurringSchedules.confirmDeleteTitle'),
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }

    try {
      await persistSchedules(
        task,
        normalizeRecurringSchedules(task.recurringSchedules).filter(
          (candidate) => candidate.id !== scheduleId,
        ),
      );
      if (modalState?.schedule.id === scheduleId) {
        setModalState(null);
      }
      showToast(t('recurringSchedules.toasts.deleted'), 'success');
    } catch (error) {
      console.error('Failed to delete recurring schedule:', error);
      showToast(t('recurringSchedules.toasts.deleteFailed'), 'error');
    }
  };

  const handleSaveSchedule = async (task: SyncTask, nextSchedule: RecurringSchedule) => {
    const schedules = normalizeRecurringSchedules(task.recurringSchedules);
    const existingIndex = schedules.findIndex((schedule) => schedule.id === nextSchedule.id);
    const nextSchedules = [...schedules];

    if (existingIndex >= 0) {
      nextSchedules.splice(existingIndex, 1, nextSchedule);
    } else {
      nextSchedules.push(nextSchedule);
    }

    try {
      await persistSchedules(task, nextSchedules);
      setModalState(null);
      showToast(t('recurringSchedules.toasts.saved'), 'success');
    } catch (error) {
      console.error('Failed to save recurring schedule:', error);
      showToast(t('recurringSchedules.toasts.saveFailed'), 'error');
      throw error;
    }
  };

  return (
    <div className="space-y-8">
      <FadeIn>
        <header className="flex justify-between items-center mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
          <div>
            <h1 className="text-2xl font-heading font-bold uppercase mb-1">
              {t('recurringSchedules.title')}
            </h1>
            <p className="text-[var(--text-secondary)] font-mono text-sm">
              {tasks.length > 0
                ? `// ${tasks.length} TASK_GROUPS`
                : '// NO_TASKS_DEFINED'}
            </p>
          </div>
          <div className="max-w-md text-right text-sm text-[var(--text-secondary)]">
            {t(RECURRING_RUNTIME_NOTICE_KEY)}
          </div>
        </header>
      </FadeIn>

      {tasks.length === 0 ? (
        <section className="neo-box p-6 bg-[var(--bg-primary)]">
          <div className="flex items-center gap-3 mb-2">
            <IconCalendarRepeat size={28} />
            <h2 className="text-lg font-heading font-black uppercase">
              {t('recurringSchedules.empty.title')}
            </h2>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('recurringSchedules.empty.description')}
          </p>
        </section>
      ) : null}

      <div className="space-y-6">
        {tasks.map((task) => {
          const schedules = normalizeRecurringSchedules(task.recurringSchedules);
          const allEnabled = schedules.length > 0 && schedules.every((schedule) => schedule.enabled);
          return (
            <section
              key={task.id}
              className="border-3 border-[var(--border-main)] bg-sky-200 shadow-[6px_6px_0_0_var(--shadow-color)]"
            >
              <div className="flex items-center gap-4 border-b-3 border-[var(--border-main)] bg-sky-300 px-5 py-4">
                <button
                  type="button"
                  aria-label={
                    allEnabled
                      ? t('recurringSchedules.disableAll')
                      : t('recurringSchedules.enableAll')
                  }
                  className={`h-10 w-10 shrink-0 border-3 border-[var(--border-main)] ${
                    allEnabled ? 'bg-[var(--accent-main)]' : 'bg-white'
                  }`}
                  onClick={() => {
                    void handleToggleAllSchedules(task);
                  }}
                  disabled={!schedules.length}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-3xl font-heading font-black">{task.name}</h2>
                  <p className="text-xs font-mono uppercase tracking-[0.2em]">
                    {t('recurringSchedules.taskSummary', {
                      count: schedules.length,
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={
                      allEnabled
                        ? t('recurringSchedules.disableAll')
                        : t('recurringSchedules.enableAll')
                    }
                    className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
                    onClick={() => {
                      void handleToggleAllSchedules(task);
                    }}
                    disabled={!schedules.length}
                  >
                    {allEnabled ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
                  </button>
                  <button
                    type="button"
                    aria-label={t('recurringSchedules.addSchedule')}
                    className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
                    onClick={() => setModalState({
                      mode: 'create',
                      task,
                      schedule: buildDefaultSchedule(task),
                    })}
                  >
                    <IconPlus size={22} stroke={3} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('recurringSchedules.deleteAll')}
                    className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
                    onClick={() => {
                      void handleDeleteAllSchedules(task);
                    }}
                    disabled={!schedules.length}
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
              </div>

              {schedules.length === 0 ? (
                <div className="px-6 py-5 text-sm font-mono text-[var(--text-secondary)]">
                  {t('recurringSchedules.emptyTaskSchedules')}
                </div>
              ) : (
                <div className="divide-y-3 divide-[var(--border-main)]">
                  {schedules.map((schedule) => {
                    const supportedSchedule = isSupportedGuidedSchedule(schedule);
                    return (
                      <div key={schedule.id} className="flex items-center gap-4 px-5 py-4">
                        <button
                          type="button"
                          aria-label={
                            schedule.enabled
                              ? t('recurringSchedules.disableSchedule')
                              : t('recurringSchedules.enableSchedule')
                          }
                          className={`h-10 w-10 shrink-0 border-3 border-[var(--border-main)] ${
                            schedule.enabled ? 'bg-[var(--accent-main)]' : 'bg-white'
                          }`}
                          onClick={() => {
                            void handleToggleSchedule(task, schedule.id);
                          }}
                        />
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setModalState({
                            mode: 'edit',
                            task,
                            schedule,
                          })}
                        >
                          <div className="truncate text-2xl font-black leading-tight">
                            {describeRecurringSchedule(schedule, t)}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs font-mono uppercase">
                            <span className="border-2 border-[var(--border-main)] bg-white px-2 py-1">
                              {schedule.timezone}
                            </span>
                            <span className="border-2 border-[var(--border-main)] bg-white px-2 py-1">
                              {schedule.checksumMode
                                ? t('recurringSchedules.badges.checksumOn')
                                : t('recurringSchedules.badges.checksumOff')}
                            </span>
                            <span className="border-2 border-[var(--border-main)] bg-white px-2 py-1">
                              {schedule.enabled
                                ? t('recurringSchedules.badges.enabled')
                                : t('recurringSchedules.badges.disabled')}
                            </span>
                            {!supportedSchedule ? (
                              <span className="border-2 border-[var(--accent-error)] bg-red-50 px-2 py-1 text-[var(--accent-error)]">
                                {t('recurringSchedules.badges.unsupported')}
                              </span>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={t('recurringSchedules.editSchedule')}
                          className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
                          onClick={() => setModalState({
                            mode: 'edit',
                            task,
                            schedule,
                          })}
                        >
                          <IconEdit size={18} />
                        </button>
                        <button
                          type="button"
                          aria-label={t('recurringSchedules.deleteSchedule')}
                          className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
                          onClick={() => {
                            void handleDeleteSchedule(task, schedule.id);
                          }}
                        >
                          <IconX size={18} stroke={3} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <RecurringScheduleModal
        modalState={modalState}
        timezones={timezones}
        onClose={() => setModalState(null)}
        onSave={handleSaveSchedule}
      />
    </div>
  );
}

interface RecurringScheduleModalProps {
  modalState: ScheduleModalState | null;
  timezones: string[];
  onClose: () => void;
  onSave: (task: SyncTask, schedule: RecurringSchedule) => Promise<void>;
}

function RecurringScheduleModal({
  modalState,
  timezones,
  onClose,
  onSave,
}: RecurringScheduleModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [preset, setPreset] = useState<Exclude<RecurringSchedulePreset, 'custom'>>('daily');
  const [timeValue, setTimeValue] = useState('09:00');
  const [hourlyMinute, setHourlyMinute] = useState('00');
  const [weekdays, setWeekdays] = useState<string[]>(['1']);
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(getSystemTimezone());
  const [enabled, setEnabled] = useState(true);
  const [checksumMode, setChecksumMode] = useState(false);
  const [retentionCount, setRetentionCount] = useState('20');
  const [history, setHistory] = useState<RecurringScheduleHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReloadNonce, setHistoryReloadNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [unsupportedSchedule, setUnsupportedSchedule] = useState<RecurringSchedule | null>(null);

  useEffect(() => {
    if (!modalState) {
      return;
    }

    const schedule = normalizeRecurringSchedule(modalState.schedule);
    const parsed = parseCronExpressionToBuilder(schedule.cronExpression);
    const builder: ParsedRecurringScheduleBuilder = parsed ?? {
      preset: 'daily',
      time: '09:00',
      weekdays: ['1'],
      dayOfMonth: '1',
    };

    setUnsupportedSchedule(parsed ? null : schedule);
    setPreset(builder.preset);
    setTimeValue(builder.time);
    setHourlyMinute(builder.time.slice(3, 5));
    setWeekdays(builder.weekdays);
    setDayOfMonth(builder.dayOfMonth);
    setCronExpression(schedule.cronExpression);
    setTimezone(schedule.timezone);
    setEnabled(schedule.enabled);
    setChecksumMode(schedule.checksumMode);
    setRetentionCount(String(schedule.retentionCount));
    setErrorMessage(null);
  }, [modalState]);

  useEffect(() => {
    if (!modalState) {
      setHistory([]);
      return;
    }

    let cancelled = false;

    const loadHistory = async () => {
      setHistoryLoading(true);
      try {
        const nextHistory = await invoke<RecurringScheduleHistoryEntry[]>(
          'get_recurring_schedule_history',
          {
            taskId: modalState.task.id,
            scheduleId: modalState.schedule.id,
          },
        );
        if (!cancelled) {
          setHistory(nextHistory);
        }
      } catch (error) {
        console.error('Failed to load recurring schedule history:', error);
        if (!cancelled) {
          setHistory([]);
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [modalState, historyReloadNonce]);

  if (!modalState) {
    return null;
  }

  const applyGuidedCron = (
    nextPreset: Exclude<RecurringSchedulePreset, 'custom'>,
    nextTime: string,
    nextWeekdays: string[],
    nextDayOfMonth: string,
    nextHourlyMinute: string,
  ) => {
    const normalizedMinute = formatMinuteValue(nextHourlyMinute);
    const builderTime = nextPreset === 'hourly' ? `00:${normalizedMinute}` : nextTime;
    const nextCron = buildCronExpressionFromPreset({
      preset: nextPreset,
      time: builderTime,
      weekdays: nextWeekdays,
      dayOfMonth: nextDayOfMonth,
    });
    setPreset(nextPreset);
    setTimeValue(nextTime);
    setHourlyMinute(normalizedMinute);
    setWeekdays(nextWeekdays);
    setDayOfMonth(nextDayOfMonth);
    setCronExpression(nextCron);
    setErrorMessage(null);
  };

  const handleToggleWeekday = (value: string) => {
    const nextWeekdays = weekdays.includes(value)
      ? weekdays.filter((weekday) => weekday !== value)
      : [...weekdays, value];
    applyGuidedCron('weekly', timeValue, nextWeekdays, dayOfMonth, hourlyMinute);
  };

  const handleSave = async () => {
    if (unsupportedSchedule) {
      setErrorMessage(t('recurringSchedules.errors.unsupportedCustom'));
      return;
    }
    if (!timezone) {
      setErrorMessage(t('recurringSchedules.errors.timezoneRequired'));
      return;
    }
    if (preset === 'hourly' && !isValidMinuteValue(hourlyMinute)) {
      setErrorMessage(t('recurringSchedules.errors.hourlyMinuteRange'));
      return;
    }

    const nextCron = buildCronExpressionFromPreset({
      preset,
      time: preset === 'hourly' ? `00:${formatMinuteValue(hourlyMinute)}` : timeValue,
      weekdays,
      dayOfMonth,
    });
    if (!parseCronExpressionToBuilder(nextCron)) {
      setErrorMessage(t('recurringSchedules.errors.unsupportedCustom'));
      return;
    }

    setSaving(true);
    try {
      await onSave(
        modalState.task,
        normalizeRecurringSchedule({
          id: modalState.schedule.id,
          cronExpression: nextCron,
          timezone,
          enabled,
          checksumMode,
          retentionCount: Number(retentionCount),
        }),
      );
    } catch {
      setErrorMessage(t('recurringSchedules.errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const clearHistory = async () => {
    const confirmed = await ask(
      t('recurringSchedules.clearHistoryConfirmMessage'),
      {
        title: t('recurringSchedules.clearHistoryConfirmTitle'),
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }

    try {
      await invoke('clear_recurring_schedule_history', {
        taskId: modalState.task.id,
        scheduleId: modalState.schedule.id,
      });
      setHistory([]);
      showToast(t('recurringSchedules.toasts.historyCleared'), 'success');
    } catch (error) {
      console.error('Failed to clear recurring schedule history:', error);
      showToast(t('recurringSchedules.toasts.clearHistoryFailed'), 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4 overflow-y-auto">
      <CardAnimation>
        <div className="neo-box w-full max-w-4xl bg-[var(--bg-primary)] p-6 border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
          <div className="mb-6 flex items-start justify-between gap-4 border-b-3 border-[var(--border-main)] pb-4">
            <div className="min-w-0">
              <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent-main)]">
                {modalState.task.name}
              </p>
              <h2 className="text-2xl font-heading font-black uppercase">
                {modalState.mode === 'create'
                  ? t('recurringSchedules.modal.addTitle')
                  : t('recurringSchedules.modal.editTitle')}
              </h2>
            </div>
            <button
              type="button"
              aria-label={t('common.close')}
              className="flex h-11 w-11 items-center justify-center border-3 border-[var(--border-main)] bg-white"
              onClick={onClose}
            >
              <IconX size={18} />
            </button>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-3">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                    disabled={unsupportedSchedule !== null}
                  />
                  <span className="font-bold uppercase">{t('recurringSchedules.fields.enabled')}</span>
                </label>
                <label className="flex items-center gap-2 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-3">
                  <input
                    type="checkbox"
                    checked={checksumMode}
                    onChange={(event) => setChecksumMode(event.target.checked)}
                    disabled={unsupportedSchedule !== null}
                  />
                  <span className="font-bold uppercase">{t('recurringSchedules.fields.checksumMode')}</span>
                </label>
              </div>

              {unsupportedSchedule ? (
                <div className="space-y-4">
                  <div className="border-2 border-[var(--accent-error)] bg-red-50 px-4 py-3 text-sm text-[var(--accent-error)]">
                    <div className="font-bold uppercase">
                      {t('recurringSchedules.unsupported.title')}
                    </div>
                    <p className="mt-2">{t('recurringSchedules.unsupported.description')}</p>
                    <p className="mt-2 font-semibold">
                      {t('recurringSchedules.unsupported.deleteHint')}
                    </p>
                  </div>
                  <div>
                    <div className="mb-1 text-sm font-bold uppercase">{t('recurringSchedules.fields.cronPreview')}</div>
                    <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-3 font-mono text-sm">
                      {unsupportedSchedule.cronExpression}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <div className="mb-2 text-sm font-bold uppercase">{t('recurringSchedules.fields.frequency')}</div>
                    <div className="flex flex-wrap gap-2">
                      {(['hourly', 'daily', 'weekly', 'monthly'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={`px-4 py-2 border-2 border-[var(--border-main)] font-bold uppercase ${
                            preset === option ? 'bg-[var(--accent-warning)]' : 'bg-white'
                          }`}
                          onClick={() => applyGuidedCron(option, timeValue, weekdays, dayOfMonth, hourlyMinute)}
                        >
                          {t(`recurringSchedules.presets.${option}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {preset === 'hourly' ? (
                    <label className="block max-w-xs">
                      <span className="mb-1 block text-sm font-bold uppercase">
                        {t('recurringSchedules.fields.minute')}
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        step={1}
                        value={hourlyMinute}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setHourlyMinute(nextValue);
                          if (isValidMinuteValue(nextValue)) {
                            applyGuidedCron('hourly', timeValue, weekdays, dayOfMonth, nextValue);
                          } else {
                            setErrorMessage(t('recurringSchedules.errors.hourlyMinuteRange'));
                          }
                        }}
                        className="neo-input w-full"
                        aria-label={t('recurringSchedules.fields.minute')}
                      />
                      <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                        {t('recurringSchedules.fields.hourlyMinuteHelp')}
                      </span>
                    </label>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-bold uppercase">{t('recurringSchedules.fields.time')}</span>
                        <input
                          type="time"
                          value={timeValue}
                          onChange={(event) => applyGuidedCron(
                            preset,
                            event.target.value,
                            weekdays,
                            dayOfMonth,
                            hourlyMinute,
                          )}
                          className="neo-input w-full"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-bold uppercase">{t('recurringSchedules.fields.timezone')}</span>
                        <select
                          value={timezone}
                          onChange={(event) => setTimezone(event.target.value)}
                          className="neo-input w-full"
                        >
                          {timezones.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}

                  {preset === 'hourly' ? (
                    <label className="block">
                      <span className="mb-1 block text-sm font-bold uppercase">{t('recurringSchedules.fields.timezone')}</span>
                      <select
                        value={timezone}
                        onChange={(event) => setTimezone(event.target.value)}
                        className="neo-input w-full"
                      >
                        {timezones.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {preset === 'weekly' ? (
                    <div>
                      <div className="mb-2 text-sm font-bold uppercase">{t('recurringSchedules.fields.weekdays')}</div>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAY_KEYS.map((weekday) => (
                          <button
                            key={weekday.value}
                            type="button"
                            className={`min-w-12 px-3 py-2 border-2 border-[var(--border-main)] font-bold ${
                              weekdays.includes(weekday.value) ? 'bg-[var(--accent-warning)]' : 'bg-white'
                            }`}
                            onClick={() => handleToggleWeekday(weekday.value)}
                          >
                            {t(weekday.key)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {preset === 'monthly' ? (
                    <label className="block max-w-xs">
                      <span className="mb-1 block text-sm font-bold uppercase">{t('recurringSchedules.fields.dayOfMonth')}</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={dayOfMonth}
                        onChange={(event) => applyGuidedCron('monthly', timeValue, weekdays, event.target.value, hourlyMinute)}
                        className="neo-input w-full"
                      />
                    </label>
                  ) : null}

                  <label className="block max-w-xs">
                    <span className="mb-1 block text-sm font-bold uppercase">{t('recurringSchedules.fields.retentionCount')}</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={retentionCount}
                      onChange={(event) => setRetentionCount(event.target.value)}
                      className="neo-input w-full"
                    />
                  </label>

                  <div>
                    <div className="mb-1 text-sm font-bold uppercase">{t('recurringSchedules.fields.cronPreview')}</div>
                    <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-3 font-mono text-sm">
                      {cronExpression}
                    </div>
                  </div>
                </>
              )}

              {errorMessage ? (
                <div className="border-2 border-[var(--accent-error)] bg-red-50 px-3 py-2 text-sm text-[var(--accent-error)]">
                  {errorMessage}
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)]"
                >
                  {t('common.cancel')}
                </button>
                {!unsupportedSchedule ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSave();
                    }}
                    disabled={saving}
                    className="px-4 py-2 font-bold uppercase bg-[var(--accent-main)] text-white border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none disabled:opacity-60"
                  >
                    {saving ? t('common.loading') : t('common.save')}
                  </button>
                ) : null}
              </div>
            </div>

            <aside className="space-y-4 border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] p-4">
              <div className="flex items-center justify-between gap-3 border-b-2 border-dashed border-[var(--border-main)] pb-3">
                <div>
                  <h3 className="text-lg font-heading font-black uppercase">
                    {t('recurringSchedules.history.title')}
                  </h3>
                  <p className="text-xs font-mono text-[var(--text-secondary)]">
                    {t('recurringSchedules.history.description')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={t('recurringSchedules.history.reload')}
                    className="flex h-10 w-10 items-center justify-center border-2 border-[var(--border-main)] bg-white"
                    onClick={() => setHistoryReloadNonce((current) => current + 1)}
                  >
                    <IconReload size={18} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('recurringSchedules.history.clear')}
                    className="flex h-10 w-10 items-center justify-center border-2 border-[var(--border-main)] bg-white"
                    onClick={() => {
                      void clearHistory();
                    }}
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
              </div>

              {historyLoading ? (
                <div className="text-sm font-mono text-[var(--text-secondary)]">
                  {t('common.loading')}
                </div>
              ) : null}

              {!historyLoading && history.length === 0 ? (
                <div className="text-sm text-[var(--text-secondary)]">
                  {t('recurringSchedules.history.empty')}
                </div>
              ) : null}

              <div className="space-y-3">
                {history.map((entry, index) => (
                  <article
                    key={`${entry.startedAt}-${index}`}
                    className="border-2 border-[var(--border-main)] bg-white p-3 text-sm"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2 py-1 text-xs font-bold uppercase border border-[var(--border-main)] ${
                          entry.status === 'success'
                            ? 'bg-green-200'
                            : 'bg-red-200'
                        }`}
                      >
                        {entry.status === 'success'
                          ? t('recurringSchedules.history.status.success')
                          : t('recurringSchedules.history.status.failure')}
                      </span>
                      <span className="font-mono text-xs text-[var(--text-secondary)]">
                        {formatHistoryTimestamp(entry.scheduledFor, entry.timezone)}
                      </span>
                    </div>
                    <p className="mb-2">{entry.message}</p>
                    <div className="space-y-1 font-mono text-xs text-[var(--text-secondary)]">
                      <div>
                        {t('recurringSchedules.history.startedAt')}:{' '}
                        {formatHistoryTimestamp(entry.startedAt, entry.timezone)}
                      </div>
                      <div>
                        {t('recurringSchedules.history.finishedAt')}:{' '}
                        {formatHistoryTimestamp(entry.finishedAt, entry.timezone)}
                      </div>
                      <div>
                        {t('recurringSchedules.history.conflictCount')}:{' '}
                        {entry.conflictCount}
                      </div>
                      {entry.errorDetail ? (
                        <div className="whitespace-pre-wrap text-[var(--accent-error)]">
                          {entry.errorDetail}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </aside>
          </div>
        </div>
      </CardAnimation>
    </div>
  );
}

export default RecurringSchedulesView;
