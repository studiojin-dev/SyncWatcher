import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import LicenseActivation from './LicenseActivation';

const updateSettingsMock = vi.fn();
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

describe('LicenseActivation', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    updateSettingsMock.mockReset();
  });

  it('activates a license key for an unregistered device', async () => {
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
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
});
