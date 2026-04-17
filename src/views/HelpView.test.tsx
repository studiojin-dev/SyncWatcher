import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HelpView from './HelpView';

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'help.title': 'Help & Documentation',
        'help.safetyChecklist.title': 'Core Safety Checklist',
        'help.safetyChecklist.checksumCost': 'Checksum mode compares full-file hashes when metadata matches, so CPU/IO cost can increase.',
        'help.safetyChecklist.deleteMissingRemoved': '`deleteMissing` automatic deletion is removed. Delete through Orphan workflow only.',
        'help.sections.watchRuntime.title': 'Watch / Runtime Behavior',
        'help.sections.watchRuntime.queuedState': 'Watch-triggered syncs are queued and shown as QUEUED when waiting.',
        'help.sections.watchRuntime.systemMetadataAlwaysExcluded':
          'Root metadata directories used by macOS are always excluded from sync.',
        'help.sections.recurringSchedules.title': 'Recurring Schedule Engine',
        'help.sections.recurringSchedules.runtimeOnly':
          'Recurring schedules run only while the SyncWatcher process is alive.',
        'help.recurringNotice.title': 'Recurring Schedule Runtime Rule',
        'help.recurringNotice.description':
          'Recurring schedules only run while the SyncWatcher process is alive.',
        'help.sections.conflictOrphan.title': 'Conflict / Cleanup Workflow',
        'help.sections.conflictOrphan.orphanWorkflow': 'Use Orphan scan -> select -> confirm delete for target-only files.',
        'help.sections.mcpControl.title': 'MCP Control',
        'help.sections.mcpControl.runningAppOnly':
          'SyncWatcher exposes MCP as a thin stdio relay to the running app. It does not run sync logic directly inside the relay.',
        'help.sections.mcpControl.tokenRequired':
          'Every MCP request must include the current token from SyncWatcher. Regenerating the token invalidates old client configs immediately.',
        'settings.mcpConfigExampleTitle': 'MCP Client Config Example',
        'settings.mcpConfigExampleDesc':
          'Point your MCP client at the installed SyncWatcher executable and pass both --mcp-stdio and the current --mcp-token value.',
        'settings.mcpRegenerateToken': 'Regenerate MCP Token',
        'settings.mcpRegeneratingToken': 'Regenerating...',
        'common.retry': 'Retry',
        'help.feedback.title': 'Questions & Suggestions',
        'help.feedback.description': 'Share questions or feature suggestions in GitHub Discussions.',
        'help.feedback.linkText': 'Questions/Suggestions (Discussions)',
        'help.feedback.issueLinkText': 'Report Bugs (Issues)',
      };
      return translations[key] ?? key;
    }),
  })),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('HelpView', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_mcp_stdio_config_example') {
        return {
          command: '/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher',
          args: ['--mcp-stdio', '--mcp-token', 'swmcp_help_initial'],
        };
      }
      if (command === 'regenerate_mcp_auth_token') {
        return {
          command: '/Applications/Sync Watcher.app/Contents/MacOS/syncwatcher',
          args: ['--mcp-stdio', '--mcp-token', 'swmcp_help_regenerated'],
        };
      }
      return null;
    });
  });

  it('renders safety checklist and runtime/conflict guidance sections', () => {
    render(<HelpView />);

    expect(screen.getByText('Core Safety Checklist')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Checksum mode compares full-file hashes when metadata matches, so CPU/IO cost can increase.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('`deleteMissing` automatic deletion is removed. Delete through Orphan workflow only.')
    ).toBeInTheDocument();
    expect(screen.getByText('Watch / Runtime Behavior')).toBeInTheDocument();
    expect(
      screen.getByText('Watch-triggered syncs are queued and shown as QUEUED when waiting.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Root metadata directories used by macOS are always excluded from sync.')
    ).toBeInTheDocument();
    expect(screen.getByText('Recurring Schedule Engine')).toBeInTheDocument();
    expect(
      screen.getAllByText('Recurring schedules only run while the SyncWatcher process is alive.')[0]
    ).toBeInTheDocument();
    expect(screen.getByText('Conflict / Cleanup Workflow')).toBeInTheDocument();
    expect(
      screen.getByText('Use Orphan scan -> select -> confirm delete for target-only files.')
    ).toBeInTheDocument();
    expect(screen.getByText('MCP Control')).toBeInTheDocument();
    expect(
      screen.getByText(
        'SyncWatcher exposes MCP as a thin stdio relay to the running app. It does not run sync logic directly inside the relay.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Every MCP request must include the current token from SyncWatcher. Regenerating the token invalidates old client configs immediately.'
      )
    ).toBeInTheDocument();
  });

  it('renders the MCP example and regenerates the token', async () => {
    render(<HelpView />);

    expect(await screen.findByText('MCP Client Config Example')).toBeInTheDocument();
    expect(screen.getByText('swmcp_help_initial', { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate MCP Token' }));

    expect(await screen.findByText('swmcp_help_regenerated', { exact: false })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('regenerate_mcp_auth_token');
  });

  it('renders discussions and issues links', () => {
    render(<HelpView />);

    expect(screen.getByText('Questions & Suggestions')).toBeInTheDocument();

    const discussionsLink = screen.getByRole('link', {
      name: 'Questions/Suggestions (Discussions)',
    });
    const issuesLink = screen.getByRole('link', {
      name: 'Report Bugs (Issues)',
    });

    expect(discussionsLink).toHaveAttribute(
      'href',
      'https://github.com/studiojin-dev/SyncWatcher/discussions'
    );
    expect(issuesLink).toHaveAttribute(
      'href',
      'https://github.com/studiojin-dev/SyncWatcher/issues'
    );
    expect(discussionsLink).toHaveAttribute('target', '_blank');
    expect(issuesLink).toHaveAttribute('target', '_blank');
    expect(discussionsLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(issuesLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
