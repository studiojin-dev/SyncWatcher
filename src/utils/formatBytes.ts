export type DataUnitSystem = 'binary' | 'decimal';

export function formatBytes(
    bytes: number,
    unitSystem: DataUnitSystem = 'binary',
    precision = 1,
): string {
    if (bytes === 0) {
        return '0 B';
    }

    const base = unitSystem === 'decimal' ? 1000 : 1024;
    const units = unitSystem === 'decimal'
        ? ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
        : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const unitIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(base)),
        units.length - 1,
    );
    const value = bytes / Math.pow(base, unitIndex);

    return `${parseFloat(value.toFixed(precision))} ${units[unitIndex]}`;
}
