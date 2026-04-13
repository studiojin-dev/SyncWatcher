import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openPath } from '@tauri-apps/plugin-opener';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CardAnimation } from '../ui/Animations';
import { useToast } from '../ui/Toast';
import { useSettings } from '../../hooks/useSettings';
import { formatBytes } from '../../utils/formatBytes';
import type {
  CloseConflictReviewSessionResult,
  ConflictPreviewPayload,
  ConflictResolutionResult,
  ConflictSessionDetail,
  TargetNewerConflictItem,
} from '../../types/syncEngine';

interface ConflictReviewOpenSessionEvent {
  sessionId: string;
}

interface ConflictReviewSessionUpdatedEvent {
  sessionId: string;
}

interface LinePair {
  index: number;
  source: string;
  target: string;
  changed: boolean;
}

type ConfirmTone = 'danger' | 'warning' | 'info';

interface ResolveConfirmRequest {
  type: 'resolve';
  sessionId: string;
  action: 'forceCopy' | 'renameThenCopy' | 'skip';
  itemIds: string[];
  title: string;
  message: string;
  tone: ConfirmTone;
}

interface CloseConfirmRequest {
  type: 'close';
  sessionId: string;
  title: string;
  message: string;
  tone: ConfirmTone;
}

type ConfirmRequest = ResolveConfirmRequest | CloseConfirmRequest;

function getInitialSessionId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('sessionId');
}

