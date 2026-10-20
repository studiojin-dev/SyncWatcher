export type SourceUuidType = 'disk' | 'volume' | 'sdcard';
export type UuidTokenType = SourceUuidType | 'legacy';

export interface UuidSelectableVolume {
    name: string;
    mount_point: string;
    disk_uuid?: string;
    volume_uuid?: string;
    sd_card_cid?: string;
}

export interface UuidSourceOptionLabels {
    sdCardLabel?: string;
}

export interface UuidSourceOption {
    value: string;
    label: string;
    uuidType: UuidTokenType;
    uuid: string;
    mountPoint: string | null;
    mounted: boolean;
}

export interface ParsedUuidSourceToken {
    tokenType: UuidTokenType;
    uuid: string;
    subPath: string;
}

const DISK_UUID_PREFIX = '[DISK_UUID:';
const VOLUME_UUID_PREFIX = '[VOLUME_UUID:';
const SD_CARD_CID_PREFIX = '[SD_CARD_CID:';
const LEGACY_UUID_PREFIX = '[UUID:';
const DEFAULT_SD_CARD_LABEL = 'SD Card Serial';

const UUID_TOKEN_PREFIXES: Record<UuidTokenType, string> = {
    disk: DISK_UUID_PREFIX,
    volume: VOLUME_UUID_PREFIX,
    sdcard: SD_CARD_CID_PREFIX,
    legacy: LEGACY_UUID_PREFIX,
};

export function isSourceUuidType(value: string | null | undefined): value is SourceUuidType {
    return value === 'disk' || value === 'volume' || value === 'sdcard';
}

function isUuidTokenType(value: string): value is UuidTokenType {
    return isSourceUuidType(value) || value === 'legacy';
}

/** UUID 타입별 표시 라벨 (예: "Disk UUID", "SD Card Serial") */
export function uuidTypeLabel(
    uuidType: UuidTokenType,
    labels: UuidSourceOptionLabels = {}
): string {
    switch (uuidType) {
        case 'disk':
            return 'Disk UUID';
        case 'volume':
            return 'Volume UUID';
        case 'sdcard':
            return labels.sdCardLabel || DEFAULT_SD_CARD_LABEL;
        case 'legacy':
            return 'Legacy UUID';
    }
}
const UUID_OPTION_SEPARATOR = '::';

function normalizeFsPath(path: string): string {
    if (!path) {
        return '';
    }

    if (path === '/') {
        return '/';
    }

    return path.replace(/\/+$/, '');
}

function parseTokenWithPrefix(
    source: string,
    prefix: string,
    tokenType: UuidTokenType
): ParsedUuidSourceToken | null {
    if (!source.startsWith(prefix)) {
        return null;
    }

    const endIndex = source.indexOf(']');
    if (endIndex < 0) {
        return null;
    }

    return {
        tokenType,
        uuid: source.slice(prefix.length, endIndex),
        subPath: source.slice(endIndex + 1),
    };
}

export function buildUuidOptionValue(uuidType: UuidTokenType, uuid: string): string {
    return `${uuidType}${UUID_OPTION_SEPARATOR}${uuid}`;
}

export function parseUuidOptionValue(value: string): { uuidType: UuidTokenType; uuid: string } | null {
    const separatorIndex = value.indexOf(UUID_OPTION_SEPARATOR);
    if (separatorIndex <= 0) {
        return null;
    }

    const typeRaw = value.slice(0, separatorIndex);
    const uuid = value.slice(separatorIndex + UUID_OPTION_SEPARATOR.length);

    if (!isUuidTokenType(typeRaw) || !uuid) {
        return null;
    }

    return { uuidType: typeRaw, uuid };
}

export function buildUuidSourceToken(uuidType: UuidTokenType, uuid: string, subPath: string): string {
    const prefix = UUID_TOKEN_PREFIXES[uuidType];
    return `${prefix}${uuid}]${normalizeUuidSubPath(subPath)}`;
}

