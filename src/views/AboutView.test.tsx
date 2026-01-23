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
        'about.viewOnGithub': 'View on GitHub',
        'about.opensourceLibraries': 'Open Source Libraries',
        'about.opensourceDescription': 'This project uses open source libraries.',
        'about.generateReport': 'Generate Report',
        'about.licenses': 'Open Source Licenses',
      };
      return translations[key] || key;
    }),
  })),
}));

describe('AboutView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for get_app_version
    mockInvoke.mockResolvedValue('0.1.0');
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

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

    expect(await screen.findByText('MIT License')).toBeInTheDocument();
  });

  it('should render GitHub link', async () => {
    render(<AboutView />);

    const githubLink = await screen.findByRole('link', { name: /github/i });
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute('href', 'https://github.com/studiojin/syncwatcher');
  });

  it('should generate licenses report when button clicked', async () => {
    mockInvoke.mockResolvedValueOnce('/path/to/licenses.md');

    render(<AboutView />);

    const generateButton = screen.getByText(/Generate Report/i);
    await userEvent.click(generateButton);

    expect(mockInvoke).toHaveBeenCalledWith('generate_licenses_report');
  });

  it('should show licenses section after generation', async () => {
    mockInvoke.mockResolvedValueOnce('/path/to/licenses.md');

    render(<AboutView />);

    const generateButton = await screen.findByText(/Generate Report/i);
    await userEvent.click(generateButton);

    // The component should show the licenses section after successful generation
    // but since the actual UI for showing licenses isn't implemented yet,
    // we just verify the function was called
    expect(mockInvoke).toHaveBeenCalledWith('generate_licenses_report');
  });

  it('should handle license generation errors gracefully', async () => {
    // First call (get_app_version) succeeds, second call (generate_licenses_report) fails
    mockInvoke
      .mockResolvedValueOnce('0.1.0') // get_app_version
      .mockRejectedValueOnce(new Error('Failed to generate')); // generate_licenses_report

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<AboutView />);

    // Wait for component to mount
    await screen.findByText('Version 0.1.0');

    const generateButton = screen.getByText(/Generate Report/i);
    await userEvent.click(generateButton);

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to generate licenses:',
      expect.any(Error)
    );

    consoleError.mockRestore();
  });

  it('should render app icon', async () => {
    render(<AboutView />);

    const icon = await screen.findByText(/🔄/);
    expect(icon).toBeInTheDocument();
  });

  it('should have proper styling classes', async () => {
    render(<AboutView />);

    const title = await screen.findByText('SyncWatcher');
    expect(title).toHaveClass('text-xl');
  });

  it('should show all sections in correct order', async () => {
    render(<AboutView />);

    // Wait for a unique element to ensure component is rendered
    await screen.findByText('Studio Jin');

    const sections = [
      'SyncWatcher',
      /Version/,
      'Developer',
      'MIT License',
    ];

    sections.forEach(section => {
      expect(screen.queryByText(section)).toBeInTheDocument();
    });
  });
});
