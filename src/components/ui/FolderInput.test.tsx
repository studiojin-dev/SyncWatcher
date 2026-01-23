import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FolderInput from './FolderInput';
import { open } from '@tauri-apps/plugin-dialog';
import { waitFor } from '@testing-library/react';

// Mock Tauri dialog plugin
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const mockOpen = open as unknown as ReturnType<typeof vi.fn>;

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => key),
  })),
}));

describe('FolderInput', () => {
  const mockOnChange = vi.fn();
  const defaultProps = {
    value: '/test/path',
    onChange: mockOnChange,
    name: 'test-input',
    label: 'Test Label',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render input field and browse button', () => {
    render(<FolderInput {...defaultProps} />);

    expect(screen.getByLabelText('Test Label')).toBeInTheDocument();
    expect(screen.getByTitle(/browse/i)).toBeInTheDocument();
  });

  it('should display current value in input', () => {
    render(<FolderInput {...defaultProps} value="/current/path" />);

    const input = screen.getByLabelText('Test Label');
    expect(input).toHaveValue('/current/path');
  });

  it('should call onChange when input value changes', () => {
    render(<FolderInput {...defaultProps} />);

    const input = screen.getByLabelText('Test Label');
    fireEvent.change(input, { target: { value: '/new/path' } });

    expect(mockOnChange).toHaveBeenCalledWith('/new/path');
  });

  it('should open folder dialog when browse button is clicked', async () => {
    mockOpen.mockResolvedValueOnce('/selected/path');

    render(<FolderInput {...defaultProps} />);

    const browseButton = screen.getByTitle(/browse/i);
    await userEvent.click(browseButton);

    expect(mockOpen).toHaveBeenCalledWith({ directory: true });
  });

  it('should update value when folder is selected', async () => {
    mockOpen.mockResolvedValueOnce('/selected/path');

    render(<FolderInput {...defaultProps} />);

    const browseButton = screen.getByTitle(/browse/i);
    await userEvent.click(browseButton);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith('/selected/path');
    });
  });

  it('should not update value when dialog is cancelled', async () => {
    mockOpen.mockResolvedValueOnce(null);

    render(<FolderInput {...defaultProps} />);

    const browseButton = screen.getByTitle(/browse/i);
    await userEvent.click(browseButton);

    // Should not call onChange
    expect(mockOnChange).not.toHaveBeenCalled();
  });

  it('should handle dialog errors gracefully', async () => {
    mockOpen.mockRejectedValueOnce(new Error('Dialog failed'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<FolderInput {...defaultProps} />);

    const browseButton = screen.getByTitle(/browse/i);
    await userEvent.click(browseButton);

    expect(mockOnChange).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to open folder dialog:',
      expect.any(Error)
    );

    consoleError.mockRestore();
  });

  it('should log warning for unexpected dialog result type', async () => {
    // Return unexpected type (array)
    mockOpen.mockResolvedValueOnce(['/unexpected', '/paths'] as any);

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<FolderInput {...defaultProps} />);

    const browseButton = screen.getByTitle(/browse/i);
    await userEvent.click(browseButton);

    expect(consoleWarn).toHaveBeenCalledWith(
      'Unexpected dialog result type:',
      'object'
    );

    consoleWarn.mockRestore();
  });

  it('should be required when marked as required', () => {
    render(<FolderInput {...defaultProps} />);

    const input = screen.getByLabelText('Test Label');
    expect(input).toBeRequired();
  });

  it('should have placeholder text', () => {
    render(<FolderInput {...defaultProps} />);

    const input = screen.getByLabelText('Test Label');
    expect(input).toHaveAttribute('placeholder');
  });
});
