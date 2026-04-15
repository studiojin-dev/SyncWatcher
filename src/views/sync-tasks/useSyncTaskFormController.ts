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
import type { SyncTask, SyncTaskNetworkMount } from '../../hooks/useSyncTasks';
import {
  buildUuidOptionValue,
  buildUuidSourceOptions,
  inferUuidTypeFromVolumes,
  normalizeUuidSubPath,
  parseUuidOptionValue,
  parseUuidSourceToken,
  toUuidSubPath,
  type SourceUuidType,
  type UuidTokenType,
  type UuidSourceOption,
} from '../syncTaskUuid';
import { getErrorMessage, type ShowToastFn, type TranslateFn, type VolumeInfo } from './helpers';

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
}

export function useSyncTaskFormController({
  editingTask,
  showForm,
  dataUnitSystem,
  showToast,
  t,
}: UseSyncTaskFormControllerOptions): SyncTaskFormController {
  const [selectedSets, setSelectedSets] = useState<string[]>([]);
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
    () => buildUuidSourceOptions(volumes, formatVolumeSize),
    [formatVolumeSize, volumes],
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
      })} [${sourceTokenType.toUpperCase()} UUID: ${sourceUuid}]`,
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
      const tokenUuidType =
        parsedSourceToken?.tokenType === 'disk' ||
        parsedSourceToken?.tokenType === 'volume'
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
      return;
    }

    setSelectedSets([]);
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

  return {
    selectedSets,
    setSelectedSets,
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
  };
}
