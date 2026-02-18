import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import YamlEditorModal from './YamlEditorModal';
import { YamlParseError } from '../../hooks/useYamlStore';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// Mock i18n
const mockTranslations: Record<string, string> = {
  'yamlEditor.title': 'Edit YAML File',
  'yamlEditor.parseError': 'YAML Parsing Error',
  'yamlEditor.line': 'Line',
  'yamlEditor.column': 'Column',
  'yamlEditor.jumpToError': 'Jump to Error Line',
  'yamlEditor.placeholder': 'Enter YAML content...',
  'yamlEditor.validationError': 'Validation Error',
  'yamlEditor.validYaml': 'Valid YAML',
  'yamlEditor.validYamlDescription': 'This YAML is valid and ready to save.',
  'yamlEditor.openExternal': 'Open in External Editor',
  'yamlEditor.saveAndReload': 'Save & Reload',
  'yamlEditor.unsavedChangesWarning': 'You have unsaved changes. Close anyway?',
  'common.cancel': 'Cancel',
};

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => mockTranslations[key] || key),
  })),
}));

// Wrapper with MantineProvider
function renderWithMantine(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe('YamlEditorModal', () => {
  const mockOnClose = vi.fn();

  const mockError: YamlParseError = {
    type: 'PARSE_ERROR',
    message: 'duplicated mapping key',
    line: 5,
    column: 10,
    filePath: '/test/config/tasks.yaml',
    rawContent: '- name: Task 1\n  source: /path1\n  target: /path2'
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render modal with error information', () => {
    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={mockError} />);

    expect(screen.getByText('Edit YAML File')).toBeInTheDocument();
    expect(screen.getByText('YAML Parsing Error')).toBeInTheDocument();
    expect(screen.getByText(/duplicated mapping key/)).toBeInTheDocument();
  });

  it('should display error line and column numbers', () => {
    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={mockError} />);

    // The error alert should be visible with line/column info
    expect(screen.getByText('YAML Parsing Error')).toBeInTheDocument();
    expect(screen.getByText(/5/)).toBeInTheDocument(); // Line number
  });

  it('should display jump to error button when line info exists', () => {
    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={mockError} />);

    expect(screen.getByText('Jump to Error Line')).toBeInTheDocument();
  });

  it.each([
    {
      caseName: 'valid YAML',
      rawContent: '- name: Task 1\n  source: /path1\n  target: /path2',
      validationText: 'Valid YAML',
      saveDisabled: false,
    },
    {
      caseName: 'invalid YAML',
      rawContent: ': : :\ninvalid: [[[[',
      validationText: 'Validation Error',
      saveDisabled: true,
    },
  ])('should validate $caseName and update save button state', async ({ rawContent, validationText, saveDisabled }) => {
    const testError: YamlParseError = {
      ...mockError,
      rawContent
    };

    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={testError} />);

    await waitFor(() => {
      expect(screen.getByText(validationText)).toBeInTheDocument();
    });

    const saveButton = screen.getByRole('button', { name: /Save & Reload/ });
    if (saveDisabled) {
      expect(saveButton).toHaveAttribute('data-disabled');
      return;
    }

    expect(saveButton).toBeEnabled();
  });

  it('should call invoke to open external editor', async () => {
    mockInvoke.mockResolvedValueOnce('');

    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={mockError} />);

    const externalButton = screen.getByText('Open in External Editor');
    await userEvent.click(externalButton);

    expect(mockInvoke).toHaveBeenCalledWith('open_in_editor', {
      path: mockError.filePath
    });
  });

  it('should call onClose when cancel button clicked', async () => {
    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={mockError} />);

    const cancelButton = screen.getByText('Cancel');
    await userEvent.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('should render without line/column info', () => {
    const errorWithoutLineInfo: YamlParseError = {
      type: 'PARSE_ERROR',
      message: 'Unknown error',
      filePath: mockError.filePath,
      rawContent: mockError.rawContent
    };

    renderWithMantine(<YamlEditorModal opened={true} onClose={mockOnClose} error={errorWithoutLineInfo} />);

    expect(screen.getByText('Edit YAML File')).toBeInTheDocument();
    expect(screen.queryByText('YAML Parsing Error')).not.toBeInTheDocument();
  });
});