export function normalizeUuidSubPath(subPath: string): string {
    const trimmed = subPath.trim();
    if (!trimmed) {
        return '/';
    }

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const collapsedSlashes = withLeadingSlash.replace(/\/{2,}/g, '/');

    if (collapsedSlashes.length > 1) {
        return collapsedSlashes.replace(/\/+$/, '');
    }

    return '/';
}

export function toUuidSubPath(mountPoint: string, selectedPath: string): string | null {
    const normalizedMount = normalizeFsPath(mountPoint);
    const normalizedSelected = normalizeFsPath(selectedPath);

    if (!normalizedMount || !normalizedSelected) {
        return null;
    }

    if (normalizedSelected === normalizedMount) {
        return '/';
    }

    const mountPrefix = normalizedMount === '/' ? '/' : `${normalizedMount}/`;
    if (!normalizedSelected.startsWith(mountPrefix)) {
        return null;
    }

    const relative = normalizedSelected.slice(mountPrefix.length);
    if (!relative) {
        return '/';
    }

    return `/${relative}`;
}

export function parseUuidSourceToken(source: string): ParsedUuidSourceToken | null {
    return (
        parseTokenWithPrefix(source, DISK_UUID_PREFIX, 'disk') ||
        parseTokenWithPrefix(source, VOLUME_UUID_PREFIX, 'volume') ||
        parseTokenWithPrefix(source, SD_CARD_CID_PREFIX, 'sdcard') ||
        parseTokenWithPrefix(source, LEGACY_UUID_PREFIX, 'legacy')
    );
}

export function inferUuidTypeFromVolumes(
    uuid: string,
    volumes: UuidSelectableVolume[]
): SourceUuidType | null {
    if (!uuid) {
        return null;
    }

    if (volumes.some((volume) => volume.disk_uuid === uuid)) {
        return 'disk';
    }

    if (volumes.some((volume) => volume.volume_uuid === uuid)) {
        return 'volume';
    }

    if (volumes.some((volume) => volume.sd_card_cid === uuid)) {
        return 'sdcard';
    }

    return null;
}

export function buildUuidSourceOptions<T extends UuidSelectableVolume>(
    volumes: T[],
    formatVolumeSize: (volume: T) => string,
    labels: UuidSourceOptionLabels = {}
): UuidSourceOption[] {
    const options: UuidSourceOption[] = [];
    const seen = new Set<string>();

    for (const volume of volumes) {
        const sizeLabel = formatVolumeSize(volume);

        // 내장 SD 슬롯 카드만 CID가 있다. USB 리더 등 CID가 없으면 옵션을 만들지 않는다.
        if (volume.sd_card_cid) {
            const value = buildUuidOptionValue('sdcard', volume.sd_card_cid);
            if (!seen.has(value)) {
                options.push({
                    value,
                    label: `${volume.name} (${sizeLabel}) [${uuidTypeLabel('sdcard', labels)}: ${volume.sd_card_cid}]`,
                    uuidType: 'sdcard',
                    uuid: volume.sd_card_cid,
                    mountPoint: volume.mount_point,
                    mounted: true,
                });
                seen.add(value);
            }
        }

        if (volume.disk_uuid) {
            const value = buildUuidOptionValue('disk', volume.disk_uuid);
            if (!seen.has(value)) {
                options.push({
                    value,
                    label: `${volume.name} (${sizeLabel}) [Disk UUID: ${volume.disk_uuid}]`,
                    uuidType: 'disk',
                    uuid: volume.disk_uuid,
                    mountPoint: volume.mount_point,
                    mounted: true,
                });
                seen.add(value);
            }
        }

        if (volume.volume_uuid) {
            const value = buildUuidOptionValue('volume', volume.volume_uuid);
            if (!seen.has(value)) {
                options.push({
                    value,
                    label: `${volume.name} (${sizeLabel}) [Volume UUID: ${volume.volume_uuid}]`,
                    uuidType: 'volume',
                    uuid: volume.volume_uuid,
                    mountPoint: volume.mount_point,
                    mounted: true,
                });
                seen.add(value);
            }
        }
    }

    return options;
}
