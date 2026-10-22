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

const { checkMock, closeMock, downloadAndInstallMock, relaunchMock, showToastMock, settingsState } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  closeMock: vi.fn(async (_rid: number) => undefined),
  downloadAndInstallMock: vi.fn(),
  relaunchMock: vi.fn(),
  showToastMock: vi.fn(),
  settingsState: { updateChannel: 'stable' as 'stable' | 'beta' },
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
  Update: class Update {
    rid: number;
    currentVersion: string;
    version: string;
    date?: string;
    body?: string;
    rawJson: Record<string, unknown>;

    constructor(metadata: {
      rid: number;
      currentVersion: string;
      version: string;
      date?: string;
      body?: string;
      rawJson: Record<string, unknown>;
    }) {
      this.rid = metadata.rid;
      this.currentVersion = metadata.currentVersion;
      this.version = metadata.version;
      this.date = metadata.date;
      this.body = metadata.body;
      this.rawJson = metadata.rawJson;
    }

    downloadAndInstall(onEvent?: (event: unknown) => void) {
      return downloadAndInstallMock(onEvent);
    }

    close() {
      return closeMock(this.rid);
    }
  },
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: { updateChannel: settingsState.updateChannel },
    loaded: true,
    updateSettings: vi.fn(),
    setLaunchAtLogin: vi.fn(),
    resetSettings: vi.fn(),
  }),
}));

function createUpdateMetadata(overrides: Record<string, unknown> = {}) {
  return {
    rid: 7,
    currentVersion: '1.0.0',
    version: '1.2.3',
    date: '2026-03-23T00:00:00Z',
    body: 'Release notes',
    rawJson: {},
    channel: 'stable',
    endpoint: 'https://github.com/studiojin-dev/SyncWatcher/releases/latest/download/latest.json',
    ...overrides,
  };
}

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
        case 'update.prereleaseNotice':
          return 'This is a beta build.';
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
    closeMock.mockClear();
    downloadAndInstallMock.mockReset();
    relaunchMock.mockReset();
    showToastMock.mockReset();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'check_for_app_update') {
        return checkMock(args);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    settingsState.updateChannel = 'stable';
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

  it('passes the configured update channel to the backend check', async () => {
    settingsState.updateChannel = 'beta';
    checkMock.mockResolvedValue(null);

    render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('check_for_app_update', { channel: 'beta' });
    });
  });

  it('discards a dismissed stable update and re-queries when the channel switches to beta', async () => {
    checkMock.mockResolvedValueOnce(createUpdateMetadata({ version: '2.1.1' }));

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v2.1.1 is available')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('Update')).not.toBeInTheDocument();

    settingsState.updateChannel = 'beta';
    checkMock.mockResolvedValueOnce(createUpdateMetadata({ version: '2.2.0-beta.1', channel: 'beta' }));
    rerender(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={1}
      />,
    );

    expect(await screen.findByText('v2.2.0-beta.1 is available')).toBeInTheDocument();
    expect(closeMock).toHaveBeenCalledWith(7);
    expect(invokeMock).toHaveBeenLastCalledWith('check_for_app_update', { channel: 'beta' });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('retries the beta endpoint when a dismissed result came from the stable fallback', async () => {
    settingsState.updateChannel = 'beta';
    // Beta resolution failed in the backend, which fell back to the stable manifest.
    checkMock.mockResolvedValueOnce(createUpdateMetadata({ version: '2.1.1', channel: 'stable' }));

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v2.1.1 is available')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));

    checkMock.mockResolvedValueOnce(createUpdateMetadata({ rid: 8, version: '2.2.0-beta.1', channel: 'beta' }));
    rerender(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={1}
      />,
    );

    expect(await screen.findByText('v2.2.0-beta.1 is available')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('check_for_app_update', { channel: 'beta' });
    expect(closeMock).toHaveBeenCalledWith(7);
  });

  it('reopens the cached update on a manual check when the channel is unchanged', async () => {
    checkMock.mockResolvedValueOnce(createUpdateMetadata({ version: '2.1.1' }));

    const { rerender } = render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v2.1.1 is available')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));

    rerender(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={1}
      />,
    );

    expect(await screen.findByText('v2.1.1 is available')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('marks pre-release versions in the update modal', async () => {
    settingsState.updateChannel = 'beta';
    checkMock.mockResolvedValue(createUpdateMetadata({ version: '2.2.0-beta.1', channel: 'beta' }));

    render(
      <UpdateChecker
        autoCheckEnabled
        manualCheckRequestNonce={0}
      />,
    );

    expect(await screen.findByText('v2.2.0-beta.1 is available')).toBeInTheDocument();
    expect(screen.getByText('This is a beta build.')).toBeInTheDocument();
  });

  it('keeps the existing install flow when an update is available', async () => {
    downloadAndInstallMock.mockImplementation(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 10 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 10 } });
      onEvent?.({ event: 'Finished' });
    });
    checkMock.mockResolvedValue(createUpdateMetadata());

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
    downloadAndInstallMock.mockRejectedValue(new Error('boom'));
    checkMock.mockResolvedValue(createUpdateMetadata({ body: null }));

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
