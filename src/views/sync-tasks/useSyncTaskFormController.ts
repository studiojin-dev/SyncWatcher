import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { formatBytes, type DataUnitSystem } from '../../utils/formatBytes';
import { captureNetworkMount, capturePathAccess } from '../../utils/pathAccess';
import { shouldEnableAutoUnmount } from '../../utils/autoUnmount';
import type {
  SyncTask,
  SyncTaskExtraSource,
  SyncTaskNetworkMount,
} from '../../hooks/useSyncTasks';
import {
  buildUuidOptionValue,
  buildUuidSourceOptions,
  inferUuidTypeFromVolumes,
  isSourceUuidType,
  normalizeUuidSubPath,
  parseUuidOptionValue,
  parseUuidSourceToken,
  toUuidSubPath,
  uuidTypeLabel,
  type SourceUuidType,
  type UuidTokenType,
  type UuidSourceOption,
} from '../syncTaskUuid';
import { getErrorMessage, type ShowToastFn, type TranslateFn, type VolumeInfo } from './helpers';

/** 편집 중인 추가 소스 하나 (ADR-0039). */
export interface ExtraSourceDraft {
  key: string;
  sourceType: 'path' | 'uuid';
  sourcePath: string;
  sourceBookmark: string | null;
  sourceUuid: string;
  sourceTokenType: UuidTokenType | '';
  sourceSubPath: string;
  /** 편집 전에 저장돼 있던 값. 연결되지 않은 UUID 소스를 그대로 유지할 때 쓴다. */
  saved: SyncTaskExtraSource | null;
}

let extraSourceKeySeq = 0;
function nextExtraSourceKey(): string {
  extraSourceKeySeq += 1;
  return `extra-source-${extraSourceKeySeq}`;
}

function emptyExtraSourceDraft(): ExtraSourceDraft {
  return {
    key: nextExtraSourceKey(),
    sourceType: 'uuid',
    sourcePath: '',
    sourceBookmark: null,
    sourceUuid: '',
    sourceTokenType: '',
    sourceSubPath: '',
    saved: null,
  };
}

function extraSourceDraftFromTask(extra: SyncTaskExtraSource): ExtraSourceDraft {
  const parsed = parseUuidSourceToken(extra.source || '');
  const sourceType: 'path' | 'uuid' =
    extra.sourceType || (parsed ? 'uuid' : 'path');
  return {
    key: nextExtraSourceKey(),
    sourceType,
    sourcePath: sourceType === 'path' ? extra.source : '',
    sourceBookmark: extra.sourceBookmark ?? null,
    sourceUuid: sourceType === 'uuid' ? extra.sourceUuid || parsed?.uuid || '' : '',
    sourceTokenType:
      sourceType === 'uuid' ? parsed?.tokenType || extra.sourceUuidType || '' : '',
    sourceSubPath:
      sourceType === 'uuid'
        ? normalizeUuidSubPath(extra.sourceSubPath ?? parsed?.subPath ?? '/')
        : '',
    saved: extra,
  };
}

interface UseSyncTaskFormControllerOptions {
  editingTask: SyncTask | null;
  showForm: boolean;
  dataUnitSystem: DataUnitSystem;
  showToast: ShowToastFn;
  t: TranslateFn;
}

