import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
          skipped_count: 0,
          failures: [],
        };
      }
      return null;
    });
  });

  it('does not rescan for same logical inputs with new array references', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src"
        target="/dst"
        excludePatterns={['*.tmp', '*.log']}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src"
        target="/dst"
        excludePatterns={['*.tmp', '*.log']}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });
  });

  it('rescans when exclude pattern content changes', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src"
        target="/dst"
        excludePatterns={['*.tmp']}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src"
        target="/dst"
        excludePatterns={['*.tmp', '*.log']}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(2);
    });
  });

  it('rescans when source, target, or task id changes', async () => {
    const { rerender } = render(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src"
        target="/dst"
        excludePatterns={[]}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(1);
    });

    rerender(
      <OrphanFilesModal
        opened
        taskId="task-1"
        source="/src-next"
        target="/dst"
        excludePatterns={[]}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(findOrphanCalls()).toHaveLength(2);
    });
  });
});
