import { describe, expect, it } from 'vitest';
import type { SyncTask } from '../hooks/useSyncTasks';
import {
  buildRecommendationTaskUpdate,
  isUuidSourceResolutionError,
  type SyncTaskSourceRecommendation,
} from './syncTaskSourceRecommendations';

function buildTask(): SyncTask {
  return {
    id: 'task-1',
    name: 'Camera',
    source: '[VOLUME_UUID:volume-before-format]/DCIM',
    target: '/tmp/target',
    checksumMode: false,
    sourceType: 'uuid',
    sourceUuid: 'volume-before-format',
    sourceUuidType: 'volume',
    sourceSubPath: '/DCIM',
  };
}

function buildRecommendation(
  overrides: Partial<SyncTaskSourceRecommendation>,
): SyncTaskSourceRecommendation {
  return {
    taskId: 'task-1',
    taskName: 'Camera',
    currentUuid: 'volume-before-format',
    currentUuidType: 'volume',
    proposedUuid: 'volume-after-format',
    proposedUuidType: 'volume',
    suggestedSource: '[VOLUME_UUID:volume-after-format]/DCIM',
    proposedMountPoint: '/Volumes/Untitled',
    proposedVolumeName: 'Untitled',
    confidenceLabel: 'high',
    evidence: [],
    ...overrides,
  };
}

describe('syncTaskSourceRecommendations', () => {
  it('applies an SD card CID recommendation as an sdcard source', () => {
    const update = buildRecommendationTaskUpdate(
      buildTask(),
      buildRecommendation({
        proposedUuid: '39:MTG2c:17826466',
        proposedUuidType: 'sdcard',
        suggestedSource: '[SD_CARD_CID:39:MTG2c:17826466]/DCIM',
        evidence: ['SD card CID matched'],
      }),
    );

    expect(update).toEqual({
      source: '[SD_CARD_CID:39:MTG2c:17826466]/DCIM',
      sourceType: 'uuid',
      sourceUuid: '39:MTG2c:17826466',
      sourceUuidType: 'sdcard',
      sourceSubPath: '/DCIM',
    });
  });

  it('keeps disk/volume recommendation mapping', () => {
    expect(
      buildRecommendationTaskUpdate(buildTask(), buildRecommendation({})).sourceUuidType,
    ).toBe('volume');
    expect(
      buildRecommendationTaskUpdate(
        buildTask(),
        buildRecommendation({ proposedUuidType: 'disk' }),
      ).sourceUuidType,
    ).toBe('disk');
  });

  it('detects unresolved SD card CID sources', () => {
    expect(
      isUuidSourceResolutionError(
        'Volume with SD_CARD_CID 39:MTG2c:17826466 not found (not mounted?)',
      ),
    ).toBe(true);
  });
});
