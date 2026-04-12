import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import ConflictReviewWindow from './ConflictReviewWindow';

const showToastMock = vi.fn();
const closeWindowMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
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
    t: (
      key: string,
      options?: { defaultValue?: string; count?: number }
    ) => {
      const templates: Record<string, string> = {
        'conflict.partialFailure': '{{count}}개 항목 처리에 실패했습니다.',
        'conflict.actionComplete': '{{count}}개 항목을 처리했습니다.',
      };
      const template = templates[key] ?? options?.defaultValue ?? '';
      return template.replace('{{count}}', String(options?.count ?? '{{count}}'));
    },
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
  const mockOpenPath = openPath as unknown as ReturnType<typeof vi.fn>;
  const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
  const mockGetCurrentWindow = getCurrentWebviewWindow as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/?view=conflict-review&sessionId=session-1');
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

  it('opens in-app confirmation before force-skipping pending items on close', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      const closeCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'close_conflict_review_session');
      expect(closeCalls).toHaveLength(1);
    });
    expect(
      await screen.findByText('미처리 항목이 있습니다. 남은 항목을 이번 실행에서 건너뛰고 닫을까요?')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '예' }));

    await waitFor(() => {
      const closeCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'close_conflict_review_session');
      expect(closeCalls).toHaveLength(2);
    });
    expect(closeWindowMock).toHaveBeenCalledTimes(1);
  });

  it('does not close when pending close confirmation is cancelled', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(
      await screen.findByText('미처리 항목이 있습니다. 남은 항목을 이번 실행에서 건너뛰고 닫을까요?')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '아니요' }));

    await waitFor(() => {
      const closeCalls = mockInvoke.mock.calls.filter((call) => call[0] === 'close_conflict_review_session');
      expect(closeCalls).toHaveLength(1);
    });
    expect(closeWindowMock).not.toHaveBeenCalled();
  });

  it('opens skip confirmation and cancels without invoking conflict resolution', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /아무것도 안함/i }));

    expect(
      await screen.findByText('이번 실행에서 건너뜁니다. 다음 동기화 시 다시 충돌할 수 있습니다. 계속할까요?')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '아니요' }));

    await waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([command]) => command === 'resolve_conflict_items')
      ).toBe(false);
    });
  });

  it('invokes skip action for selected items after confirming in-app dialog', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /아무것도 안함/i }));

    expect(
      await screen.findByText('이번 실행에서 건너뜁니다. 다음 동기화 시 다시 충돌할 수 있습니다. 계속할까요?')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '예' }));

    await waitFor(() => {
      expect(
        mockInvoke.mock.calls.some(([command]) => command === 'resolve_conflict_items')
      ).toBe(true);
    });
    expect(showToastMock).toHaveBeenCalledWith('1개 항목을 처리했습니다.', 'success');
  });

  it('invokes force copy only after confirming in-app dialog', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /강제 복사/i }));

    expect(
      await screen.findByText('강제 복사는 되돌릴 수 없습니다. 계속할까요?')
    ).toBeInTheDocument();
    expect(
      mockInvoke.mock.calls.some(([command]) => command === 'resolve_conflict_items')
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '예' }));

    await waitFor(() => {
      const resolutionCall = mockInvoke.mock.calls.find(([command]) => command === 'resolve_conflict_items');
      expect(resolutionCall?.[1]).toMatchObject({
        sessionId: 'session-1',
        resolutions: [{ itemId: 'item-1', action: 'forceCopy' }],
      });
    });
  });

  it('invokes rename-then-copy only after confirming in-app dialog', async () => {
    render(<ConflictReviewWindow />);

    await screen.findByText('타겟 최신 파일 검토');
    fireEvent.click(screen.getByRole('button', { name: /이름 변경 후 복사/i }));

    expect(
      await screen.findByText('타겟 파일을 안전 이름으로 변경 후 복사합니다. 계속할까요?')
    ).toBeInTheDocument();
    expect(
      mockInvoke.mock.calls.some(([command]) => command === 'resolve_conflict_items')
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '예' }));

    await waitFor(() => {
      const resolutionCall = mockInvoke.mock.calls.find(([command]) => command === 'resolve_conflict_items');
      expect(resolutionCall?.[1]).toMatchObject({
        sessionId: 'session-1',
        resolutions: [{ itemId: 'item-1', action: 'renameThenCopy' }],
      });
    });
  });

  it('closes immediately when current session is already missing', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_conflict_review_session') {
        throw new Error('Conflict session not found: session-1');
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
        return { closed: true, hadPending: false, skippedCount: 0 };
      }
      return null;
    });

    render(<ConflictReviewWindow />);
    await screen.findByText('선택된 세션이 없습니다.');

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      expect(closeWindowMock).toHaveBeenCalled();
    });
    expect(
      mockInvoke.mock.calls.some(([command]) => command === 'close_conflict_review_session')
    ).toBe(false);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('closes window when close command races with already-removed session', async () => {
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
        throw new Error('Conflict session not found: session-1');
      }
      return null;
    });

    render(<ConflictReviewWindow />);
    await screen.findByText('타겟 최신 파일 검토');

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    await waitFor(() => {
      expect(closeWindowMock).toHaveBeenCalled();
    });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows media fallback when image preview fails to load', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_conflict_review_session') {
        return buildSession();
      }
      if (command === 'get_conflict_item_preview') {
        return {
          kind: 'image',
          sourceText: null,
          targetText: null,
          sourceTruncated: false,
          targetTruncated: false,
        };
      }
      return null;
    });

    render(<ConflictReviewWindow />);

    const sourceImage = await screen.findByAltText('source preview');
    fireEvent.error(sourceImage);

    expect(
      await screen.findByText('미리보기를 불러오지 못했습니다. 아래 버튼으로 OS 기본 앱에서 확인하세요.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Source 열기' }));
    expect(mockOpenPath).toHaveBeenCalledWith('/src/a.txt');
  });
});
