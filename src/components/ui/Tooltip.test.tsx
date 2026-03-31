import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('attaches aria-describedby to the focused trigger button', async () => {
    render(
      <Tooltip content="Helpful description">
        <button type="button">Open help</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Open help' });
    fireEvent.focus(trigger);

    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-describedby');
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Helpful description');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
  });
});
