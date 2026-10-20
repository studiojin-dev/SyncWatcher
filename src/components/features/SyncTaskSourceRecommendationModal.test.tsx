import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SyncTaskSourceRecommendationModal from './SyncTaskSourceRecommendationModal';
import type { SyncTaskSourceRecommendation } from '../../utils/syncTaskSourceRecommendations';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; value?: string }) =>
      (options?.defaultValue ?? '').replace('{{value}}', options?.value ?? ''),
  }),
}));

function buildRecommendation(
  overrides: Partial<SyncTaskSourceRecommendation> = {},
): SyncTaskSourceRecommendation {
  return {
    taskId: 'task-1',
    taskName: 'A7RC Card',
    currentUuid: 'volume-before-format',
    currentUuidType: 'volume',
    proposedUuid: 'volume-after-format',
    proposedUuidType: 'volume',
    suggestedSource: '[VOLUME_UUID:volume-after-format]/',
    proposedMountPoint: '/Volumes/Untitled',
    proposedVolumeName: 'Untitled',
    confidenceLabel: 'medium',
    evidence: [
      'capacity matched (512 bytes)',
      'filesystem matched (ExFAT)',
      'camera body serial matched (03407347)',
    ],
    evidenceDetails: [
      { code: 'capacity', value: '512' },
      { code: 'filesystem', value: 'ExFAT' },
      { code: 'cameraBodySerial', value: '03407347' },
    ],
    ...overrides,
  };
}

function renderModal(recommendation: SyncTaskSourceRecommendation) {
  const handlers = {
    onUpdate: vi.fn(),
    onDismiss: vi.fn(),
    onOpenTaskEditor: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <SyncTaskSourceRecommendationModal
      opened
      recommendations={[recommendation]}
      {...handlers}
    />,
  );
  return handlers;
}

describe('SyncTaskSourceRecommendationModal', () => {
  it('renders human-readable camera evidence and the same-model notice', () => {
    renderModal(buildRecommendation());

    expect(screen.getByText(/Camera body serial matched: 03407347/)).toBeInTheDocument();
    expect(screen.getByText(/Capacity matched: 512 bytes/)).toBeInTheDocument();
    expect(screen.getByTestId('camera-evidence-notice')).toBeInTheDocument();
  });

  it('omits the camera notice for non-camera evidence and falls back to raw strings', () => {
    renderModal(
      buildRecommendation({
        confidenceLabel: 'high',
        evidence: ['device serial matched'],
        evidenceDetails: undefined,
      }),
    );

    expect(screen.getByText(/device serial matched/)).toBeInTheDocument();
    expect(screen.queryByTestId('camera-evidence-notice')).not.toBeInTheDocument();
  });

  it('lets the user choose update, edit, or dismiss without auto-applying', () => {
    const handlers = renderModal(
      buildRecommendation({
        confidenceLabel: 'low',
        evidenceDetails: [{ code: 'cameraFolderStructure' }],
        evidence: ['camera folder structure matched'],
      }),
    );

    expect(handlers.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/Camera folder structure matched/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open Task Editor'));
    expect(handlers.onOpenTaskEditor).toHaveBeenCalledWith('task-1');
    fireEvent.click(screen.getByText('Dismiss'));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Update Task'));
    expect(handlers.onUpdate).toHaveBeenCalledTimes(1);
  });
});
