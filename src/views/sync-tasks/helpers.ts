import { useSyncTaskStatusStore } from '../../hooks/useSyncTaskStatus';
import type { TargetPreflightInfo } from '../../types/syncEngine';
import type { RuntimeTaskValidationIssue } from '../../types/runtime';

export interface VolumeInfo {
  name: string;
  mount_point: string;
  total_bytes: number | null;
  available_bytes: number | null;
  is_network: boolean;
  is_removable: boolean;
  volume_uuid?: string;
  disk_uuid?: string;
  device_serial?: string;
  media_uuid?: string;
  device_guid?: string;
  transport_serial?: string;
  bus_protocol?: string;
  filesystem_name?: string;
}

export type SubView =
  | { kind: 'list' }
  | { kind: 'logs'; taskId: string; taskName: string }
  | {
      kind: 'orphans';
      taskId: string;
      source: string;
      target: string;
      excludePatterns: string[];
    }
  | { kind: 'sync'; taskId: string; taskName: string }
  | { kind: 'dryRun'; taskId: string; taskName: string };

export interface CancelConfirmState {
  type: 'sync' | 'dryRun';
  taskId: string;
}

export type TranslateFn = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export type ShowToastFn = (message: string, type?: ToastType) => void;

export const WATCH_STATE_TIMEOUT_MS = 3000;

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function getValidationSummary(
  issue: RuntimeTaskValidationIssue,
  t: TranslateFn,
): string {
  switch (issue.code) {
    case 'sourceTargetOverlap':
      return t('syncTasks.errors.sourceEqualsTarget', {
        defaultValue: 'Source and target cannot overlap.',
      });
    case 'duplicateTarget':
      return t('syncTasks.errors.duplicateTarget', {
        defaultValue: 'Target conflicts with another task target.',
      });
    case 'targetSubdirConflict':
      return t('syncTasks.errors.targetSubdirConflict', {
        defaultValue: 'Target cannot be parent/child of another task target.',
      });
    case 'watchCycle':
      return t('syncTasks.errors.watchCycle', {
        defaultValue: 'Watch tasks cannot form a cycle.',
      });
    case 'invalidInput':
    default:
      return t('syncTasks.errors.invalidInput', {
        defaultValue: 'Task configuration is invalid.',
      });
  }
}

export function getValidationRuleDescription(
  issue: RuntimeTaskValidationIssue,
  t: TranslateFn,
): string {
  switch (issue.code) {
    case 'sourceTargetOverlap':
      return t('syncTasks.validationModal.ruleDescriptions.sourceTargetOverlap', {
        defaultValue:
          'Within one task, source and target cannot point to the same path or parent/child paths.',
      });
    case 'duplicateTarget':
      return t(
        'syncTasks.validationModal.ruleDescriptions.duplicateTarget',
        {
          defaultValue:
            'Different tasks cannot share the same target directory because ownership and cleanup become ambiguous.',
        },
      );
    case 'targetSubdirConflict':
      return t(
        'syncTasks.validationModal.ruleDescriptions.targetSubdirConflict',
        {
          defaultValue:
            'Different task targets cannot be nested because parent/child target trees can overwrite or hide each other.',
        },
      );
    case 'watchCycle':
      return t('syncTasks.validationModal.ruleDescriptions.watchCycle', {
        defaultValue:
          'Watch-enabled tasks must stay one-way. Cycles are rejected because they can trigger endless sync loops.',
      });
    case 'invalidInput':
    default:
      return t('syncTasks.validationModal.ruleDescriptions.invalidInput', {
        defaultValue:
          'The task payload could not be validated. Check the selected source and target values and try again.',
      });
  }
}

export function showTargetPreflightToast(
  preflight: TargetPreflightInfo | null | undefined,
  showToast: ShowToastFn,
  t: TranslateFn,
) {
  if (!preflight || preflight.kind === 'ready') {
    return;
  }

  if (preflight.kind === 'willCreateDirectory') {
    showToast(
      t('syncTasks.targetDirectoryWillBeCreated', {
        path: preflight.path,
        defaultValue:
          '대상 디렉터리가 아직 없어 실제 동기화 시 생성됩니다: {{path}}',
      }),
      'warning',
    );
    return;
  }

  showToast(
    t('syncTasks.targetDirectoryCreated', {
      path: preflight.path,
      defaultValue: '대상 디렉터리를 생성한 뒤 동기화를 진행했습니다: {{path}}',
    }),
    'warning',
  );
}

export async function waitForWatchState(
  taskId: string,
  watching: boolean,
  timeoutMs: number = WATCH_STATE_TIMEOUT_MS,
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const current = useSyncTaskStatusStore
      .getState()
      .watchingTaskIds.has(taskId);
    if (current === watching) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return (
    useSyncTaskStatusStore.getState().watchingTaskIds.has(taskId) === watching
  );
}
