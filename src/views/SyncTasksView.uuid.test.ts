import { describe, expect, it } from 'vitest';
import {
    buildUuidSourceOptions,
    buildUuidSourceToken,
    buildUuidOptionValue,
    inferUuidTypeFromVolumes,
    isSourceUuidType,
    normalizeUuidSubPath,
    parseUuidOptionValue,
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
        expect(buildUuidSourceToken('legacy', 'legacy-a', '/DCIM')).toBe('[UUID:legacy-a]/DCIM');
        expect(buildUuidSourceToken('volume', 'volume-a', 'DCIM')).toBe('[VOLUME_UUID:volume-a]/DCIM');
        expect(buildUuidSourceToken('volume', 'volume-a', '')).toBe('[VOLUME_UUID:volume-a]/');
    });

    it('normalizes UUID sub path input', () => {
        expect(normalizeUuidSubPath('')).toBe('/');
        expect(normalizeUuidSubPath('/')).toBe('/');
        expect(normalizeUuidSubPath('DCIM')).toBe('/DCIM');
        expect(normalizeUuidSubPath('//DCIM//100MSDCF//')).toBe('/DCIM/100MSDCF');
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

    it('offers an SD card serial option only for volumes with a CID', () => {
        const options = buildUuidSourceOptions(
            [
                {
                    name: 'Untitled',
                    mount_point: '/Volumes/Untitled',
                    volume_uuid: 'volume-sd',
                    sd_card_cid: '39:MTG2c:17826466',
                },
                {
                    name: 'USB-Reader',
                    mount_point: '/Volumes/USB-Reader',
                    volume_uuid: 'volume-usb',
                },
            ],
            () => '256 GB',
            { sdCardLabel: 'SD Card Serial' }
        );

        expect(options.map((option) => option.value)).toEqual([
            'sdcard::39:MTG2c:17826466',
            'volume::volume-sd',
            'volume::volume-usb',
        ]);
        expect(options[0].uuidType).toBe('sdcard');
        expect(options[0].label).toContain('SD Card Serial: 39:MTG2c:17826466');
    });

    it('round-trips SD card CID tokens and option values', () => {
        expect(buildUuidSourceToken('sdcard', '39:MTG2c:17826466', 'DCIM')).toBe(
            '[SD_CARD_CID:39:MTG2c:17826466]/DCIM'
        );
        expect(parseUuidSourceToken('[SD_CARD_CID:39:MTG2c:17826466]/DCIM')).toEqual({
            tokenType: 'sdcard',
            uuid: '39:MTG2c:17826466',
            subPath: '/DCIM',
        });
        expect(parseUuidOptionValue(buildUuidOptionValue('sdcard', '39:MTG2c:17826466'))).toEqual({
            uuidType: 'sdcard',
            uuid: '39:MTG2c:17826466',
        });
        expect(
            inferUuidTypeFromVolumes('39:MTG2c:17826466', [
                { name: 'Untitled', mount_point: '/Volumes/Untitled', sd_card_cid: '39:MTG2c:17826466' },
            ])
        ).toBe('sdcard');
        expect(isSourceUuidType('sdcard')).toBe(true);
        expect(isSourceUuidType('legacy')).toBe(false);
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
