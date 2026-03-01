export interface AutoUnmountTaskLike {
    source?: string | null;
    sourceType?: 'path' | 'uuid';
    watchMode?: boolean;
    autoUnmount?: boolean;
}

const UUID_SOURCE_PREFIXES = ['[DISK_UUID:', '[VOLUME_UUID:', '[UUID:'] as const;

export function isUuidSource(source: string | null | undefined, sourceType?: 'path' | 'uuid'): boolean {
    if (typeof source !== 'string' || source.length === 0) {
        return false;
    }

    if (sourceType === 'uuid') {
        return true;
    }

    if (sourceType === 'path') {
        return false;
    }

    return UUID_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

export function shouldEnableAutoUnmount(task: AutoUnmountTaskLike): boolean {
    return Boolean(task.autoUnmount) && Boolean(task.watchMode) && isUuidSource(task.source, task.sourceType);
}