export interface SyncTaskFormController {
  selectedSets: string[];
  setSelectedSets: Dispatch<SetStateAction<string[]>>;
  saveRuleId: string | null;
  setSaveRuleId: Dispatch<SetStateAction<string | null>>;
  sourcePath: string;
  setSourcePath: Dispatch<SetStateAction<string>>;
  sourceBookmark: string | null;
  setSourceBookmark: Dispatch<SetStateAction<string | null>>;
  sourceNetworkMount: SyncTaskNetworkMount | null;
  setSourceNetworkMount: Dispatch<SetStateAction<SyncTaskNetworkMount | null>>;
  sourceNetworkPassword: string;
  setSourceNetworkPassword: Dispatch<SetStateAction<string>>;
  targetPath: string;
  setTargetPath: Dispatch<SetStateAction<string>>;
  targetBookmark: string | null;
  setTargetBookmark: Dispatch<SetStateAction<string | null>>;
  targetNetworkMount: SyncTaskNetworkMount | null;
  setTargetNetworkMount: Dispatch<SetStateAction<SyncTaskNetworkMount | null>>;
  targetNetworkPassword: string;
  setTargetNetworkPassword: Dispatch<SetStateAction<string>>;
  watchMode: boolean;
  handleWatchModeChange: (checked: boolean) => void;
  autoUnmount: boolean;
  setAutoUnmount: Dispatch<SetStateAction<boolean>>;
  sourceType: 'path' | 'uuid';
  handleSourceTypeChange: (value: 'path' | 'uuid') => void;
  sourceUuid: string;
  sourceUuidType: SourceUuidType | '';
  sourceTokenType: UuidTokenType | '';
  sourceSubPath: string;
  setSourceSubPath: Dispatch<SetStateAction<string>>;
  volumes: VolumeInfo[];
  loadingVolumes: boolean;
  uuidSourceOptions: UuidSourceOption[];
  selectedUuidOptionValue: string | null;
  selectedUuidOption: UuidSourceOption | null;
  handleUuidOptionChange: (value: string | null) => void;
  browseDirectory: (type: 'source' | 'target') => Promise<void>;
  browseSourceSubPath: () => Promise<void>;
  extraSources: ExtraSourceDraft[];
  addExtraSource: () => void;
  removeExtraSource: (key: string) => void;
  updateExtraSource: (key: string, patch: Partial<ExtraSourceDraft>) => void;
  extraSourceUuidOptions: (draft: ExtraSourceDraft) => UuidSourceOption[];
  selectExtraSourceUuid: (key: string, value: string | null) => void;
  browseExtraSourceDirectory: (key: string) => Promise<void>;
  browseExtraSourceSubPath: (key: string) => Promise<void>;
}

