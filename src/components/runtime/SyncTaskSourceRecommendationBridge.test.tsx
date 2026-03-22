import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import SyncTaskSourceRecommendationBridge from './SyncTaskSourceRecommendationBridge';

const {
  updateTaskMock,
  showToastMock,
  tasksState,
} = vi.hoisted(() => {
  const updateTaskMock = vi.fn();
  const showToastMock = vi.fn();
  const tasksState = {
    loaded: true,
    tasks: [
      {
        id: 'task-1',
        name: 'Task 1',
        source: '[DISK_UUID:old-disk]/DCIM',
        target: '/tmp/target',
        checksumMode: false,
        verifyAfterCopy: true,
        exclusionSets: [],
        watchMode: false,
        autoUnmount: false,
        sourceType: 'uuid',
        sourceUuid: 'old-disk',
        sourceUuidType: 'disk',
        sourceSubPath: '/DCIM',
      },
    ],
    updateTask: updateTaskMock,
  };
  return {
    updateTaskMock,
    showToastMock,
    tasksState,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../../context/SyncTasksContext', () => ({
  useSyncTasksContext: () => tasksState,
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
const eventHandlers = new Map<string, (event: { payload?: unknown }) => void>();

function recommendationEnvelope() {
  return {
    recommendations: [
      {
        taskId: 'task-1',
        taskName: 'Task 1',
        currentUuid: 'old-disk',
        currentUuidType: 'disk',
        proposedUuid: 'new-disk',
        proposedUuidType: 'disk',
        suggestedSource: '[DISK_UUID:new-disk]/DCIM',
        proposedMountPoint: '/Volumes/CardA',
        proposedVolumeName: 'Card A',
        confidenceLabel: 'high',
        evidence: ['device serial matched'],
      },
    ],
  };
}

describe('SyncTaskSourceRecommendationBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload?: unknown }) => void) => {
      eventHandlers.set(eventName, handler);
      return () => {
        eventHandlers.delete(eventName);
      };
    });
    invokeMock.mockResolvedValue(recommendationEnvelope());
    updateTaskMock.mockResolvedValue(undefined);
  });

  it('fetches recommendations on startup and on volumes-changed', async () => {
    render(<SyncTaskSourceRecommendationBridge />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('find_sync_task_source_recommendations');
    });

    const handler = eventHandlers.get('volumes-changed');
    if (!handler) {
      throw new Error('volumes-changed handler not found');
    }

    act(() => {
      handler({});
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });
  });

  it('renders recommendations and updates the task via existing updateTask', async () => {
    render(<SyncTaskSourceRecommendationBridge />);

    await waitFor(() => {
      expect(screen.getByText('Task 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Update Task'));

    await waitFor(() => {
      expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
        source: '[DISK_UUID:new-disk]/DCIM',
        sourceType: 'uuid',
        sourceUuid: 'new-disk',
        sourceUuidType: 'disk',
        sourceSubPath: '/DCIM',
      });
    });
  });

  it('dismisses a recommendation without mutating the task', async () => {
    render(<SyncTaskSourceRecommendationBridge />);

    await waitFor(() => {
      expect(screen.getByText('Task 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dismiss'));

    await waitFor(() => {
      expect(screen.queryByText('Task 1')).not.toBeInTheDocument();
    });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('opens the task editor through the provided callback', async () => {
    const onOpenTaskEditor = vi.fn();
    render(
      <SyncTaskSourceRecommendationBridge onOpenTaskEditor={onOpenTaskEditor} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Open Task Editor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Open Task Editor'));

    expect(onOpenTaskEditor).toHaveBeenCalledWith('task-1');
  });
});
