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
        'help.feedback.linkText': 'Open GitHub Discussions',
      };
      return translations[key] ?? key;
    }),
  })),
}));

describe('HelpView', () => {
  it('renders discussions link for questions and suggestions', () => {
    render(<HelpView />);

    expect(screen.getByText('Questions & Suggestions')).toBeInTheDocument();

    const discussionsLink = screen.getByRole('link', {
      name: 'Open GitHub Discussions',
    });

    expect(discussionsLink).toHaveAttribute(
      'href',
      'https://github.com/studiojin-dev/SyncWatcher/discussions'
    );
    expect(discussionsLink).toHaveAttribute('target', '_blank');
    expect(discussionsLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
