import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';

const mockState = vi.hoisted(() => ({
  isRegistered: false,
  translations: {
    appName: 'SyncWatcher',
    'nav.syncTasks': 'Sync Tasks',
    'nav.dashboard': 'Dashboard',
    'nav.activityLog': 'Activity Log',
    'nav.settings': 'Settings',
    'nav.help': 'Help',
    'nav.about': 'About',
    'about.unregistered': 'Unregistered',
    'about.registered': 'Registered',
    'about.purchaseLicense': 'Purchase License',
    'license.enterLicense': 'Enter License',
    'about.supportTitle': 'One more pizza bite?',
    'about.supportHint': 'I am bowing dramatically.',
    'about.supportButton': 'Sponsor Another Slice',
    'about.supportModalTitle': 'Maximum Gratitude Mode',
    'about.supportModalMessage': 'Thank you for purchasing a license.',
    'about.supportModalConfirm': 'Yes, I Will Support',
    'about.supportModalCancel': 'Maybe Later',
    'common.close': 'Close',
  } as Record<string, string>,
}));

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

vi.mock('../features/LicenseActivation', () => ({
  default: ({ open }: { open: boolean }) => (
    open ? <div data-testid="license-activation-modal">License Activation Modal</div> : null
  ),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.isRegistered = false;
  });

  it('keeps purchase and activation actions for unregistered users', () => {
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);

    const purchaseLink = screen.getByRole('link', { name: 'Purchase License' });
    expect(purchaseLink).toHaveAttribute(
      'href',
      'https://studiojin.lemonsqueezy.com/checkout/buy/syncwatcher',
    );
    expect(purchaseLink).toHaveAttribute('target', '_blank');
    expect(purchaseLink).toHaveAttribute('rel', 'noopener noreferrer');

    const enterLicenseButton = screen.getByRole('button', { name: 'Enter License' });
    fireEvent.click(enterLicenseButton);
    expect(screen.getByTestId('license-activation-modal')).toBeInTheDocument();
  });

  it('shows support CTA and support modal for registered users', () => {
    mockState.isRegistered = true;
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);

    expect(screen.getByText('One more pizza bite?')).toBeInTheDocument();
    expect(screen.getByText('I am bowing dramatically.')).toBeInTheDocument();
    expect(screen.getByTestId('pizza-bite-animation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sponsor Another Slice' }));

    expect(screen.getByRole('heading', { name: 'Maximum Gratitude Mode' })).toBeInTheDocument();
    expect(screen.getByText('Thank you for purchasing a license.')).toBeInTheDocument();

    const supportLink = screen.getByRole('link', { name: 'Yes, I Will Support' });
    expect(supportLink).toHaveAttribute('href', 'https://buymeacoffee.com/studiojin_dev');
    expect(supportLink).toHaveAttribute('target', '_blank');
    expect(supportLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('closes support modal on cancel button and overlay click', () => {
    mockState.isRegistered = true;
    render(<Sidebar activeTab="sync-tasks" onTabChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sponsor Another Slice' }));
    expect(screen.getByRole('heading', { name: 'Maximum Gratitude Mode' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Maybe Later' }));
    expect(screen.queryByRole('heading', { name: 'Maximum Gratitude Mode' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sponsor Another Slice' }));
    fireEvent.click(screen.getByTestId('support-modal-overlay'));
    expect(screen.queryByRole('heading', { name: 'Maximum Gratitude Mode' })).not.toBeInTheDocument();
  });
});
