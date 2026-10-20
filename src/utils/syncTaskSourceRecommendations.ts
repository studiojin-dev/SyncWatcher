import type { SyncTask } from '../hooks/useSyncTasks';
import {
  isSourceUuidType,
  normalizeUuidSubPath,
  parseUuidSourceToken,
  type SourceUuidType,
} from '../views/syncTaskUuid';

export interface SyncTaskSourceRecommendationEvidence {
  /** i18n 키 접미사 (예: 'cameraBodySerial') */
  code: string;
  value?: string | null;
}

export const CAMERA_EVIDENCE_CODES: readonly string[] = [
  'cameraBodySerial',
  'cameraFolderStructure',
];

export interface SyncTaskSourceRecommendation {
  taskId: string;
  taskName: string;
  currentUuid: string;
  currentUuidType: string;
  proposedUuid: string;
  proposedUuidType: string;
  suggestedSource: string;
  proposedMountPoint: string;
  proposedVolumeName: string;
  confidenceLabel: string;
  evidence: string[];
  evidenceDetails?: SyncTaskSourceRecommendationEvidence[];
}

export interface SyncTaskSourceRecommendationsEnvelope {
  recommendations: SyncTaskSourceRecommendation[];
}

export function recommendationKey(
  recommendation: SyncTaskSourceRecommendation,
): string {
  return [
    recommendation.taskId,
    recommendation.currentUuid,
    recommendation.proposedUuidType,
    recommendation.proposedUuid,
    recommendation.proposedMountPoint,
  ].join(':');
}

export function isUuidSourceResolutionError(message: string): boolean {
  return /Volume with (DISK_UUID|VOLUME_UUID|SD_CARD_CID|UUID)\s+.+not found \(not mounted\?\)/i.test(
    message,
  );
}

function toSourceUuidType(value: string): SourceUuidType {
  return isSourceUuidType(value) ? value : 'disk';
}

export function buildRecommendationTaskUpdate(
  task: SyncTask,
  recommendation: SyncTaskSourceRecommendation,
): Partial<SyncTask> {
  const parsedSource = parseUuidSourceToken(recommendation.suggestedSource);
  const normalizedSubPath = normalizeUuidSubPath(
    parsedSource?.subPath ?? task.sourceSubPath ?? '/',
  );

  return {
    source: recommendation.suggestedSource,
    sourceType: 'uuid',
    sourceUuid: recommendation.proposedUuid,
    sourceUuidType: toSourceUuidType(recommendation.proposedUuidType),
    sourceSubPath: normalizedSubPath,
  };
}
