import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
        'help.sections.conflictOrphan.title': 'Conflict / Cleanup Workflow',
        'help.sections.conflictOrphan.orphanWorkflow': 'Use Orphan scan -> select -> confirm delete for target-only files.',
        'help.feedback.title': 'Questions & Suggestions',
        'help.feedback.description': 'Share questions or feature suggestions in GitHub Discussions.',
        'help.feedback.linkText': 'Questions/Suggestions (Discussions)',
        'help.feedback.issueLinkText': 'Report Bugs (Issues)',
      };
      return translations[key] ?? key;
    }),
  })),
}));

describe('HelpView', () => {
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
    expect(screen.getByText('Conflict / Cleanup Workflow')).toBeInTheDocument();
    expect(
      screen.getByText('Use Orphan scan -> select -> confirm delete for target-only files.')
    ).toBeInTheDocument();
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
