import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import LicenseActivation from './LicenseActivation';
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

const {
  distributionState,
  updateSettingsMock,
} = vi.hoisted(() => {
  const distributionState = {
    loaded: true,
    info: createDistributionInfo(),
    resolve: vi.fn(async () => distributionState.info),
  };

  return {
    distributionState,
    updateSettingsMock: vi.fn(),
  };
});
const invokeMock = vi.mocked(invoke);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'license.title': 'License',
        'license.enterKeyDescription': 'Enter your key.',
        'license.keyPlaceholder': 'License key',
        'license.activate': 'Activate',
        'license.activating': 'Activating...',
        'license.activated': 'Activated!',
        'license.invalid': 'Invalid license key.',
        'license.enterLicense': 'Enter License',
        'license.manage': 'Manage License',
        'license.manageDescription': 'Manage your supporter license.',
        'license.currentKey': 'Current Key',
        'license.remove': 'Remove License',
        'license.removing': 'Removing...',
        'license.removed': 'License removed.',
        'license.removeFailed': 'Failed to remove license.',
        'license.appStoreTitle': 'App Store Support',
        'license.appStoreDescription': 'Support SyncWatcher in the App Store.',
        'license.appStoreSupportStatus': 'Support status',
        'license.appStoreSupporterActive': 'Support active',
        'license.appStorePurchase': 'Purchase Supporter',
        'license.appStorePurchasing': 'Purchasing...',
        'license.appStorePurchased': 'Purchased!',
        'license.appStorePurchaseFailed': 'Purchase failed.',
        'license.appStorePending': 'Purchase pending.',
        'license.appStoreRestored': 'Restored!',
        'license.appStoreRestoreFailed': 'Restore failed.',
        'license.appStoreRestoring': 'Restoring...',
        'license.restore': 'Restore',
        'about.registered': 'Registered',
        'about.unregistered': 'Unregistered',
        'common.cancel': 'Cancel',
        'common.ok': 'OK',
        'common.loading': 'Loading...',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    updateSettings: updateSettingsMock,
  }),
}));

vi.mock('../../hooks/useDistribution', () => ({
  useDistribution: () => ({
    info: distributionState.info,
    loaded: distributionState.loaded,
    resolve: distributionState.resolve,
  }),
}));

describe('LicenseActivation', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    updateSettingsMock.mockReset();
    distributionState.loaded = true;
    distributionState.info = createDistributionInfo();
  });

  it('activates a license key for an unregistered device', async () => {
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case 'get_supporter_status':
          return { isRegistered: false, provider: 'lemon_squeezy' };
        case 'get_license_status':
          return { isRegistered: false, licenseKey: null };
        case 'activate_license_key':
          return { valid: true, error: null };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    render(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Enter your key.')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('License key'), 'abcd-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('activate_license_key', {
        licenseKey: 'abcd-1234',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Activated!')).toBeInTheDocument();
    });
    expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: true });
  });

  it('shows the current key and removes a registered license', async () => {
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case 'get_supporter_status':
          return { isRegistered: true, provider: 'lemon_squeezy' };
        case 'get_license_status':
          return { isRegistered: true, licenseKey: 'abcd…1234' };
        case 'deactivate_license_key':
          return { success: true, error: null };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    render(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Manage your supporter license.')).toBeInTheDocument();
    expect(screen.getByText('abcd…1234')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove License' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('deactivate_license_key');
    });
    await waitFor(() => {
      expect(screen.getByText('License removed.')).toBeInTheDocument();
    });
    expect(updateSettingsMock).toHaveBeenCalledWith({ isRegistered: false });
  });

  it('reloads registered status when the modal is reopened', async () => {
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case 'get_supporter_status':
          return { isRegistered: true, provider: 'lemon_squeezy' };
        case 'get_license_status':
          return { isRegistered: true, licenseKey: 'abcd…1234' };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const { rerender } = render(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Manage your supporter license.')).toBeInTheDocument();
    expect(screen.getByText('abcd…1234')).toBeInTheDocument();

    rerender(<LicenseActivation open={false} onClose={vi.fn()} />);
    rerender(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Manage your supporter license.')).toBeInTheDocument();
    expect(screen.getByText('abcd…1234')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'get_license_status'),
    ).toHaveLength(2);
  });

  it('renders App Store purchase and restore controls without license-key UI', async () => {
    distributionState.info = createDistributionInfo({
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
    });

    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case 'get_supporter_status':
          return { isRegistered: false, provider: 'app_store' };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    render(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Support SyncWatcher in the App Store.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('License key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purchase Supporter' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('get_license_status');
  });

  it('hides App Store purchase and restore controls after supporter status is active', async () => {
    distributionState.info = createDistributionInfo({
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
    });

    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case 'get_supporter_status':
          return { isRegistered: true, provider: 'app_store' };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    render(<LicenseActivation open onClose={vi.fn()} />);

    expect(await screen.findByText('Registered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Purchase Supporter' })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('get_license_status');
  });
});
