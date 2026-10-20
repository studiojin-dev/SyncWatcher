import { renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDialogAttention } from './useDialogAttention';

describe('useDialogAttention', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('does not request attention while closed', () => {
    renderHook(() => useDialogAttention(false));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requests attention once each time the dialog opens', () => {
    const { rerender } = renderHook(({ opened }) => useDialogAttention(opened), {
      initialProps: { opened: true },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('request_dialog_attention');

    rerender({ opened: true });
    expect(invoke).toHaveBeenCalledTimes(1);

    rerender({ opened: false });
    rerender({ opened: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('swallows backend failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error('no window'));

    renderHook(() => useDialogAttention(true));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
