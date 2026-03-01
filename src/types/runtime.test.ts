import { describe, expect, it } from 'vitest';
import type { SyncTask } from '../hooks/useSyncTasks';
import { toRuntimeTask } from './runtime';

function buildTask(overrides: Partial<SyncTask> = {}): SyncTask {
    return {
        id: 'task-1',
        name: 'Task 1',
        source: '/Users/me/source',
        target: '/Users/me/target',
        checksumMode: false,
        watchMode: true,
        autoUnmount: false,
        ...overrides,
    };
}

describe('toRuntimeTask', () => {
    it('forces autoUnmount false for normal path source', () => {
        const runtimeTask = toRuntimeTask(
            buildTask({
                sourceType: 'path',
                autoUnmount: true,
            })
        );

        expect(runtimeTask.autoUnmount).toBe(false);
    });

    it('keeps autoUnmount true for uuid source in watch mode', () => {
        const runtimeTask = toRuntimeTask(
            buildTask({
                source: '[DISK_UUID:disk-a]/DCIM',
                sourceType: 'uuid',
                watchMode: true,
                autoUnmount: true,
            })
        );

        expect(runtimeTask.autoUnmount).toBe(true);
    });

    it('forces autoUnmount false when watch mode is off', () => {
        const runtimeTask = toRuntimeTask(
            buildTask({
                source: '[DISK_UUID:disk-a]/DCIM',
                sourceType: 'uuid',
                watchMode: false,
                autoUnmount: true,
            })
        );

        expect(runtimeTask.autoUnmount).toBe(false);
    });
});
