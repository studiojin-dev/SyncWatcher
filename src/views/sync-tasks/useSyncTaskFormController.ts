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
import { shouldEnableAutoUnmount } from '../../utils/autoUnmount';
import type { SyncTask } from '../../hooks/useSyncTasks';
import {
  buildUuidOptionValue,
  buildUuidSourceOptions,
  inferUuidTypeFromVolumes,
  normalizeUuidSubPath,
  parseUuidOptionValue,
  parseUuidSourceToken,
  toUuidSubPath,
  type SourceUuidType,
  type UuidSourceOption,
} from '../syncTaskUuid';
import type { ShowToastFn, TranslateFn, VolumeInfo } from './helpers';

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
  targetPath: string;
  setTargetPath: Dispatch<SetStateAction<string>>;
  watchMode: boolean;
  handleWatchModeChange: (checked: boolean) => void;
  autoUnmount: boolean;
  setAutoUnmount: Dispatch<SetStateAction<boolean>>;
  sourceType: 'path' | 'uuid';
  handleSourceTypeChange: (value: 'path' | 'uuid') => void;
  sourceUuid: string;
  sourceUuidType: SourceUuidType | '';
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
  const [targetPath, setTargetPath] = useState('');
  const [watchMode, setWatchMode] = useState(false);
  const [autoUnmount, setAutoUnmount] = useState(false);
  const [sourceType, setSourceType] = useState<'path' | 'uuid'>('path');
  const [sourceUuid, setSourceUuid] = useState('');
  const [sourceUuidType, setSourceUuidType] = useState<SourceUuidType | ''>(
    '',
  );
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

  const uuidSourceOptions = useMemo(
    () => buildUuidSourceOptions(volumes, formatVolumeSize),
    [formatVolumeSize, volumes],
  );
  const selectedUuidOptionValue =
    sourceUuid && sourceUuidType
      ? buildUuidOptionValue(sourceUuidType, sourceUuid)
      : null;
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
      const resolvedSourceType: 'path' | 'uuid' =
        editingTask.sourceType || (parsedSourceToken ? 'uuid' : 'path');
      const resolvedSourceUuid =
        editingTask.sourceUuid || parsedSourceToken?.uuid || '';
      const resolvedSourceSubPath = normalizeUuidSubPath(
        editingTask.sourceSubPath ?? parsedSourceToken?.subPath ?? '/',
      );

      setSelectedSets(editingTask.exclusionSets || []);
      setSourcePath(editingTask.source || '');
      setTargetPath(editingTask.target || '');
      setWatchMode(editingTask.watchMode || false);
      setAutoUnmount(shouldEnableAutoUnmount(editingTask));
      setSourceType(resolvedSourceType);
      setSourceUuid(resolvedSourceType === 'uuid' ? resolvedSourceUuid : '');
      setSourceUuidType(
        resolvedSourceType === 'uuid'
          ? editingTask.sourceUuidType || tokenUuidType
          : '',
      );
      setSourceSubPath(
        resolvedSourceType === 'uuid' ? resolvedSourceSubPath : '',
      );
      return;
    }

    setSelectedSets([]);
    setSourcePath('');
    setTargetPath('');
    setWatchMode(false);
    setAutoUnmount(false);
    setSourceType('path');
    setSourceUuid('');
    setSourceUuidType('');
    setSourceSubPath('');
  }, [editingTask, showForm]);

  useEffect(() => {
    if (!showForm || sourceType !== 'uuid' || !sourceUuid || sourceUuidType) {
      return;
    }

    const inferredType = inferUuidTypeFromVolumes(sourceUuid, volumes);
    if (inferredType) {
      setSourceUuidType(inferredType);
    }
  }, [showForm, sourceType, sourceUuid, sourceUuidType, volumes]);

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
    }
  }, []);

  const handleUuidOptionChange = useCallback(
    (value: string | null) => {
      if (!value) {
        setSourceUuid('');
        setSourceUuidType('');
        return;
      }

      const parsedOption = parseUuidOptionValue(value);
      if (!parsedOption) {
        setSourceUuid('');
        setSourceUuidType('');
        return;
      }

      setSourceUuid(parsedOption.uuid);
      setSourceUuidType(parsedOption.uuidType);
      const option = uuidSourceOptions.find((candidate) => candidate.value === value);
      if (option) {
        setSourcePath(option.mountPoint);
      }
    },
    [uuidSourceOptions],
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
          if (type === 'source') {
            setSourcePath(selected);
          } else {
            setTargetPath(selected);
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
    targetPath,
    setTargetPath,
    watchMode,
    handleWatchModeChange,
    autoUnmount,
    setAutoUnmount,
    sourceType,
    handleSourceTypeChange,
    sourceUuid,
    sourceUuidType,
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
