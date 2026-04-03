import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import UpdateChecker from './UpdateChecker';
import type { DistributionInfo } from '../../context/DistributionContext';

function createDistributionInfo(
  overrides: Partial<DistributionInfo> = {},
): DistributionInfo {
  return {
    channel: 'github',
    purchaseProvider: 'lemon_squeezy',
    canSelfUpdate: true,
    appStoreAppId: null,
    appStoreCountry: 'us',
    appStoreUrl: null,
    legacyImportAvailable: false,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const { checkMock, relaunchMock, showToastMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  showToastMock: vi.fn(),
}));
const distributionState = vi.hoisted(() => {
  const distributionState = {
    loaded: true,
    info: createDistributionInfo(),
    resolvedInfo: createDistributionInfo(),
    resolve: vi.fn(async () => {
      distributionState.loaded = true;
      distributionState.info = distributionState.resolvedInfo;
      return distributionState.resolvedInfo;
    }),
  };

  return distributionState;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

vi.mock('../../hooks/useDistribution', () => ({
  useDistribution: () => ({
    info: distributionState.info,
    loaded: distributionState.loaded,
    resolve: distributionState.resolve,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { version?: string }) => {
      switch (key) {
        case 'update.title':
          return 'Update';
        case 'update.available':
          return `v${options?.version} is available`;
        case 'update.downloading':
          return 'Downloading...';
        case 'update.installing':
          return 'Installing... Please wait';
        case 'update.error':
          return 'Update failed';
        case 'update.later':
          return 'Later';
        case 'update.updateNow':
          return 'Update Now';
        case 'update.noneAvailable':
          return 'You are up to date.';
        case 'update.checkingAlready':
          return 'Update check already in progress.';
        case 'update.checkFailed':
          return 'Failed to check for updates.';
        case 'update.appStoreDescription':
          return 'Open the App Store to install this update.';
        case 'update.appStoreAvailable':
          return `App Store v${options?.version} is available`;
        case 'update.openAppStore':
          return 'Open App Store';
        case 'common.close':
          return 'Close';
        default:
          return key;
      }
    },
  }),
}));

describe('UpdateChecker', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    checkMock.mockReset();
    relaunchMock.mockReset();
    showToastMock.mockReset();
    invokeMock.mockReset();
    distributionState.loaded = true;
    distributionState.info = createDistributionInfo();
    distributionState.resolvedInfo = { ...distributionState.info };
  });

  it('checks once automatically when enabled and stays hidden when no update exists', async () => {
    checkMock.mockResolvedValue(null);

    render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText('Update')).not.toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('runs a manual update check when the request nonce changes', async () => {
    checkMock.mockResolvedValue(null);

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={0}
      />,
    );

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={1}
      />,
    );

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a success toast when a manual check finds no update', async () => {
    checkMock.mockResolvedValue(null);

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={0}
      />,
    );

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={1}
      />,
    );

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith('You are up to date.', 'success');
    });
  });

  it('ignores duplicate manual checks while a check is already in progress', async () => {
    const deferred = createDeferred<null>();
    checkMock.mockReturnValue(deferred.promise);

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={0}
      />,
    );

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={1}
      />,
    );

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={2}
      />,
    );

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith('Update check already in progress.', 'info');
    });

    deferred.resolve(null);
  });

  it('keeps the existing install flow when an update is available', async () => {
    const downloadAndInstallMock = vi.fn().mockImplementation(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 10 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 10 } });
      onEvent?.({ event: 'Finished' });
    });
    checkMock.mockResolvedValue({
      version: '1.2.3',
      body: 'Release notes',
      date: '2026-03-23',
      downloadAndInstall: downloadAndInstallMock,
    });

    render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v1.2.3 is available')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Update Now' }));

    await waitFor(() => {
      expect(downloadAndInstallMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(relaunchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('shows install errors in the modal when installation fails', async () => {
    const downloadAndInstallMock = vi.fn().mockRejectedValue(new Error('boom'));
    checkMock.mockResolvedValue({
      version: '1.2.3',
      body: null,
      date: '2026-03-23',
      downloadAndInstall: downloadAndInstallMock,
    });

    render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v1.2.3 is available')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Update Now' }));

    expect(await screen.findByText('Update failed')).toBeInTheDocument();
    expect(screen.getByText('Error: boom')).toBeInTheDocument();
  });

  it('shows an error toast when a manual update check fails', async () => {
    checkMock.mockRejectedValue(new Error('network'));

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={0}
      />,
    );

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={1}
      />,
    );

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith('Failed to check for updates.', 'error');
    });
  });

  it('authoritatively resolves App Store distribution before routing update checks', async () => {
    distributionState.loaded = false;
    distributionState.info = createDistributionInfo();
    distributionState.resolvedInfo = createDistributionInfo({
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
    });

    invokeMock.mockImplementation(async (command) => {
      if (command === 'check_app_store_update') {
        return {
          available: true,
          currentVersion: '1.0.0',
          latestVersion: '1.2.0',
          storeUrl: 'https://apps.apple.com/us/app/id123456789',
          manualOnly: false,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={0}
      />,
    );

    rerender(
      <UpdateChecker
        autoCheckEnabled={false}
        manualCheckRequestNonce={1}
      />,
    );

    expect(await screen.findByText('App Store v1.2.0 is available')).toBeInTheDocument();
    expect(checkMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('check_app_store_update');
    expect(screen.getByRole('link', { name: 'Open App Store' })).toHaveAttribute(
      'href',
      'https://apps.apple.com/us/app/id123456789',
    );
  });
});
