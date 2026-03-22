import type { SyncTask } from '../hooks/useSyncTasks';
import {
  normalizeUuidSubPath,
  parseUuidSourceToken,
  type SourceUuidType,
} from '../views/syncTaskUuid';

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
  return /Volume with (DISK_UUID|VOLUME_UUID|UUID)\s+.+not found \(not mounted\?\)/i.test(
    message,
  );
}

function toSourceUuidType(value: string): SourceUuidType {
  return value === 'volume' ? 'volume' : 'disk';
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
