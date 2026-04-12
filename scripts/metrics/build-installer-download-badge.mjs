import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sumInstallerDownloads, writeBadgeFile } from './release-download-badge.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '../..');
const defaultOutputPath = path.join(repoRoot, 'docs', 'badges', 'installer-downloads.json');
const defaultRepoSlug = 'studiojin-dev/SyncWatcher';

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextArg = argv[index + 1];

    if (arg === '--input') {
      if (!nextArg) {
        throw new Error('Missing value for --input');
      }
      options.input = nextArg;
      index += 1;
      continue;
    }

    if (arg === '--output') {
      if (!nextArg) {
        throw new Error('Missing value for --output');
      }
      options.output = nextArg;
      index += 1;
      continue;
    }

    if (arg === '--repo') {
      if (!nextArg) {
        throw new Error('Missing value for --repo');
      }
      options.repo = nextArg;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadReleasesFromFile(inputPath) {
  const raw = await readFile(inputPath, 'utf8');
  const releases = JSON.parse(raw);

  if (!Array.isArray(releases)) {
    throw new Error('Fixture input must be a JSON array of releases');
  }

  return releases;
}

async function fetchReleases({ repoSlug, githubToken }) {
  const releases = [];
  let page = 1;

  while (true) {
    const url = new URL(`https://api.github.com/repos/${repoSlug}/releases`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'syncwatcher-download-badge',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(
        `GitHub releases request failed (${response.status} ${response.statusText}) for ${url}`,
      );
    }

    const pageReleases = await response.json();

    if (!Array.isArray(pageReleases)) {
      throw new Error('GitHub releases API returned a non-array payload');
    }

    releases.push(...pageReleases);

    if (pageReleases.length < 100) {
      return releases;
    }

    page += 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const outputPath = path.resolve(options.output ?? defaultOutputPath);
  const repoSlug =
    options.repo ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? defaultRepoSlug;

  const releases = options.input
    ? await loadReleasesFromFile(path.resolve(options.input))
    : await fetchReleases({
        repoSlug,
        githubToken: process.env.GITHUB_TOKEN,
      });

  const totalDownloads = sumInstallerDownloads(releases);
  await writeBadgeFile(outputPath, totalDownloads);

  process.stdout.write(`Installer download badge updated: ${totalDownloads} -> ${outputPath}\n`);
}

const executedDirectly = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

if (executedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
