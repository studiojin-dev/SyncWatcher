import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncTasksContext } from '../../context/SyncTasksContext';
import { useToast } from '../ui/Toast';
import { listenConfigStoreChanged } from '../../utils/configStore';
import SyncTaskSourceRecommendationModal from '../features/SyncTaskSourceRecommendationModal';
import {
  buildRecommendationTaskUpdate,
  recommendationKey,
  type SyncTaskSourceRecommendation,
  type SyncTaskSourceRecommendationsEnvelope,
} from '../../utils/syncTaskSourceRecommendations';

interface SyncTaskSourceRecommendationBridgeProps {
  reviewRequestTaskId?: string | null;
  reviewRequestNonce?: number;
  onReviewRequestHandled?: () => void;
  onOpenTaskEditor?: (taskId: string) => void;
}

function SyncTaskSourceRecommendationBridge({
  reviewRequestTaskId,
  reviewRequestNonce,
  onReviewRequestHandled,
  onOpenTaskEditor,
}: SyncTaskSourceRecommendationBridgeProps) {
  const { loaded, tasks, updateTask } = useSyncTasksContext();
  const { showToast } = useToast();
  const [recommendations, setRecommendations] = useState<
    SyncTaskSourceRecommendation[]
  >([]);
  const [open, setOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());
  const lastRefreshSignatureRef = useRef<string>('');
  const requestHandledRef = useRef<number>(0);

  const visibleRecommendations = useMemo(
    () =>
      recommendations.filter(
        (recommendation) => !dismissedKeys.has(recommendationKey(recommendation)),
      ),
    [dismissedKeys, recommendations],
  );

  const loadRecommendations = useCallback(
    async (reason: 'background' | 'request') => {
      const envelope = await invoke<SyncTaskSourceRecommendationsEnvelope>(
        'find_sync_task_source_recommendations',
      );
      const nextRecommendations = envelope.recommendations.filter((recommendation) =>
        tasks.some((task) => task.id === recommendation.taskId),
      );
      const nextSignature = nextRecommendations
        .map((recommendation) => recommendationKey(recommendation))
        .sort()
        .join('|');

      if (lastRefreshSignatureRef.current !== nextSignature) {
        lastRefreshSignatureRef.current = nextSignature;
        setDismissedKeys((previous) => {
          const next = new Set<string>();
          for (const recommendation of nextRecommendations) {
            const key = recommendationKey(recommendation);
            if (previous.has(key)) {
              next.add(key);
            }
          }
          return next;
        });
      }

      setRecommendations(nextRecommendations);

      if (reason === 'request') {
        setFocusedTaskId(reviewRequestTaskId ?? null);
      }

      if (nextRecommendations.length > 0) {
        setOpen(true);
      } else if (reason === 'request') {
        showToast('현재 제안할 수 있는 UUID 업데이트가 없습니다.', 'info');
      }
    },
    [reviewRequestTaskId, showToast, tasks],
  );

  useEffect(() => {
    if (!loaded) {
      return;
    }

    void loadRecommendations('background');

    let disposed = false;
    const unlistenConfigPromise = listenConfigStoreChanged(['syncTasks'], () => {
      if (!disposed) {
        void loadRecommendations('background');
      }
    });
    const unlistenVolumesPromise = listen('volumes-changed', () => {
      if (!disposed) {
        void loadRecommendations('background');
      }
    });

    return () => {
      disposed = true;
      void unlistenConfigPromise.then((unlisten) => unlisten());
      void unlistenVolumesPromise.then((unlisten) => unlisten());
    };
  }, [loaded, loadRecommendations]);

  useEffect(() => {
    if (!loaded || !reviewRequestNonce || requestHandledRef.current === reviewRequestNonce) {
      return;
    }

    requestHandledRef.current = reviewRequestNonce;
    void loadRecommendations('request').finally(() => {
      onReviewRequestHandled?.();
    });
  }, [loaded, loadRecommendations, onReviewRequestHandled, reviewRequestNonce]);

  useEffect(() => {
    if (open && visibleRecommendations.length === 0) {
      setOpen(false);
      setFocusedTaskId(null);
    }
  }, [open, visibleRecommendations.length]);

  const handleUpdate = useCallback(
    async (recommendation: SyncTaskSourceRecommendation) => {
      const task = tasks.find((candidate) => candidate.id === recommendation.taskId);
      if (!task) {
        showToast('SyncTask를 찾을 수 없습니다.', 'error');
        return;
      }

      setBusyTaskId(recommendation.taskId);
      try {
        await updateTask(
          recommendation.taskId,
          buildRecommendationTaskUpdate(task, recommendation),
        );
        showToast(`UUID source updated: ${recommendation.taskName}`, 'success');
        await loadRecommendations('background');
      } catch (error) {
        showToast(String(error), 'error');
      } finally {
        setBusyTaskId(null);
      }
    },
    [loadRecommendations, showToast, tasks, updateTask],
  );

  const handleDismiss = useCallback((recommendation: SyncTaskSourceRecommendation) => {
    setDismissedKeys((previous) => {
      const next = new Set(previous);
      next.add(recommendationKey(recommendation));
      return next;
    });
  }, []);

  const handleOpenTaskEditor = useCallback(
    (taskId: string) => {
      setOpen(false);
      setFocusedTaskId(taskId);
      onOpenTaskEditor?.(taskId);
    },
    [onOpenTaskEditor],
  );

  return (
    <SyncTaskSourceRecommendationModal
      opened={open && visibleRecommendations.length > 0}
      recommendations={visibleRecommendations}
      busyTaskId={busyTaskId}
      focusedTaskId={focusedTaskId}
      onUpdate={(recommendation) => {
        void handleUpdate(recommendation);
      }}
      onDismiss={handleDismiss}
      onOpenTaskEditor={handleOpenTaskEditor}
      onClose={() => {
        setOpen(false);
        setFocusedTaskId(null);
      }}
    />
  );
}

export default SyncTaskSourceRecommendationBridge;
