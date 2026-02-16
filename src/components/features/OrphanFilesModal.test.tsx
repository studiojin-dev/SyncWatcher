import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import OrphanFilesModal from './OrphanFilesModal';

const showToastMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(),
}));

vi.mock('../ui/Animations', () => ({
  CardAnimation: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockAsk = ask as unknown as ReturnType<typeof vi.fn>;

function findOrphanCalls() {
  return mockInvoke.mock.calls.filter(([command]) => command === 'find_orphan_files');
}

describe('OrphanFilesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'find_orphan_files') {
        return [];
      }
      if (command === 'delete_orphan_files') {
        return {
          deleted_count: 0,
          deleted_files_count: 0,
          deleted_dirs_count: 0,
          skipped_count: 0,
          failures: [],
        };
      }
      return null;
    });

    mockAsk.mockResolvedValue(false);
  });

  it('does not rescan for same logical inputs with new array references', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={['*.tmp', '*.log']}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={['*.tmp', '*.log']}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });
  });

  it('rescans when exclude pattern content changes', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={['*.tmp']}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={['*.tmp', '*.log']}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(2);
    });
  });

  it('rescans when source, target, or task id changes', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={[]}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        taskId="task-2"
        source="/source-next"
        target="/target"
        excludePatterns={[]}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(2);
    });
  });

  it('shows split delete counts in success toast', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'find_orphan_files') {
        return [
          { path: 'stale', size: 0, is_dir: true },
        ];
      }
      if (command === 'delete_orphan_files') {
        return {
          deleted_count: 3,
          deleted_files_count: 2,
          deleted_dirs_count: 1,
          skipped_count: 0,
          failures: [],
        };
      }
      return null;
    });
    mockAsk.mockResolvedValue(true);

    render(
      <OrphanFilesModal
        taskId="task-1"
        source="/source"
        target="/target"
        excludePatterns={[]}
        onBack={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalled();
    });

    const lastToastArgs = showToastMock.mock.calls[showToastMock.mock.calls.length - 1];
    expect(lastToastArgs?.[0]).toContain('Deleted files 2, dirs 1');
  });
});
