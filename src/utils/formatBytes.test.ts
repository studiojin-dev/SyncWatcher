import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
    it('formats binary units with IEC labels', () => {
        expect(formatBytes(1024, 'binary', 2)).toBe('1 KiB');
        expect(formatBytes(1_073_741_824, 'binary', 2)).toBe('1 GiB');
    });

    it('formats decimal units with SI labels', () => {
        expect(formatBytes(1000, 'decimal', 2)).toBe('1 KB');
        expect(formatBytes(1_000_000_000, 'decimal', 2)).toBe('1 GB');
    });
});
