import { describe, expect, it, vi } from 'vitest';
import { showTargetPreflightToast } from './helpers';

describe('showTargetPreflightToast', () => {
  const showToastMock = vi.fn();
  const t = (key: string) => key;

  it('does nothing for missing preflight info', () => {
    showTargetPreflightToast(null, showToastMock, t);

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('does nothing when target is already ready', () => {
    showTargetPreflightToast(
      {
        kind: 'ready',
        path: '/tmp/ready-target',
      },
      showToastMock,
      t,
    );

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows a warning toast when the target directory will be created later', () => {
    showTargetPreflightToast(
      {
        kind: 'willCreateDirectory',
        path: '/tmp/missing-target',
      },
      showToastMock,
      t,
    );

    expect(showToastMock).toHaveBeenCalledWith(
      'syncTasks.targetDirectoryWillBeCreated',
      'warning',
    );
  });

  it('shows a warning toast when the target directory was created during sync', () => {
    showTargetPreflightToast(
      {
        kind: 'createdDirectory',
        path: '/tmp/created-target',
      },
      showToastMock,
      t,
    );

    expect(showToastMock).toHaveBeenCalledWith(
      'syncTasks.targetDirectoryCreated',
      'warning',
    );
  });
});
