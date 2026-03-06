import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type ConfigStoreScope = 'settings' | 'syncTasks' | 'exclusionSets' | 'all';

type UnknownRecord = Record<string, unknown>;

const CONFIG_STORE_SCOPE_ALIASES: Record<string, ConfigStoreScope> = {
    all: 'all',
    settings: 'settings',
    setting: 'settings',
    'settings.yaml': 'settings',
    'sync-tasks': 'syncTasks',
    sync_tasks: 'syncTasks',
    synctasks: 'syncTasks',
    tasks: 'syncTasks',
    task: 'syncTasks',
    'tasks.yaml': 'syncTasks',
    'exclusion-sets': 'exclusionSets',
    exclusion_sets: 'exclusionSets',
    exclusionsets: 'exclusionSets',
    exclusions: 'exclusionSets',
    'exclusion_sets.yaml': 'exclusionSets',
};

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null;
}

function normalizeScopeCandidate(value: unknown): ConfigStoreScope | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    return CONFIG_STORE_SCOPE_ALIASES[normalized] ?? null;
}

function collectPayloadCandidates(payload: UnknownRecord): unknown[] {
    return [
        payload.scope,
        payload.store,
        payload.section,
        payload.fileName,
        payload.scopes,
        payload.stores,
        payload.sections,
        payload.fileNames,
    ];
}

export function normalizeConfigStoreScopes(payload: unknown): Set<ConfigStoreScope> {
    if (!payload) {
        return new Set<ConfigStoreScope>(['all']);
    }

    const candidates = isRecord(payload) ? collectPayloadCandidates(payload) : [payload];
    const scopes = new Set<ConfigStoreScope>();

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            for (const item of candidate) {
                const normalized = normalizeScopeCandidate(item);
                if (normalized) {
                    scopes.add(normalized);
                }
            }
            continue;
        }

        const normalized = normalizeScopeCandidate(candidate);
        if (normalized) {
            scopes.add(normalized);
        }
    }

    if (scopes.size === 0) {
        scopes.add('all');
    }

    return scopes;
}

export async function listenConfigStoreChanged(
    targets: ConfigStoreScope[],
    onChange: () => void
): Promise<UnlistenFn> {
    return listen<unknown>('config-store-changed', (event) => {
        const scopes = normalizeConfigStoreScopes(event.payload);
        if (scopes.has('all') || targets.some((target) => scopes.has(target))) {
            onChange();
        }
    });
}

export function readConfigRecord<T extends object>(
    payload: unknown,
    keys: string[]
): Partial<T> | null {
    if (isRecord(payload)) {
        for (const key of keys) {
            const nestedValue = payload[key];
            if (isRecord(nestedValue)) {
                return nestedValue as Partial<T>;
            }
        }

        if ('error' in payload) {
            return null;
        }

        return payload as Partial<T>;
    }

    return null;
}

export function readConfigCollection<T>(payload: unknown, keys: string[]): T[] {
    if (Array.isArray(payload)) {
        return payload as T[];
    }

    if (isRecord(payload)) {
        for (const key of keys) {
            const nestedValue = payload[key];
            if (Array.isArray(nestedValue)) {
                return nestedValue as T[];
            }
        }
    }

    return [];
}

export function parseConfigError(error: unknown): unknown {
    if (typeof error !== 'string') {
        return error;
    }

    try {
        return JSON.parse(error) as unknown;
    } catch {
        return error;
    }
}
