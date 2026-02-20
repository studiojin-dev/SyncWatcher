import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HelpView from './HelpView';

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'help.title': 'Help & Documentation',
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
