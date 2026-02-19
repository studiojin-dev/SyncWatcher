import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConflictSessionListPanel from './ConflictSessionListPanel';
import type { ConflictSessionSummary } from '../../types/syncEngine';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; count?: number }) => {
      if (options?.defaultValue) return options.defaultValue;
      if (typeof options?.count === 'number') return String(options.count);
      return '';
    },
  }),
}));

function buildSession(overrides: Partial<ConflictSessionSummary> = {}): ConflictSessionSummary {
  return {
    id: 'session-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    sourceRoot: '/src',
    targetRoot: '/dst',
    origin: 'manual',
    createdAtUnixMs: 1_700_000_000_000,
    totalCount: 2,
    pendingCount: 1,
    resolvedCount: 1,
    ...overrides,
  };
}

describe('ConflictSessionListPanel', () => {
  it('renders empty state', () => {
    render(
      <ConflictSessionListPanel
        sessions={[]}
        loading={false}
        onRefresh={vi.fn()}
        onOpenSession={vi.fn()}
      />
    );

    expect(screen.getByText('대기 중인 충돌 세션이 없습니다.')).toBeInTheDocument();
  });

  it('calls callbacks for refresh and open', () => {
    const onRefresh = vi.fn();
    const onOpenSession = vi.fn();
    render(
      <ConflictSessionListPanel
        sessions={[buildSession()]}
        loading={false}
        onRefresh={onRefresh}
        onOpenSession={onOpenSession}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    fireEvent.click(screen.getByRole('button', { name: /검토 창 열기/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
  });
});
