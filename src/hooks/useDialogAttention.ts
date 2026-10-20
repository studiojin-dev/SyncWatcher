import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * 팝업이 열릴 때 앱이 백그라운드면 창을 앞으로 가져오고 Dock 아이콘을 바운스시킨다.
 * 창이 이미 포커스 상태면 백엔드에서 아무것도 하지 않는다.
 */
export function useDialogAttention(opened: boolean) {
  useEffect(() => {
    if (!opened) {
      return;
    }

    const requestAttention = async () => {
      try {
        await invoke('request_dialog_attention');
      } catch (err) {
        console.warn('Failed to request dialog attention:', err);
      }
    };

    void requestAttention();
  }, [opened]);
}
