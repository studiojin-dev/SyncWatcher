import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';
import { getVersion } from '@tauri-apps/api/app';
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

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
  isRegistered: false,
  distributionLoaded: true,
  distributionInfo: createDistributionInfo(),
  translations: {
    appName: 'SyncWatcher',
    'nav.syncTasks': 'Sync Tasks',
    'nav.recurringSchedules': 'Recurring Schedules',
    'nav.dashboard': 'Dashboard',
    'nav.activityLog': 'Activity Log',
    'nav.settings': 'Settings',
    'nav.help': 'Help',
    'nav.about': 'About',
    'about.unregistered': 'Free Use (Personal & Commercial)',
    'about.registered': 'License Supporter',
    'about.purchaseLicense': 'Optional License Support',
    'license.enterLicense': 'Enter License',
    'license.manage': 'Manage License',
    'license.appStorePurchase': 'Purchase Supporter',
    'license.restore': 'Restore',
    'common.loading': 'Loading...',
  } as Record<string, string>,
}));

const mockGetVersion = vi.mocked(getVersion);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => mockState.translations[key] ?? key,
  }),
}));

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      isRegistered: mockState.isRegistered,
    },
  }),
}));

vi.mock('../../hooks/useDistribution', () => ({
  useDistribution: () => ({
    info: mockState.distributionInfo,
    loaded: mockState.distributionLoaded,
    resolve: vi.fn(async () => mockState.distributionInfo),
  }),
}));

vi.mock('../../config/appLinks', () => ({
  lemonSqueezyCheckoutUrl: 'https://store.studiojin.dev/checkout/buy/test-link',
}));

vi.mock('../features/LicenseActivation', () => ({
  default: ({ open }: { open: boolean }) => (
    open ? <div data-testid="license-activation-modal">License Activation Modal</div> : null
  ),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isRegistered = false;
    mockState.distributionLoaded = true;
    mockState.distributionInfo = createDistributionInfo();
    mockGetVersion.mockResolvedValue('1.2.0-beta');
  });

  it('keeps purchase and activation actions for unregistered users', async () => {
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);
    await screen.findByText('v1.2.0-beta');

    const purchaseLink = screen.getByRole('link', { name: 'Optional License Support' });
    expect(purchaseLink).toHaveAttribute(
      'href',
      'https://store.studiojin.dev/checkout/buy/test-link',
    );
    expect(purchaseLink).toHaveAttribute('target', '_blank');
    expect(purchaseLink).toHaveAttribute('rel', 'noopener noreferrer');

    const enterLicenseButton = screen.getByRole('button', { name: 'Enter License' });
    fireEvent.click(enterLicenseButton);
    expect(screen.getByTestId('license-activation-modal')).toBeInTheDocument();
  });

  it('shows the manage action for registered GitHub users', async () => {
    mockState.isRegistered = true;
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);
    await screen.findByText('v1.2.0-beta');

    expect(screen.getByRole('button', { name: 'Manage License' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Optional License Support' })).not.toBeInTheDocument();
  });

  it('keeps App Store purchase UI free of external checkout links', async () => {
    mockState.distributionInfo = createDistributionInfo({
      channel: 'app_store',
      purchaseProvider: 'app_store',
      canSelfUpdate: false,
      appStoreAppId: '123456789',
      appStoreUrl: 'https://apps.apple.com/us/app/id123456789',
    });

    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);
    await screen.findByText('v1.2.0-beta');

    expect(screen.queryByRole('link', { name: 'Optional License Support' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purchase Supporter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('renders the runtime app version in the header badge', async () => {
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);

    expect(await screen.findByText('v1.2.0-beta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recurring Schedules' })).toBeInTheDocument();
  });
});
