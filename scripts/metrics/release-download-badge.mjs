import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INSTALLER_SUFFIXES = ['.dmg', '.app.tar.gz'];

export function isStableRelease(release) {
  return release.draft !== true && release.prerelease !== true;
}

export function isInstallerAssetName(assetName) {
  return INSTALLER_SUFFIXES.some((suffix) => assetName.endsWith(suffix));
}

export function sumInstallerDownloads(releases) {
  return releases.reduce((releaseTotal, release) => {
    if (!isStableRelease(release)) {
      return releaseTotal;
    }

    const assetTotal = (release.assets ?? []).reduce((sum, asset) => {
      if (!isInstallerAssetName(asset.name ?? '')) {
        return sum;
      }

      return sum + Number(asset.download_count ?? 0);
    }, 0);

    return releaseTotal + assetTotal;
  }, 0);
}

export function buildBadgePayload(totalDownloads) {
  return {
    schemaVersion: 1,
    label: 'downloads',
    message: String(totalDownloads),
    color: '0F766E',
    cacheSeconds: 86400,
  };
}

export async function writeBadgeFile(outputPath, totalDownloads) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(buildBadgePayload(totalDownloads), null, 2)}\n`,
    'utf8',
  );
}
