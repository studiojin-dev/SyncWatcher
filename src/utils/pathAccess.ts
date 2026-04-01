import { invoke } from '@tauri-apps/api/core';

export interface CapturedPathAccess {
    path: string;
    bookmark?: string | null;
}

export async function capturePathAccess(path: string): Promise<CapturedPathAccess> {
    return invoke<CapturedPathAccess>('capture_path_access', { path });
}
