import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
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

  const loadSession = useCallback(async (nextSessionId: string | null) => {
    if (!nextSessionId) {
      setSession(null);
      setSelectedIds(new Set());
      setFocusedItemId(null);
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
      showToast(String(error), 'error');
      setSession(null);
      setSelectedIds(new Set());
      setFocusedItemId(null);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadSession(sessionId);
  }, [loadSession, sessionId]);

  useEffect(() => {
    if (!focusedItemId || !sessionId) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    const fetchPreview = async () => {
      setPreviewLoading(true);
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
          showToast(String(error), 'warning');
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

  const runAction = useCallback(async (
    action: 'forceCopy' | 'renameThenCopy' | 'skip',
    confirmMessage: string,
    confirmTitle: string,
    kind: 'warning' | 'info'
  ) => {
    if (!sessionId || selectedPendingItems.length === 0 || processing) {
      return;
    }

    const confirmed = await ask(confirmMessage, {
      title: confirmTitle,
      kind,
    });
    if (!confirmed) {
      return;
    }

    setProcessing(true);
    try {
      const result = await invoke<ConflictResolutionResult>('resolve_conflict_items', {
        sessionId,
        resolutions: selectedPendingItems.map((item) => ({
          itemId: item.id,
          action,
        })),
      });
      if (result.failures.length > 0) {
        showToast(
          t('conflict.partialFailure', {
            defaultValue: `${result.failures.length} item(s) failed.`,
          }),
          'warning'
        );
      } else {
        showToast(
          t('conflict.actionComplete', {
            defaultValue: `Processed ${result.processedCount} item(s).`,
          }),
          'success'
        );
      }
      await loadSession(sessionId);
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      setProcessing(false);
    }
  }, [loadSession, processing, selectedPendingItems, sessionId, showToast, t]);

  const handleCloseWindow = useCallback(async () => {
    if (!sessionId) {
      await getCurrentWebviewWindow().close();
      return;
    }

    try {
      let result = await invoke<CloseConflictReviewSessionResult>('close_conflict_review_session', {
        sessionId,
        forceSkipPending: false,
      });
      if (!result.closed && result.hadPending) {
        const confirmed = await ask(
          t('conflict.closeWithPendingConfirm', {
            defaultValue: '미처리 항목이 있습니다. 남은 항목을 이번 실행에서 건너뛰고 닫을까요?',
          }),
          {
            title: t('common.warning', { defaultValue: 'Warning' }),
            kind: 'warning',
          }
        );
        if (!confirmed) {
          return;
        }
        result = await invoke<CloseConflictReviewSessionResult>('close_conflict_review_session', {
          sessionId,
          forceSkipPending: true,
        });
      }

      if (result.closed) {
        await getCurrentWebviewWindow().close();
      }
    } catch (error) {
      showToast(String(error), 'error');
    }
  }, [sessionId, showToast, t]);

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
              onClick={() => void loadSession(sessionId)}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
            >
              <IconRefresh size={14} />
              {t('common.refresh', { defaultValue: 'Refresh' })}
            </button>
            <button
              type="button"
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
              <img src={convertFileSrc(focusedItem.sourcePath)} alt="source preview" className="max-h-[360px] w-full object-contain" />
            </div>
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Target</p>
              <img src={convertFileSrc(focusedItem.targetPath)} alt="target preview" className="max-h-[360px] w-full object-contain" />
            </div>
          </div>
        ) : preview?.kind === 'video' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Source</p>
              <video controls className="max-h-[320px] w-full" src={convertFileSrc(focusedItem.sourcePath)}>
                <track kind="captions" />
              </video>
            </div>
            <div className="border-2 border-[var(--border-main)] p-2 bg-[var(--bg-secondary)]">
              <p className="text-xs font-mono mb-2 uppercase">Target</p>
              <video controls className="max-h-[320px] w-full" src={convertFileSrc(focusedItem.targetPath)}>
                <track kind="captions" />
              </video>
            </div>
          </div>
        ) : (
          <div className="border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] p-4">
            <p className="font-mono text-sm mb-3">
              {t('conflict.previewUnsupported', {
                defaultValue: '앱 내 미리보기를 지원하지 않는 파일입니다. OS 기본 미리보기로 확인하세요.',
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void openPath(focusedItem.sourcePath)}
                className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
              >
                <IconExternalLink size={14} />
                Source 열기
              </button>
              <button
                type="button"
                onClick={() => void openPath(focusedItem.targetPath)}
                className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)]"
              >
                <IconExternalLink size={14} />
                Target 열기
              </button>
            </div>
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
              disabled={selectedPendingItems.length === 0 || processing}
              onClick={() => void runAction(
                'forceCopy',
                t('conflict.confirmForceCopy', {
                  defaultValue: '강제 복사는 되돌릴 수 없습니다. 계속할까요?',
                }),
                t('conflict.forceCopy', { defaultValue: '강제 복사' }),
                'warning'
              )}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 bg-[var(--color-accent-error)] text-white disabled:opacity-50"
            >
              <IconAlertTriangle size={14} />
              {t('conflict.forceCopy', { defaultValue: '강제 복사' })}
            </button>
            <button
              type="button"
              disabled={selectedPendingItems.length === 0 || processing}
              onClick={() => void runAction(
                'renameThenCopy',
                t('conflict.confirmSafeCopy', {
                  defaultValue: '타겟 파일을 안전 이름으로 변경 후 복사합니다. 계속할까요?',
                }),
                t('conflict.safeCopy', { defaultValue: '안전 복사' }),
                'info'
              )}
              className="px-3 py-2 border-2 border-[var(--border-main)] font-mono text-xs inline-flex items-center gap-1 bg-[var(--accent-success)] text-white disabled:opacity-50"
            >
              <IconPlayerPlay size={14} />
              {t('conflict.safeCopy', { defaultValue: '이름 변경 후 복사(권장)' })}
            </button>
            <button
              type="button"
              disabled={selectedPendingItems.length === 0 || processing}
              onClick={() => void runAction(
                'skip',
                t('conflict.confirmSkip', {
                  defaultValue: '이번 실행에서 건너뜁니다. 다음 동기화 시 다시 충돌할 수 있습니다. 계속할까요?',
                }),
                t('conflict.skip', { defaultValue: '아무것도 안함' }),
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
    </div>
  );
}