function formatDate(value: number | null): string {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

function buildLinePairs(sourceText: string, targetText: string): LinePair[] {
  const left = sourceText.split('\n');
  const right = targetText.split('\n');
  const max = Math.max(left.length, right.length);
  const rows: LinePair[] = [];
  for (let index = 0; index < max; index += 1) {
    const source = left[index] ?? '';
    const target = right[index] ?? '';
    rows.push({
      index,
      source,
      target,
      changed: source !== target,
    });
  }
  return rows;
}

function isPending(item: TargetNewerConflictItem): boolean {
  return item.status === 'pending';
}

function isSessionNotFoundError(error: unknown): boolean {
  return String(error).includes('Conflict session not found');
}

export default function ConflictReviewWindow() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { settings } = useSettings();
  const [sessionId, setSessionId] = useState<string | null>(() => getInitialSessionId());
  const [session, setSession] = useState<ConflictSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConflictPreviewPayload | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sourceMediaPreviewFailed, setSourceMediaPreviewFailed] = useState(false);
  const [targetMediaPreviewFailed, setTargetMediaPreviewFailed] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const clearSessionState = useCallback(() => {
    setSession(null);
    setSelectedIds(new Set());
    setFocusedItemId(null);
    setSessionId(null);
    setConfirmRequest(null);

    const params = new URLSearchParams(window.location.search);
    params.set('view', 'conflict-review');
    params.delete('sessionId');
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  const loadSession = useCallback(async (nextSessionId: string | null) => {
    if (!nextSessionId) {
      clearSessionState();
      return;
    }

    setLoading(true);
    try {
      const detail = await invoke<ConflictSessionDetail>('get_conflict_review_session', {
        sessionId: nextSessionId,
      });
      setSession(detail);
      const pendingItems = detail.items.filter(isPending);
      setSelectedIds(new Set(pendingItems.map((item) => item.id)));
      setFocusedItemId(pendingItems[0]?.id ?? detail.items[0]?.id ?? null);
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        clearSessionState();
      } else {
        showToast(String(error), 'error');
        setSession(null);
        setSelectedIds(new Set());
        setFocusedItemId(null);
      }
    } finally {
      setLoading(false);
    }
  }, [clearSessionState, showToast]);

  useEffect(() => {
    void loadSession(sessionId);
  }, [loadSession, sessionId]);

  useEffect(() => {
    if (!focusedItemId || !sessionId) {
      setPreview(null);
      setSourceMediaPreviewFailed(false);
      setTargetMediaPreviewFailed(false);
      return;
    }

    let cancelled = false;
    const fetchPreview = async () => {
      setPreviewLoading(true);
      setSourceMediaPreviewFailed(false);
      setTargetMediaPreviewFailed(false);
      try {
        const data = await invoke<ConflictPreviewPayload>('get_conflict_item_preview', {
          sessionId,
          itemId: focusedItemId,
          maxBytes: 128 * 1024,
        });
        if (!cancelled) {
          setPreview(data);
        }
      } catch (error) {
        if (!cancelled) {
          setPreview(null);
          if (!isSessionNotFoundError(error)) {
            showToast(String(error), 'warning');
          }
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };
    void fetchPreview();

    return () => {
      cancelled = true;
    };
  }, [focusedItemId, sessionId, showToast]);

  useEffect(() => {
    const unlistenOpenPromise = listen<ConflictReviewOpenSessionEvent>(
      'conflict-review-open-session',
      async (event) => {
        const nextId = event.payload.sessionId;
        setSessionId(nextId);
        const params = new URLSearchParams(window.location.search);
        params.set('view', 'conflict-review');
        params.set('sessionId', nextId);
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
    );

    const unlistenUpdatedPromise = listen<ConflictReviewSessionUpdatedEvent>(
      'conflict-review-session-updated',
      async (event) => {
        if (event.payload.sessionId === sessionId) {
          await loadSession(sessionId);
        }
      }
    );

    return () => {
      void unlistenOpenPromise.then((fn) => fn());
      void unlistenUpdatedPromise.then((fn) => fn());
    };
  }, [loadSession, sessionId]);

  const focusedItem = useMemo(() => {
    if (!session || !focusedItemId) return null;
    return session.items.find((item) => item.id === focusedItemId) ?? null;
  }, [focusedItemId, session]);

  const linePairs = useMemo(() => {
    if (!preview || preview.kind !== 'text') return [];
    const sourceText = preview.sourceText ?? '';
    const targetText = preview.targetText ?? '';
    return buildLinePairs(sourceText, targetText);
  }, [preview]);

  const pendingItems = useMemo(
    () => session?.items.filter((item) => item.status === 'pending') ?? [],
    [session]
  );

  const selectedPendingItems = useMemo(() => {
    return pendingItems.filter((item) => selectedIds.has(item.id));
  }, [pendingItems, selectedIds]);

  const toggleSelect = (item: TargetNewerConflictItem) => {
    if (!isPending(item)) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  };

  const openResolveConfirm = useCallback((
    action: 'forceCopy' | 'renameThenCopy' | 'skip',
    title: string,
    message: string,
    tone: ConfirmTone
  ) => {
    if (!sessionId || selectedPendingItems.length === 0 || processing || confirmRequest) {
      return;
    }

    setConfirmRequest({
      type: 'resolve',
      sessionId,
      action,
      itemIds: selectedPendingItems.map((item) => item.id),
      title,
      message,
      tone,
    });
  }, [confirmRequest, processing, selectedPendingItems, sessionId]);

  const runResolution = useCallback(async (request: ResolveConfirmRequest) => {
    setProcessing(true);
    try {
      const result = await invoke<ConflictResolutionResult>('resolve_conflict_items', {
        sessionId: request.sessionId,
        resolutions: request.itemIds.map((itemId) => ({
          itemId,
          action: request.action,
        })),
      });
      if (result.failures.length > 0) {
        showToast(
          t('conflict.partialFailure', {
            count: result.failures.length,
            defaultValue: `${result.failures.length} item(s) failed.`,
          }),
          'warning'
        );
      } else {
        showToast(
          t('conflict.actionComplete', {
            count: result.processedCount,
            defaultValue: `Processed ${result.processedCount} item(s).`,
          }),
          'success'
        );
      }
      await loadSession(request.sessionId);
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setProcessing(false);
    }
  }, [loadSession, showToast, t]);

  const forceCloseSession = useCallback(async (request: CloseConfirmRequest) => {
    setProcessing(true);
    try {
      const result = await invoke<CloseConflictReviewSessionResult>('close_conflict_review_session', {
        sessionId: request.sessionId,
        forceSkipPending: true,
      });

      if (result.closed) {
        await getCurrentWebviewWindow().close();
      }
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        clearSessionState();
        await getCurrentWebviewWindow().close();
      } else {
        showToast(String(error), 'error');
      }
    } finally {
      setProcessing(false);
    }
  }, [clearSessionState, showToast]);

  const handleConfirmRequest = useCallback(async () => {
    if (!confirmRequest || processing) {
      return;
    }

    const request = confirmRequest;
    setConfirmRequest(null);

    if (request.type === 'resolve') {
      await runResolution(request);
      return;
    }

    await forceCloseSession(request);
  }, [confirmRequest, forceCloseSession, processing, runResolution]);

  const handleCloseWindow = useCallback(async () => {
    if (processing || confirmRequest) {
      return;
    }

    if (!sessionId) {
      await getCurrentWebviewWindow().close();
      return;
    }

    setProcessing(true);
    try {
      const result = await invoke<CloseConflictReviewSessionResult>('close_conflict_review_session', {
        sessionId,
        forceSkipPending: false,
      });
      if (!result.closed && result.hadPending) {
        setConfirmRequest({
          type: 'close',
          sessionId,
          title: t('common.warning', { defaultValue: 'Warning' }),
          message: t('conflict.closeWithPendingConfirm', {
            defaultValue: '미처리 항목이 있습니다. 남은 항목을 이번 실행에서 건너뛰고 닫을까요?',
          }),
          tone: 'warning',
        });
        return;
      }

      if (result.closed) {
        await getCurrentWebviewWindow().close();
      }
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        clearSessionState();
        await getCurrentWebviewWindow().close();
      } else {
        showToast(String(error), 'error');
      }
    } finally {
      setProcessing(false);
    }
  }, [clearSessionState, confirmRequest, processing, sessionId, showToast, t]);

  const confirmButtonClassName = useMemo(() => {
    if (!confirmRequest) {
      return '';
    }

    switch (confirmRequest.tone) {
      case 'danger':
        return 'bg-[var(--color-accent-error)] text-white';
      case 'warning':
        return 'bg-[var(--color-accent-warning)] text-black';
      case 'info':
      default:
        return 'bg-[var(--accent-main)] text-white';
    }
  }, [confirmRequest]);

  const renderOpenPreviewButtons = (sourcePath: string, targetPath: string) => (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => void openPath(sourcePath)}
        className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
      >
        <IconExternalLink size={14} />
        Source 열기
      </button>
      <button
        type="button"
        onClick={() => void openPath(targetPath)}
        className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
      >
        <IconExternalLink size={14} />
        Target 열기
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-4 md:p-6 flex flex-col gap-4">
      <header className="neo-box p-4 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)]">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-heading font-bold uppercase">
              {t('conflict.windowTitle', { defaultValue: '타겟 최신 파일 검토' })}
            </h1>
            <p className="text-xs font-mono text-[var(--text-secondary)]">
              {session
                ? `${session.taskName} (${session.taskId}) · pending ${session.pendingCount}/${session.totalCount}`
                : t('conflict.noSessionSelected', { defaultValue: '선택된 세션이 없습니다.' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={processing || !!confirmRequest}
              onClick={() => void loadSession(sessionId)}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
            >
              <IconRefresh size={14} />
              {t('common.refresh', { defaultValue: 'Refresh' })}
            </button>
            <button
              type="button"
              disabled={processing || !!confirmRequest}
              onClick={handleCloseWindow}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--color-accent-warning)]"
            >
              <IconX size={14} />
              {t('common.close', { defaultValue: 'Close' })}
            </button>
          </div>
        </div>
      </header>

      <section className="neo-box bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] p-3 min-h-[320px]">
        <h2 className="text-sm font-heading font-bold uppercase mb-2">
          {t('conflict.previewTitle', { defaultValue: '원본/타겟 미리보기 (diff)' })}
        </h2>
        {!focusedItem ? (
          <div className="text-sm font-mono text-[var(--text-secondary)] py-8 text-center">
            {loading
              ? t('common.loading', { defaultValue: 'Loading...' })
              : t('conflict.previewEmpty', { defaultValue: '하단 목록에서 파일을 선택하세요.' })}
          </div>
        ) : previewLoading ? (
          <div className="text-sm font-mono text-[var(--text-secondary)] py-8 text-center">
            {t('common.loading', { defaultValue: 'Loading...' })}
          </div>
        ) : preview?.kind === 'text' ? (
          <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] overflow-auto max-h-[420px]">
            <div className="grid grid-cols-[1fr_1fr] border-b-2 border-[var(--border-main)] font-mono text-[11px] uppercase">
              <div className="p-2 border-r-2 border-[var(--border-main)]">Source</div>
              <div className="p-2">Target</div>
            </div>
            <div>
              {linePairs.map((row) => (
                <div
                  key={row.index}
                  className={`grid grid-cols-[1fr_1fr] text-xs font-mono ${row.changed ? 'bg-[var(--color-accent-warning)]/25' : ''}`}
                >
                  <div className="p-1 border-r border-[var(--border-main)] whitespace-pre-wrap break-all">
                    {row.source || ' '}
                  </div>
                  <div className="p-1 whitespace-pre-wrap break-all">{row.target || ' '}</div>
                </div>
              ))}
            </div>
          </div>
        ) : preview?.kind === 'image' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Source</p>
              {sourceMediaPreviewFailed ? (
                <div className="h-[360px] border border-dashed border-[var(--border-main)] flex items-center justify-center px-3 text-center font-mono text-xs text-[var(--text-secondary)]">
                  {t('conflict.previewLoadFailed', {
                    defaultValue: '미리보기를 불러오지 못했습니다. 아래 버튼으로 OS 기본 앱에서 확인하세요.',
                  })}
                </div>
              ) : (
                <img
                  src={convertFileSrc(focusedItem.sourcePath)}
                  alt="source preview"
                  onError={() => setSourceMediaPreviewFailed(true)}
                  className="max-h-[360px] w-full object-contain"
                />
              )}
            </div>
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Target</p>
              {targetMediaPreviewFailed ? (
                <div className="h-[360px] border border-dashed border-[var(--border-main)] flex items-center justify-center px-3 text-center font-mono text-xs text-[var(--text-secondary)]">
                  {t('conflict.previewLoadFailed', {
                    defaultValue: '미리보기를 불러오지 못했습니다. 아래 버튼으로 OS 기본 앱에서 확인하세요.',
                  })}
                </div>
              ) : (
                <img
                  src={convertFileSrc(focusedItem.targetPath)}
                  alt="target preview"
                  onError={() => setTargetMediaPreviewFailed(true)}
                  className="max-h-[360px] w-full object-contain"
                />
              )}
            </div>
            {(sourceMediaPreviewFailed || targetMediaPreviewFailed) ? (
              <div className="lg:col-span-2 border border-[var(--border-main)] p-3 bg-[var(--bg-primary)]">
                <p className="font-mono text-xs mb-2 text-[var(--text-secondary)]">
                  {t('conflict.previewOpenHint', {
                    defaultValue: '파일을 직접 열어 원본/타겟을 비교하세요.',
                  })}
                </p>
                {renderOpenPreviewButtons(focusedItem.sourcePath, focusedItem.targetPath)}
              </div>
            ) : null}
          </div>
        ) : preview?.kind === 'video' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Source</p>
              {sourceMediaPreviewFailed ? (
                <div className="h-[320px] border border-dashed border-[var(--border-main)] flex items-center justify-center px-3 text-center font-mono text-xs text-[var(--text-secondary)]">
                  {t('conflict.previewLoadFailed', {
                    defaultValue: '미리보기를 불러오지 못했습니다. 아래 버튼으로 OS 기본 앱에서 확인하세요.',
                  })}
                </div>
              ) : (
                <video
                  controls
                  className="max-h-[320px] w-full"
                  src={convertFileSrc(focusedItem.sourcePath)}
                  onError={() => setSourceMediaPreviewFailed(true)}
                >
                  <track kind="captions" />
                </video>
              )}
            </div>
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Target</p>
              {targetMediaPreviewFailed ? (
                <div className="h-[320px] border border-dashed border-[var(--border-main)] flex items-center justify-center px-3 text-center font-mono text-xs text-[var(--text-secondary)]">
                  {t('conflict.previewLoadFailed', {
                    defaultValue: '미리보기를 불러오지 못했습니다. 아래 버튼으로 OS 기본 앱에서 확인하세요.',
                  })}
                </div>
              ) : (
                <video
                  controls
                  className="max-h-[320px] w-full"
                  src={convertFileSrc(focusedItem.targetPath)}
                  onError={() => setTargetMediaPreviewFailed(true)}
                >
                  <track kind="captions" />
                </video>
              )}
            </div>
            {(sourceMediaPreviewFailed || targetMediaPreviewFailed) ? (
              <div className="lg:col-span-2 border border-[var(--border-main)] p-3 bg-[var(--bg-primary)]">
                <p className="font-mono text-xs mb-2 text-[var(--text-secondary)]">
                  {t('conflict.previewOpenHint', {
                    defaultValue: '파일을 직접 열어 원본/타겟을 비교하세요.',
                  })}
                </p>
                {renderOpenPreviewButtons(focusedItem.sourcePath, focusedItem.targetPath)}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-4">
            <p className="font-mono text-sm mb-3">
              {t('conflict.previewUnsupported', {
                defaultValue: '앱 내 미리보기를 지원하지 않는 파일입니다. OS 기본 미리보기로 확인하세요.',
              })}
            </p>
            {renderOpenPreviewButtons(focusedItem.sourcePath, focusedItem.targetPath)}
          </div>
        )}
      </section>

      <section className="neo-box bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[6px_6px_0_0_var(--shadow-color)] p-3 flex-1 min-h-[300px]">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-heading font-bold uppercase">
              {t('conflict.listTitle', { defaultValue: '확인이 필요한 목록' })}
            </h2>
            <p className="text-xs font-mono text-[var(--text-secondary)]">
              pending {pendingItems.length} · selected {selectedPendingItems.length}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={selectedPendingItems.length === 0 || processing || !!confirmRequest}
              onClick={() => openResolveConfirm(
                'forceCopy',
                t('conflict.forceCopy', { defaultValue: '강제 복사' }),
                t('conflict.confirmForceCopy', {
                  defaultValue: '강제 복사는 되돌릴 수 없습니다. 계속할까요?',
                }),
                'danger'
              )}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 bg-[var(--color-accent-error)] text-white disabled:opacity-50"
            >
              <IconAlertTriangle size={14} />
              {t('conflict.forceCopy', { defaultValue: '강제 복사' })}
            </button>
            <button
              type="button"
              disabled={selectedPendingItems.length === 0 || processing || !!confirmRequest}
              onClick={() => openResolveConfirm(
                'renameThenCopy',
                t('conflict.safeCopy', { defaultValue: '안전 복사' }),
                t('conflict.confirmSafeCopy', {
                  defaultValue: '타겟 파일을 안전 이름으로 변경 후 복사합니다. 계속할까요?',
                }),
                'info'
              )}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 bg-[var(--accent-success)] text-white disabled:opacity-50"
            >
              <IconPlayerPlay size={14} />
              {t('conflict.safeCopy', { defaultValue: '이름 변경 후 복사(권장)' })}
            </button>
            <button
              type="button"
              disabled={selectedPendingItems.length === 0 || processing || !!confirmRequest}
              onClick={() => openResolveConfirm(
                'skip',
                t('conflict.skip', { defaultValue: '아무것도 안함' }),
                t('conflict.confirmSkip', {
                  defaultValue: '이번 실행에서 건너뜁니다. 다음 동기화 시 다시 충돌할 수 있습니다. 계속할까요?',
                }),
                'warning'
              )}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              <IconCheck size={14} />
              {t('conflict.skip', { defaultValue: '아무것도 안함' })}
            </button>
          </div>
        </div>

        <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] overflow-auto max-h-[420px]">
          {!session || session.items.length === 0 ? (
            <div className="p-4 text-sm font-mono text-[var(--text-secondary)]">
              {t('conflict.listEmpty', { defaultValue: '표시할 항목이 없습니다.' })}
            </div>
          ) : (
            session.items.map((item) => (
              <div
                key={item.id}
                className={`border-b border-dashed border-[var(--border-main)] p-3 cursor-pointer ${focusedItemId === item.id ? 'bg-[var(--bg-tertiary)]' : ''}`}
                onClick={() => setFocusedItemId(item.id)}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    disabled={!isPending(item)}
                    onChange={() => toggleSelect(item)}
                    onClick={(event) => event.stopPropagation()}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs break-all">
                      {item.sourcePath} → {item.targetPath}
                      <span className="ml-2 text-[10px] px-1 py-0.5 border border-[var(--border-main)] bg-[var(--bg-primary)] uppercase">
                        {item.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-2 text-[11px] font-mono">
                      <div className="border border-[var(--border-main)] p-2 bg-[var(--bg-primary)]">
                        <div className="uppercase text-[10px] mb-1">Source</div>
                        <div>size: {formatBytes(item.source.size, settings.dataUnitSystem)}</div>
                        <div>modified: {formatDate(item.source.modifiedUnixMs)}</div>
                        <div>created: {formatDate(item.source.createdUnixMs)}</div>
                      </div>
                      <div className="border border-[var(--border-main)] p-2 bg-[var(--bg-primary)]">
                        <div className="uppercase text-[10px] mb-1">Target</div>
                        <div>size: {formatBytes(item.target.size, settings.dataUnitSystem)}</div>
                        <div>modified: {formatDate(item.target.modifiedUnixMs)}</div>
                        <div>created: {formatDate(item.target.createdUnixMs)}</div>
                      </div>
                    </div>
                    {item.note ? (
                      <div className="mt-1 text-[10px] font-mono text-[var(--text-secondary)] break-all">
                        note: {item.note}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="text-[11px] font-mono text-[var(--text-secondary)] mt-2">
          <IconPlayerPlay size={12} className="inline-block mr-1" />
          {t('conflict.safeCopyHint', {
            defaultValue: '이름 변경 후 복사는 기존 타겟 파일을 보존하므로 더 안전합니다.',
          })}
        </div>
      </section>

      {confirmRequest ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <CardAnimation>
            <div className="neo-box p-6 w-full max-w-md bg-[var(--bg-primary)] border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
              <h3 className="text-xl font-heading font-bold mb-4 uppercase text-[var(--color-accent-warning)]">
                {confirmRequest.title}
              </h3>
              <p className="mb-6 text-[var(--text-primary)] font-mono text-sm whitespace-pre-wrap break-all">
                {confirmRequest.message}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmRequest(null)}
                  className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  {t('common.no', { defaultValue: '아니요' })}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRequest()}
                  className={`px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none transition-all ${confirmButtonClassName}`}
                >
                  {t('common.yes', { defaultValue: '예' })}
                </button>
              </div>
            </div>
          </CardAnimation>
        </div>
      ) : null}
    </div>
  );
}
