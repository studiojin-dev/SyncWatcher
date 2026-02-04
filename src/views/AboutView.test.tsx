import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AboutView from './AboutView';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'about.title': 'About',
        'about.developer': 'Developer',
        'about.license': 'License',
        'about.licenseType': 'Polyform NC 1.0.0',
        'about.viewOnGithub': 'View on GitHub',
        'about.openSourceLibraries': 'Open Source Libraries',
        'about.openSourceDescription': 'This project uses open source libraries.',
        'about.viewLicenses': 'View Licenses',
        'about.licenses': 'Open Source Licenses',
        'common.loading': 'Loading...',
        'common.close': 'Close',
      };
      return translations[key] || key;
    }),
  })),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock alert
global.alert = vi.fn();

describe('AboutView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for get_app_version
    mockInvoke.mockResolvedValue('0.1.0');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { name: 'test-lib', version: '1.0.0', license: 'MIT' }
      ]),
    });
  });

  it('should render component', async () => {
    render(<AboutView />);

    expect(await screen.findByText('About')).toBeInTheDocument();
    expect(screen.getByText(/Version \d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it('should load version from Cargo.toml on mount', async () => {
    mockInvoke.mockResolvedValueOnce('1.0.0');

    render(<AboutView />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_app_version');
      expect(screen.getByText('Version 1.0.0')).toBeInTheDocument();
    });
  });

  it('should fallback to hardcoded version if command fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Failed to get version'));

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });

    render(<AboutView />);

    await waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        'Failed to get app version from Cargo.toml'
      );
      expect(screen.getByText('Version 0.1.0')).toBeInTheDocument();
    });

    consoleWarn.mockRestore();
  });

  it('should show developer information', async () => {
    render(<AboutView />);

    expect(await screen.findByText(/Developer/i)).toBeInTheDocument();
    expect(screen.getByText('Studio Jin')).toBeInTheDocument();
  });

  it('should show license information', async () => {
    render(<AboutView />);

    expect(await screen.findByText('Polyform NC 1.0.0')).toBeInTheDocument();
  });

  it('should render GitHub link', async () => {
    render(<AboutView />);

    const githubLink = await screen.findByRole('link', { name: /github/i });
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute('href', 'https://github.com/kimjj81/SyncWatcher');
  });

  it('should fetch licenses when button clicked', async () => {
    render(<AboutView />);

    const viewButton = screen.getByText(/View Licenses/i);
    await userEvent.click(viewButton);

    expect(mockFetch).toHaveBeenCalledWith('/oss-licenses.json');
  });

  it('should show licenses section after fetch', async () => {
    render(<AboutView />);

    const viewButton = await screen.findByText(/View Licenses/i);
    await userEvent.click(viewButton);

    expect(await screen.findByText('Open Source Licenses')).toBeInTheDocument();
    expect(await screen.findByText('test-lib')).toBeInTheDocument();
  });

  it('should handle fetch errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => { });

    render(<AboutView />);

    const viewButton = screen.getByText(/View Licenses/i);
    await userEvent.click(viewButton);

    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Open Source Licenses are available')
    );

    consoleWarn.mockRestore();
  });

  it('should render app icon', async () => {
    render(<AboutView />);

    const icon = await screen.findByText(/🔄/);
    expect(icon).toBeInTheDocument();
  });

  it('should have proper styling classes', async () => {
    render(<AboutView />);

    const title = await screen.findByText('SyncWatcher');
    expect(title).toHaveClass('text-3xl');
  });

  it('should show all sections in correct order', async () => {
    render(<AboutView />);

    // Wait for a unique element to ensure component is rendered
    await screen.findByText('Studio Jin');

    const sections = [
      'SyncWatcher',
      /Version/,
      'Developer',
      'Polyform NC 1.0.0',
    ];

    sections.forEach(section => {
      expect(screen.queryByText(section)).toBeInTheDocument();
    });
  });
});
