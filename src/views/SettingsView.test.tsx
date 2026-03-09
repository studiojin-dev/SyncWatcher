import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from './SettingsView';

const {
  updateSettingsMock,
  setLaunchAtLoginMock,
  resetSettingsMock,
} = vi.hoisted(() => ({
  updateSettingsMock: vi.fn(),
  setLaunchAtLoginMock: vi.fn(),
  resetSettingsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      language: 'en',
      theme: 'system',
      dataUnitSystem: 'binary',
      notifications: true,
      stateLocation: '',
      maxLogLines: 10000,
      closeAction: 'quit',
      isRegistered: false,
      launchAtLogin: false,
      mcpEnabled: false,
    },
    loaded: true,
    updateSettings: updateSettingsMock,
    setLaunchAtLogin: setLaunchAtLoginMock,
    resetSettings: resetSettingsMock,
  }),
}));

vi.mock('../components/settings/ExclusionSetsManager', () => ({
  ExclusionSetsManager: () => <div>exclusion-sets</div>,
}));

function renderWithMantine() {
  return render(
    <MantineProvider>
      <SettingsView />
    </MantineProvider>,
  );
}

describe('SettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls setLaunchAtLogin when the launch-at-login switch is toggled', () => {
    renderWithMantine();

    const title = screen.getByText('settings.launchAtLogin');
    const row = title.parentElement?.parentElement;
    const checkbox = row?.querySelector('input[type="checkbox"]');

    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error('launch-at-login checkbox not found');
    }

    fireEvent.click(checkbox);

    expect(setLaunchAtLoginMock).toHaveBeenCalledWith(true);
  });
});
