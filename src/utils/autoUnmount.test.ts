import { describe, expect, it } from 'vitest';
import { isUuidSource, shouldEnableAutoUnmount } from './autoUnmount';

describe('autoUnmount helpers', () => {
    it('disables auto unmount for normal path source', () => {
        expect(
            shouldEnableAutoUnmount({
                source: '/Users/me/Pictures',
                sourceType: 'path',
                watchMode: true,
                autoUnmount: true,
            })
        ).toBe(false);
    });

    it('enables auto unmount for uuid source type', () => {
        expect(
            shouldEnableAutoUnmount({
                source: '[DISK_UUID:disk-a]/DCIM',
                sourceType: 'uuid',
                watchMode: true,
                autoUnmount: true,
            })
        ).toBe(true);
    });

    it('treats legacy token source as uuid source even without sourceType', () => {
        expect(isUuidSource('[UUID:legacy-a]/DCIM')).toBe(true);
        expect(
            shouldEnableAutoUnmount({
                source: '[UUID:legacy-a]/DCIM',
                watchMode: true,
                autoUnmount: true,
            })
        ).toBe(true);
    });

    it('requires watch mode and explicit autoUnmount flag', () => {
        expect(
            shouldEnableAutoUnmount({
                source: '[VOLUME_UUID:volume-a]/DCIM',
                sourceType: 'uuid',
                watchMode: false,
                autoUnmount: true,
            })
        ).toBe(false);

        expect(
            shouldEnableAutoUnmount({
                source: '[VOLUME_UUID:volume-a]/DCIM',
                sourceType: 'uuid',
                watchMode: true,
                autoUnmount: false,
            })
        ).toBe(false);
    });

    it('fails safe when source is missing or malformed', () => {
        expect(
            shouldEnableAutoUnmount({
                sourceType: 'uuid',
                watchMode: true,
                autoUnmount: true,
            })
        ).toBe(false);

        expect(
            shouldEnableAutoUnmount({
                source: null,
                sourceType: 'uuid',
                watchMode: true,
                autoUnmount: true,
            })
        ).toBe(false);
    });
});
