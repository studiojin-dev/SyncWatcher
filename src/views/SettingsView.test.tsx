import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import SettingsView from './SettingsView';
import type { DistributionInfo } from '../context/DistributionContext';

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
  setLaunchAtLoginMock,
  resetSettingsMock,
} = vi.hoisted(() => ({
  distributionState: {
    loaded: true,
    info: createDistributionInfo(),
  },
  updateSettingsMock: vi.fn(),
  setLaunchAtLoginMock: vi.fn(),
  resetSettingsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('../utils/pathAccess', () => ({
  capturePathAccess: vi.fn(),
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

vi.mock('../hooks/useDistribution', () => ({
  useDistribution: () => ({
    info: distributionState.info,
    loaded: distributionState.loaded,
    resolve: vi.fn(async () => distributionState.info),
  }),
}));

vi.mock('../config/appLinks', () => ({
  lemonSqueezyCheckoutUrl: 'https://store.studiojin.dev/checkout/buy/test-link',
  privacyPolicyUrl: 'https://example.com/privacy',
  termsOfServiceUrl: 'https://example.com/terms',
}));

vi.mock('../components/settings/ExclusionSetsManager', () => ({
  ExclusionSetsManager: () => <div>exclusion-sets</div>,
}));

vi.mock('../components/features/LicenseActivation', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>license-modal</div> : null),
}));

function renderWithMantine() {
  return render(
    <MantineProvider>
      <SettingsView />
    </MantineProvider>,
  );
}

describe('SettingsView', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    distributionState.loaded = true;
    distributionState.info = createDistributionInfo();
    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_mcp_stdio_config_example') {
        return {
          command: '/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher',
          args: ['--mcp-stdio', '--mcp-token', 'swmcp_initial'],
        };
      }
      if (command === 'regenerate_mcp_auth_token') {
        return {
          command: '/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher',
          args: ['--mcp-stdio', '--mcp-token', 'swmcp_regenerated'],
        };
      }
      return null;
    });
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

  it('shows the license support section and opens the license modal', () => {
    renderWithMantine();

    expect(screen.getByText('settings.sectionLicense')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'about.purchaseLicense' })).toHaveAttribute(
      'href',
      'https://store.studiojin.dev/checkout/buy/test-link',
    );
    fireEvent.click(screen.getByRole('button', { name: 'license.enterLicense' }));

    expect(screen.getByText('license-modal')).toBeInTheDocument();
  });

  it('hides the external checkout link in the App Store channel', () => {
    distributionState.info = createDistributionInfo({
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
    });

    renderWithMantine();

    expect(screen.queryByRole('link', { name: 'about.purchaseLicense' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'license.appStorePurchase' })).toBeInTheDocument();
  });

  it('renders the MCP stdio config example using the installed executable path', async () => {
    renderWithMantine();

    expect(await screen.findByText('settings.mcpConfigExampleTitle')).toBeInTheDocument();
    expect(
      screen.getByText('/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher', {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('--mcp-stdio', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('--mcp-token', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('swmcp_initial', { exact: false })).toBeInTheDocument();
  });

  it('regenerates the MCP auth token and refreshes the example', async () => {
    renderWithMantine();

    expect(await screen.findByText('swmcp_initial', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings.mcpRegenerateToken' }));

    expect(await screen.findByText('swmcp_regenerated', { exact: false })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('regenerate_mcp_auth_token');
  });

  it('shows a retryable error when loading the MCP example fails', async () => {
    invokeMock.mockImplementationOnce(async () => {
      throw new Error('load failed');
    });

    renderWithMantine();

    expect(await screen.findByText('load failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText('swmcp_initial', { exact: false })).toBeInTheDocument();
  });

  it('shows an inline error when token regeneration fails', async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_mcp_stdio_config_example') {
        return {
          command: '/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher',
          args: ['--mcp-stdio', '--mcp-token', 'swmcp_initial'],
        };
      }
      if (command === 'regenerate_mcp_auth_token') {
        throw new Error('regen failed');
      }
      return null;
    });

    renderWithMantine();

    expect(await screen.findByText('swmcp_initial', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings.mcpRegenerateToken' }));

    expect(await screen.findByText('regen failed')).toBeInTheDocument();
    expect(screen.getByText('swmcp_initial', { exact: false })).toBeInTheDocument();
  });
});
