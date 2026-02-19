export type SourceUuidType = 'disk' | 'volume';

type ParsedUuidTokenType = SourceUuidType | 'legacy';

export interface UuidSelectableVolume {
    name: string;
    mount_point: string;
    disk_uuid?: string;
    volume_uuid?: string;
}

export interface UuidSourceOption {
    value: string;
    label: string;
    uuidType: SourceUuidType;
    uuid: string;
    mountPoint: string;
}

export interface ParsedUuidSourceToken {
    tokenType: ParsedUuidTokenType;
    uuid: string;
    subPath: string;
}

const DISK_UUID_PREFIX = '[DISK_UUID:';
const VOLUME_UUID_PREFIX = '[VOLUME_UUID:';
const LEGACY_UUID_PREFIX = '[UUID:';
const UUID_OPTION_SEPARATOR = '::';

function parseTokenWithPrefix(
    source: string,
    prefix: string,
    tokenType: ParsedUuidTokenType
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

export function buildUuidOptionValue(uuidType: SourceUuidType, uuid: string): string {
    return `${uuidType}${UUID_OPTION_SEPARATOR}${uuid}`;
}

export function parseUuidOptionValue(value: string): { uuidType: SourceUuidType; uuid: string } | null {
    const separatorIndex = value.indexOf(UUID_OPTION_SEPARATOR);
    if (separatorIndex <= 0) {
        return null;
    }

    const typeRaw = value.slice(0, separatorIndex);
    const uuid = value.slice(separatorIndex + UUID_OPTION_SEPARATOR.length);

    if ((typeRaw !== 'disk' && typeRaw !== 'volume') || !uuid) {
        return null;
    }

    return { uuidType: typeRaw, uuid };
}

export function buildUuidSourceToken(uuidType: SourceUuidType, uuid: string, subPath: string): string {
    const prefix = uuidType === 'disk' ? DISK_UUID_PREFIX : VOLUME_UUID_PREFIX;
    return `${prefix}${uuid}]${subPath}`;
}

export function parseUuidSourceToken(source: string): ParsedUuidSourceToken | null {
    return (
        parseTokenWithPrefix(source, DISK_UUID_PREFIX, 'disk') ||
        parseTokenWithPrefix(source, VOLUME_UUID_PREFIX, 'volume') ||
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

    return null;
}

export function buildUuidSourceOptions<T extends UuidSelectableVolume>(
    volumes: T[],
    formatVolumeSize: (volume: T) => string
): UuidSourceOption[] {
    const options: UuidSourceOption[] = [];
    const seen = new Set<string>();

    for (const volume of volumes) {
        const sizeLabel = formatVolumeSize(volume);

        if (volume.disk_uuid) {
            const value = buildUuidOptionValue('disk', volume.disk_uuid);
            if (!seen.has(value)) {
                options.push({
                    value,
                    label: `${volume.name} (${sizeLabel}) [Disk UUID: ${volume.disk_uuid}]`,
                    uuidType: 'disk',
                    uuid: volume.disk_uuid,
                    mountPoint: volume.mount_point,
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
                });
                seen.add(value);
            }
        }
    }

    return options;
}
