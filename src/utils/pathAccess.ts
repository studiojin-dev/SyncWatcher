import { invoke } from '@tauri-apps/api/core';

export interface CapturedPathAccess {
    path: string;
    bookmark?: string | null;
}

export interface CapturedNetworkMount {
    scheme: 'smb';
    remountUrl: string;
    username?: string | null;
    mountRootPath: string;
    relativePathFromMountRoot: string;
    enabled: boolean;
}

export async function capturePathAccess(path: string): Promise<CapturedPathAccess> {
    return invoke<CapturedPathAccess>('capture_path_access', { path });
}

export async function captureNetworkMount(
    path: string,
): Promise<CapturedNetworkMount | null> {
    return invoke<CapturedNetworkMount | null>('capture_network_mount', { path });
}
