import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import SyncTaskList from './SyncTaskList';
import type { SyncTask } from '../../hooks/useSyncTasks';
import type { TaskStatus } from '../../hooks/useSyncTaskStatus';

vi.mock('../../components/ui/Animations', () => ({
  CardAnimation: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/features/ConflictSessionListPanel', () => ({
  default: () => null,
}));

function buildTask(overrides?: Partial<SyncTask>): SyncTask {
  return {
    id: 'task-1',
    name: 'Task 1',
    source: '/tmp/source',
    target: '/tmp/target',
    checksumMode: false,
    watchMode: true,
    autoUnmount: false,
    verifyAfterCopy: true,
    exclusionSets: [],
    ...overrides,
  };
}

function renderList(taskStatus?: TaskStatus) {
  const tasks = [buildTask()];
  const statuses = new Map<string, TaskStatus>();
  if (taskStatus) {
    statuses.set('task-1', taskStatus);
  }

  render(
    <SyncTaskList
      tasks={tasks}
      statuses={statuses}
      dryRunSessions={new Map()}
      watchingTaskIds={new Set(taskStatus?.status === 'watching' ? ['task-1'] : [])}
      queuedTaskIds={new Set(taskStatus?.status === 'queued' ? ['task-1'] : [])}
      watchTogglePendingIds={new Set()}
      syncing={null}
      conflictSessions={[]}
      conflictSessionsLoading={false}
      dataUnitSystem="binary"
      getPatternsForSets={() => []}
      t={(key, options) => (typeof options?.defaultValue === 'string' ? options.defaultValue : key)}
      onRefreshConflictSessions={vi.fn()}
      onOpenConflictSession={vi.fn()}
      onDryRun={vi.fn()}
      onSync={vi.fn()}
      onToggleWatchMode={vi.fn()}
      onEditTask={vi.fn()}
      onDeleteTask={vi.fn()}
      onShowOrphans={vi.fn()}
      onShowLogs={vi.fn()}
    />,
  );
}

describe('SyncTaskList status fallback', () => {
  it('shows watching fallback when no log exists yet', () => {
    renderList({
      taskId: 'task-1',
      status: 'watching',
    });

    expect(screen.getByText('Watching for changes...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for logs...')).not.toBeInTheDocument();
  });

  it('shows queued fallback when watch sync is queued without a log', () => {
    renderList({
      taskId: 'task-1',
      status: 'queued',
    });

    expect(screen.getByText('Queued for watch sync...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for logs...')).not.toBeInTheDocument();
  });
});
