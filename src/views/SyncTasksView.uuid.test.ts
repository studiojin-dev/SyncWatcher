import { describe, expect, it } from 'vitest';
import {
    buildUuidSourceOptions,
    buildUuidSourceToken,
    inferUuidTypeFromVolumes,
    parseUuidSourceToken,
    toUuidSubPath,
} from './syncTaskUuid';

describe('SyncTasksView UUID helpers', () => {
    it('builds unique disk/volume options and keeps both UUID types per volume', () => {
        const volumes = [
            {
                name: 'Card-A',
                mount_point: '/Volumes/Card-A',
                disk_uuid: 'disk-a',
                volume_uuid: 'volume-a',
            },
            {
                name: 'Card-B',
                mount_point: '/Volumes/Card-B',
                disk_uuid: 'disk-b',
            },
            {
                name: 'Card-C',
                mount_point: '/Volumes/Card-C',
                volume_uuid: 'volume-c',
            },
            {
                name: 'Card-Duplicate',
                mount_point: '/Volumes/Card-Duplicate',
                disk_uuid: 'disk-a',
            },
            {
                name: 'No-UUID',
                mount_point: '/Volumes/No-UUID',
            },
        ];

        const options = buildUuidSourceOptions(volumes, () => '32 GiB');

        expect(options.map((option) => option.value)).toEqual([
            'disk::disk-a',
            'volume::volume-a',
            'disk::disk-b',
            'volume::volume-c',
        ]);
        expect(options.map((option) => option.uuidType)).toEqual([
            'disk',
            'volume',
            'disk',
            'volume',
        ]);
        expect(options[0].label).toContain('Disk UUID: disk-a');
        expect(options[1].label).toContain('Volume UUID: volume-a');
    });

    it('excludes volumes without UUIDs from selectable list', () => {
        const options = buildUuidSourceOptions(
            [
                {
                    name: 'No-UUID',
                    mount_point: '/Volumes/No-UUID',
                },
            ],
            () => 'N/A'
        );

        expect(options).toEqual([]);
    });

    it('builds source token from selected UUID type', () => {
        expect(buildUuidSourceToken('disk', 'disk-a', '/DCIM')).toBe('[DISK_UUID:disk-a]/DCIM');
        expect(buildUuidSourceToken('volume', 'volume-a', '/DCIM')).toBe('[VOLUME_UUID:volume-a]/DCIM');
    });

    it('parses disk/volume/legacy UUID tokens', () => {
        expect(parseUuidSourceToken('[DISK_UUID:disk-a]/DCIM')).toEqual({
            tokenType: 'disk',
            uuid: 'disk-a',
            subPath: '/DCIM',
        });
        expect(parseUuidSourceToken('[VOLUME_UUID:volume-a]/DCIM')).toEqual({
            tokenType: 'volume',
            uuid: 'volume-a',
            subPath: '/DCIM',
        });
        expect(parseUuidSourceToken('[UUID:legacy-a]/DCIM')).toEqual({
            tokenType: 'legacy',
            uuid: 'legacy-a',
            subPath: '/DCIM',
        });
    });

    it('infers legacy UUID type with disk-first then volume fallback', () => {
        const volumes = [
            {
                name: 'DiskFirst',
                mount_point: '/Volumes/DiskFirst',
                disk_uuid: 'shared-uuid',
            },
            {
                name: 'VolumeFallback',
                mount_point: '/Volumes/VolumeFallback',
                volume_uuid: 'shared-uuid',
            },
            {
                name: 'VolumeOnly',
                mount_point: '/Volumes/VolumeOnly',
                volume_uuid: 'volume-only',
            },
        ];

        expect(inferUuidTypeFromVolumes('shared-uuid', volumes)).toBe('disk');
        expect(inferUuidTypeFromVolumes('volume-only', volumes)).toBe('volume');
        expect(inferUuidTypeFromVolumes('missing', volumes)).toBeNull();
    });

    it('converts selected directory path to UUID sub path', () => {
        expect(toUuidSubPath('/Volumes/CARD', '/Volumes/CARD')).toBe('/');
        expect(toUuidSubPath('/Volumes/CARD', '/Volumes/CARD/DCIM')).toBe('/DCIM');
        expect(toUuidSubPath('/Volumes/CARD', '/Volumes/CARD/DCIM/100MSDCF')).toBe('/DCIM/100MSDCF');
    });

    it('returns null when selected path is outside mount point', () => {
        expect(toUuidSubPath('/Volumes/CARD', '/Users/kimjeongjin/Desktop')).toBeNull();
    });
});
