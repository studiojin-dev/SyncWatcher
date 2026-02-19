import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import ConflictReviewWindow from './ConflictReviewWindow';

const showToastMock = vi.fn();
const closeWindowMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    close: closeWindowMock,
  })),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ settings: { dataUnitSystem: 'binary' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? '',
  }),
}));

function buildSession() {
  return {
    id: 'session-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    sourceRoot: '/src',
    targetRoot: '/dst',
    origin: 'manual',
    createdAtUnixMs: 1_700_000_000_000,
    totalCount: 1,
    pendingCount: 1,
    resolvedCount: 0,
    items: [
      {
        id: 'item-1',
        relativePath: 'a.txt',
        sourcePath: '/src/a.txt',
        targetPath: '/dst/a.txt',
        source: { size: 10, modifiedUnixMs: 1_700_000_000_000, createdUnixMs: null },
        target: { size: 11, modifiedUnixMs: 1_700_000_000_500, createdUnixMs: null },
        status: 'pending',
        note: null,
        resolvedAtUnixMs: null,
      },
    ],
  };
}

describe('ConflictReviewWindow', () => {
  const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
  const mockAsk = ask as unknown as ReturnType<typeof vi.fn>;
  const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
  const mockGetCurrentWindow = getCurrentWebviewWindow as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/?view=conflict-review&sessionId=session-1');
    mockAsk.mockResolvedValue(true);
    mockListen.mockResolvedValue(() => {});
    mockGetCurrentWindow.mockReturnValue({ close: closeWindowMock });
    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_conflict_review_session') {
        return buildSession();
      }
      if (command === 'get_conflict_item_preview') {
        return {
          kind: 'other',
          sourceText: null,
          targetText: null,
          sourceTruncated: false,
          targetTruncated: false,
        };
      }
      if (command === 'close_conflict_review_session') {
        if (args?.forceSkipPending) {
          return { closed: true, hadPending: true, skippedCount: 1 };
        }
        return { closed: false, hadPending: true, skippedCount: 0 };
      }
      if (command === 'resolve_conflict_items') {
        return {
          sessionId: 'session-1',
          requestedCount: 1,
          processedCount: 1,
          pendingCount: 0,
          failures: [],
        };
      }
      return null;
    });
  });

  it('closes with confirmation when pending items remain', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      const closeCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'close_conflict_review_session');
      expect(closeCalls).toHaveLength(2);
    });
    expect(closeWindowMock).toHaveBeenCalled();
  });

  it('invokes skip action for selected items', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /아무것도 안함/i }));

    await waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([command]) => command === 'resolve_conflict_items')
      ).toBe(true);
    });
  });
});
