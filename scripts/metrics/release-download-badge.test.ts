import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildBadgePayload,
  sumInstallerDownloads,
  writeBadgeFile,
} from './release-download-badge.mjs';

import fixtureReleases from './__fixtures__/releases.json';

describe('sumInstallerDownloads', () => {
  it('counts stable dmg and app tarball assets', () => {
    expect(sumInstallerDownloads([fixtureReleases[0]])).toBe(23);
  });

  it('ignores prerelease assets', () => {
    expect(sumInstallerDownloads([fixtureReleases[1]])).toBe(0);
  });

  it('ignores draft release assets', () => {
    expect(sumInstallerDownloads([fixtureReleases[2]])).toBe(0);
  });

  it('ignores non-installer assets on stable releases', () => {
    expect(sumInstallerDownloads([fixtureReleases[3]])).toBe(9);
  });

  it('merges paginated release payloads into one total', () => {
    const firstPage = fixtureReleases.slice(0, 2);
    const secondPage = fixtureReleases.slice(2);

    expect(sumInstallerDownloads([...firstPage, ...secondPage])).toBe(32);
  });
});

describe('badge output', () => {
  it('builds a shields endpoint payload', () => {
    expect(buildBadgePayload(32)).toEqual({
      schemaVersion: 1,
      label: 'downloads',
      message: '32',
      color: '0F766E',
      cacheSeconds: 86400,
    });
  });

  it('writes the badge payload to disk', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'syncwatcher-badge-'));
    const outputPath = path.join(outputDir, 'installer-downloads.json');

    await writeBadgeFile(outputPath, 32);

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(buildBadgePayload(32), null, 2)}\n`,
    );
  });
});