export function useSyncTaskFormController({
  editingTask,
  showForm,
  dataUnitSystem,
  showToast,
  t,
}: UseSyncTaskFormControllerOptions): SyncTaskFormController {
  const [selectedSets, setSelectedSets] = useState<string[]>([]);
  const [saveRuleId, setSaveRuleId] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [sourceBookmark, setSourceBookmark] = useState<string | null>(null);
  const [sourceNetworkMount, setSourceNetworkMount] = useState<SyncTaskNetworkMount | null>(null);
  const [sourceNetworkPassword, setSourceNetworkPassword] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [targetBookmark, setTargetBookmark] = useState<string | null>(null);
  const [targetNetworkMount, setTargetNetworkMount] = useState<SyncTaskNetworkMount | null>(null);
  const [targetNetworkPassword, setTargetNetworkPassword] = useState('');
  const [watchMode, setWatchMode] = useState(false);
  const [autoUnmount, setAutoUnmount] = useState(false);
  const [sourceType, setSourceType] = useState<'path' | 'uuid'>('path');
  const [sourceUuid, setSourceUuid] = useState('');
  const [sourceUuidType, setSourceUuidType] = useState<SourceUuidType | ''>(
    '',
  );
  const [sourceTokenType, setSourceTokenType] = useState<UuidTokenType | ''>('');
  const [sourceSubPath, setSourceSubPath] = useState('');
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [extraSources, setExtraSources] = useState<ExtraSourceDraft[]>([]);

  const formatVolumeSize = useCallback(
    (volume: VolumeInfo): string => {
      if (typeof volume.total_bytes !== 'number') {
        return t('dashboard.networkCapacityUnavailable', {
          defaultValue: 'N/A - 네트워크 연결',
        });
      }
      return formatBytes(volume.total_bytes, dataUnitSystem);
    },
    [dataUnitSystem, t],
  );

  const mountedUuidSourceOptions = useMemo(
    () =>
      buildUuidSourceOptions(volumes, formatVolumeSize, {
        sdCardLabel: t('syncTasks.sdCardSerial', {
          defaultValue: 'SD Card Serial',
        }),
      }),
    [formatVolumeSize, t, volumes],
  );
  const selectedUuidOptionValue =
    sourceUuid && sourceTokenType
      ? buildUuidOptionValue(sourceTokenType, sourceUuid)
      : null;
  const savedUuidSourceOption = useMemo(() => {
    if (
      !editingTask ||
      sourceType !== 'uuid' ||
      !sourceUuid ||
      !sourceTokenType ||
      mountedUuidSourceOptions.some(
        (option) => option.value === selectedUuidOptionValue,
      )
    ) {
      return null;
    }

    return {
      value: buildUuidOptionValue(sourceTokenType, sourceUuid),
      label: `${t('syncTasks.savedUuidSourceLabel', {
        defaultValue: 'Saved UUID source (not mounted)',
      })} [${uuidTypeLabel(sourceTokenType, {
        sdCardLabel: t('syncTasks.sdCardSerial', {
          defaultValue: 'SD Card Serial',
        }),
      })}: ${sourceUuid}]`,
      uuidType: sourceTokenType,
      uuid: sourceUuid,
      mountPoint: null,
      mounted: false,
    } satisfies UuidSourceOption;
  }, [
    editingTask,
    mountedUuidSourceOptions,
    selectedUuidOptionValue,
    sourceTokenType,
    sourceType,
    sourceUuid,
    t,
  ]);
  const uuidSourceOptions = useMemo(
    () =>
      savedUuidSourceOption
        ? [savedUuidSourceOption, ...mountedUuidSourceOptions]
        : mountedUuidSourceOptions,
    [mountedUuidSourceOptions, savedUuidSourceOption],
  );
  const selectedUuidOption = useMemo(() => {
    if (!selectedUuidOptionValue) {
      return null;
    }
    return (
      uuidSourceOptions.find(
        (option) => option.value === selectedUuidOptionValue,
      ) || null
    );
  }, [selectedUuidOptionValue, uuidSourceOptions]);

  const loadVolumes = useCallback(async () => {
    try {
      setLoadingVolumes(true);
      const result = await invoke<VolumeInfo[]>('get_removable_volumes');
      setVolumes(result);
    } catch (error) {
      console.error('Failed to load volumes:', error);
    } finally {
      setLoadingVolumes(false);
    }
  }, []);

  useEffect(() => {
    if (editingTask) {
      const parsedSourceToken = parseUuidSourceToken(editingTask.source || '');
      const tokenUuidType = isSourceUuidType(parsedSourceToken?.tokenType)
        ? parsedSourceToken.tokenType
        : '';
      const tokenType = parsedSourceToken?.tokenType || '';
      const resolvedSourceType: 'path' | 'uuid' =
        editingTask.sourceType || (parsedSourceToken ? 'uuid' : 'path');
      const resolvedSourceUuid =
        editingTask.sourceUuid || parsedSourceToken?.uuid || '';
      const resolvedSourceSubPath = normalizeUuidSubPath(
        editingTask.sourceSubPath ?? parsedSourceToken?.subPath ?? '/',
      );

      setSelectedSets(editingTask.exclusionSets || []);
      setSaveRuleId(editingTask.saveRuleId ?? null);
      setSourcePath(editingTask.source || '');
      setSourceBookmark(editingTask.sourceBookmark ?? null);
      setSourceNetworkMount(editingTask.sourceNetworkMount ?? null);
      setSourceNetworkPassword('');
      setTargetPath(editingTask.target || '');
      setTargetBookmark(editingTask.targetBookmark ?? null);
      setTargetNetworkMount(editingTask.targetNetworkMount ?? null);
      setTargetNetworkPassword('');
      setWatchMode(editingTask.watchMode || false);
      setAutoUnmount(shouldEnableAutoUnmount(editingTask));
      setSourceType(resolvedSourceType);
      setSourceUuid(resolvedSourceType === 'uuid' ? resolvedSourceUuid : '');
      setSourceUuidType(
        resolvedSourceType === 'uuid'
          ? editingTask.sourceUuidType || tokenUuidType
          : '',
      );
      setSourceTokenType(
        resolvedSourceType === 'uuid'
          ? tokenType || editingTask.sourceUuidType || ''
          : '',
      );
      setSourceSubPath(
        resolvedSourceType === 'uuid' ? resolvedSourceSubPath : '',
      );
      setExtraSources((editingTask.extraSources ?? []).map(extraSourceDraftFromTask));
      return;
    }

    setSelectedSets([]);
    setSaveRuleId(null);
    setSourcePath('');
    setSourceBookmark(null);
    setSourceNetworkMount(null);
    setSourceNetworkPassword('');
    setTargetPath('');
    setTargetBookmark(null);
    setTargetNetworkMount(null);
    setTargetNetworkPassword('');
    setWatchMode(false);
    setAutoUnmount(false);
    setSourceType('path');
    setSourceUuid('');
    setSourceUuidType('');
    setSourceTokenType('');
    setSourceSubPath('');
    setExtraSources([]);
  }, [editingTask, showForm]);

  useEffect(() => {
    if (!showForm || sourceType !== 'uuid' || !sourceUuid || sourceTokenType) {
      return;
    }

    const inferredType = inferUuidTypeFromVolumes(sourceUuid, volumes);
    if (inferredType) {
      setSourceUuidType(inferredType);
      setSourceTokenType(inferredType);
    }
  }, [showForm, sourceTokenType, sourceType, sourceUuid, volumes]);

  useEffect(() => {
    if (showForm) {
      void loadVolumes();
    }
  }, [showForm, loadVolumes]);

  useEffect(() => {
    if (!showForm) {
      return;
    }

    const unlistenPromise = listen('volumes-changed', () => {
      void loadVolumes();
    });

    return () => {
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch((error) => {
          console.warn('Failed to unlisten volumes-changed', error);
        });
    };
  }, [showForm, loadVolumes]);

  const handleSourceTypeChange = useCallback((value: 'path' | 'uuid') => {
    setSourceType(value);
    if (value === 'path') {
      setAutoUnmount(false);
      return;
    }
    setSourceBookmark(null);
  }, []);

  const handleUuidOptionChange = useCallback(
    (value: string | null) => {
      const updateSelection = async () => {
        if (!value) {
          setSourceUuid('');
          setSourceUuidType('');
          setSourceTokenType('');
          setSourceBookmark(null);
          return;
        }

        const parsedOption = parseUuidOptionValue(value);
        if (!parsedOption) {
          setSourceUuid('');
          setSourceUuidType('');
          setSourceTokenType('');
          setSourceBookmark(null);
          return;
        }

        setSourceUuid(parsedOption.uuid);
        setSourceUuidType(
          parsedOption.uuidType === 'legacy' ? '' : parsedOption.uuidType,
        );
        setSourceTokenType(parsedOption.uuidType);
        const option = uuidSourceOptions.find((candidate) => candidate.value === value);
        if (option?.mounted && option.mountPoint) {
          setSourcePath(option.mountPoint);
          try {
            const captured = await capturePathAccess(option.mountPoint);
            setSourceBookmark(captured.bookmark ?? null);
          } catch (error) {
            console.error('Failed to capture source volume access:', error);
            setSourceBookmark(null);
            showToast(getErrorMessage(error), 'error');
          }
          return;
        }

        setSourceBookmark(null);
      };

      void updateSelection();
    },
    [showToast, uuidSourceOptions],
  );

  const handleWatchModeChange = useCallback((checked: boolean) => {
    setWatchMode(checked);
    if (!checked) {
      setAutoUnmount(false);
    }
  }, []);

  const browseDirectory = useCallback(
    async (type: 'source' | 'target') => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title:
            type === 'source'
              ? 'Select Source Directory'
              : 'Select Target Directory',
        });

        if (selected && typeof selected === 'string') {
          const captured = await capturePathAccess(selected);
          const networkMount = await captureNetworkMount(captured.path);
          if (type === 'source') {
            setSourcePath(captured.path);
            setSourceBookmark(captured.bookmark ?? null);
            setSourceNetworkMount(networkMount);
            setSourceNetworkPassword('');
          } else {
            setTargetPath(captured.path);
            setTargetBookmark(captured.bookmark ?? null);
            setTargetNetworkMount(networkMount);
            setTargetNetworkPassword('');
          }
        }
      } catch (error) {
        console.error('Failed to open directory picker:', error);
        showToast('Failed to open directory picker', 'error');
      }
    },
    [showToast],
  );

  const browseSourceSubPath = useCallback(async () => {
    if (sourceType !== 'uuid') {
      return;
    }

    const mountPoint = selectedUuidOption?.mountPoint;
    if (!mountPoint) {
      showToast(
        t('syncTasks.volumeNotMounted', {
          defaultValue: '볼륨이 마운트되지 않음',
        }),
        'warning',
      );
      return;
    }

    const normalizedSubPath = sourceSubPath.replace(/^\/+/, '');
    const defaultPath = normalizedSubPath
      ? `${mountPoint}/${normalizedSubPath}`
      : mountPoint;

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('syncTasks.subPath', { defaultValue: '하위 경로' }),
        defaultPath,
      });

      if (!selected || typeof selected !== 'string') {
        return;
      }

      const resolvedSubPath = toUuidSubPath(mountPoint, selected);
      if (resolvedSubPath === null) {
        showToast(
          t('syncTasks.subPathOutsideVolume', {
            defaultValue: '선택한 경로가 현재 볼륨 내부가 아닙니다.',
          }),
          'warning',
        );
        return;
      }

      setSourceSubPath(resolvedSubPath);
    } catch (error) {
      console.error('Failed to open sub path picker:', error);
      showToast('Failed to open directory picker', 'error');
    }
  }, [
    selectedUuidOption,
    showToast,
    sourceSubPath,
    sourceType,
    t,
  ]);

  const updateExtraSource = useCallback(
    (key: string, patch: Partial<ExtraSourceDraft>) => {
      setExtraSources((prev) =>
        prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
      );
    },
    [],
  );

  const addExtraSource = useCallback(() => {
    setExtraSources((prev) => [...prev, emptyExtraSourceDraft()]);
  }, []);

  const removeExtraSource = useCallback((key: string) => {
    setExtraSources((prev) => prev.filter((draft) => draft.key !== key));
  }, []);

  const extraSourceUuidOptions = useCallback(
    (draft: ExtraSourceDraft): UuidSourceOption[] => {
      if (!draft.sourceUuid || !draft.sourceTokenType) {
        return mountedUuidSourceOptions;
      }
      const value = buildUuidOptionValue(draft.sourceTokenType, draft.sourceUuid);
      if (mountedUuidSourceOptions.some((option) => option.value === value)) {
        return mountedUuidSourceOptions;
      }
      const savedOption: UuidSourceOption = {
        value,
        label: `${t('syncTasks.savedUuidSourceLabel', {
          defaultValue: 'Saved UUID source (not mounted)',
        })} [${uuidTypeLabel(draft.sourceTokenType, {
          sdCardLabel: t('syncTasks.sdCardSerial', {
            defaultValue: 'SD Card Serial',
          }),
        })}: ${draft.sourceUuid}]`,
        uuidType: draft.sourceTokenType,
        uuid: draft.sourceUuid,
        mountPoint: null,
        mounted: false,
      };
      return [savedOption, ...mountedUuidSourceOptions];
    },
    [mountedUuidSourceOptions, t],
  );

  const selectExtraSourceUuid = useCallback(
    (key: string, value: string | null) => {
      const parsedOption = value ? parseUuidOptionValue(value) : null;
      if (!parsedOption) {
        updateExtraSource(key, {
          sourceUuid: '',
          sourceTokenType: '',
          sourceBookmark: null,
        });
        return;
      }
      updateExtraSource(key, {
        sourceUuid: parsedOption.uuid,
        sourceTokenType: parsedOption.uuidType,
        sourceBookmark: null,
      });
      const option = mountedUuidSourceOptions.find(
        (candidate) => candidate.value === value,
      );
      if (!option?.mounted || !option.mountPoint) {
        return;
      }
      void capturePathAccess(option.mountPoint)
        .then((captured) => {
          updateExtraSource(key, { sourceBookmark: captured.bookmark ?? null });
        })
        .catch((error) => {
          console.error('Failed to capture extra source volume access:', error);
          showToast(getErrorMessage(error), 'error');
        });
    },
    [mountedUuidSourceOptions, showToast, updateExtraSource],
  );

  const browseExtraSourceDirectory = useCallback(
    async (key: string) => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select Source Directory',
        });
        if (selected && typeof selected === 'string') {
          const captured = await capturePathAccess(selected);
          updateExtraSource(key, {
            sourcePath: captured.path,
            sourceBookmark: captured.bookmark ?? null,
          });
        }
      } catch (error) {
        console.error('Failed to open directory picker:', error);
        showToast('Failed to open directory picker', 'error');
      }
    },
    [showToast, updateExtraSource],
  );

  const browseExtraSourceSubPath = useCallback(
    async (key: string) => {
      const draft = extraSources.find((candidate) => candidate.key === key);
      if (!draft || !draft.sourceUuid || !draft.sourceTokenType) {
        return;
      }
      const value = buildUuidOptionValue(draft.sourceTokenType, draft.sourceUuid);
      const mountPoint = mountedUuidSourceOptions.find(
        (option) => option.value === value,
      )?.mountPoint;
      if (!mountPoint) {
        showToast(
          t('syncTasks.volumeNotMounted', {
            defaultValue: '볼륨이 마운트되지 않음',
          }),
          'warning',
        );
        return;
      }

      const normalizedSubPath = draft.sourceSubPath.replace(/^\/+/, '');
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: t('syncTasks.subPath', { defaultValue: '하위 경로' }),
          defaultPath: normalizedSubPath
            ? `${mountPoint}/${normalizedSubPath}`
            : mountPoint,
        });
        if (!selected || typeof selected !== 'string') {
          return;
        }
        const resolvedSubPath = toUuidSubPath(mountPoint, selected);
        if (resolvedSubPath === null) {
          showToast(
            t('syncTasks.subPathOutsideVolume', {
              defaultValue: '선택한 경로가 현재 볼륨 내부가 아닙니다.',
            }),
            'warning',
          );
          return;
        }
        updateExtraSource(key, { sourceSubPath: resolvedSubPath });
      } catch (error) {
        console.error('Failed to open sub path picker:', error);
        showToast('Failed to open directory picker', 'error');
      }
    },
    [extraSources, mountedUuidSourceOptions, showToast, t, updateExtraSource],
  );

  return {
    selectedSets,
    setSelectedSets,
    saveRuleId,
    setSaveRuleId,
    sourcePath,
    setSourcePath,
    sourceBookmark,
    setSourceBookmark,
    sourceNetworkMount,
    setSourceNetworkMount,
    sourceNetworkPassword,
    setSourceNetworkPassword,
    targetPath,
    setTargetPath,
    targetBookmark,
    setTargetBookmark,
    targetNetworkMount,
    setTargetNetworkMount,
    targetNetworkPassword,
    setTargetNetworkPassword,
    watchMode,
    handleWatchModeChange,
    autoUnmount,
    setAutoUnmount,
    sourceType,
    handleSourceTypeChange,
    sourceUuid,
    sourceUuidType,
    sourceTokenType,
    sourceSubPath,
    setSourceSubPath,
    volumes,
    loadingVolumes,
    uuidSourceOptions,
    selectedUuidOptionValue,
    selectedUuidOption,
    handleUuidOptionChange,
    browseDirectory,
    browseSourceSubPath,
    extraSources,
    addExtraSource,
    removeExtraSource,
    updateExtraSource,
    extraSourceUuidOptions,
    selectExtraSourceUuid,
    browseExtraSourceDirectory,
    browseExtraSourceSubPath,
  };
}
