#!/usr/bin/env node
/* global process */
/* eslint-disable no-console */

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_PAYLOAD_MIB = 512;
const POLL_INTERVAL_MS = 250;
const DISABLED_PHASE_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 30_000;
const JOB_TIMEOUTS_MS = {
  dryRun: 30_000,
  orphanScan: 30_000,
  sync: 60_000,
};

const EXPECTED_TOOLS = [
  'syncwatcher_get_settings',
  'syncwatcher_update_settings',
  'syncwatcher_list_sync_tasks',
  'syncwatcher_get_sync_task',
  'syncwatcher_create_sync_task',
  'syncwatcher_update_sync_task',
  'syncwatcher_delete_sync_task',
  'syncwatcher_start_dry_run',
  'syncwatcher_start_sync',
  'syncwatcher_start_orphan_scan',
  'syncwatcher_get_job',
  'syncwatcher_cancel_job',
  'syncwatcher_get_runtime_state',
  'syncwatcher_list_removable_volumes',
];

function log(step, message, detail) {
  const prefix = `[live-mcp-smoke] [${step}]`;
  if (detail === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, detail);
}

function fail(message, detail) {
  const error = new Error(detail ? `${message}: ${detail}` : message);
  error.detail = detail;
  throw error;
}

function assert(condition, message, detail) {
  if (!condition) {
    fail(message, detail);
  }
}

function parseArgs(argv) {
  const options = {
    payloadMib: DEFAULT_PAYLOAD_MIB,
    retainArtifacts: true,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
  };

  for (const arg of argv) {
    if (arg === '--cleanup-artifacts') {
      options.retainArtifacts = false;
      continue;
    }
    if (arg.startsWith('--payload-mib=')) {
      options.payloadMib = Number.parseInt(arg.split('=')[1], 10);
      continue;
    }
    if (arg.startsWith('--protocol-version=')) {
      options.protocolVersion = arg.split('=')[1];
      continue;
    }
    fail(`Unsupported argument '${arg}'`);
  }

  assert(Number.isInteger(options.payloadMib) && options.payloadMib > 0, 'payload-mib must be a positive integer');
  return options;
}

function mkArtifactLayout() {
  const artifactRoot = fs.mkdtempSync('/tmp/syncwatcher-live-mcp-smoke-');
  return {
    artifactRoot,
    appSupportDir: path.join(artifactRoot, 'app-support'),
    fixtureRoot: path.join(artifactRoot, 'fixture'),
    reportPath: path.join(artifactRoot, 'report.json'),
    syncScreenshotPath: path.join(artifactRoot, 'sync-running.png'),
  };
}

function writeJson(pathname, value) {
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function settingsFilePath(appSupportDir) {
  return path.join(appSupportDir, 'config', 'settings.yaml');
}

function socketFilePath(appSupportDir) {
  return path.join(appSupportDir, 'control', 'syncwatcher-mcp.sock');
}

function mcpBinaryPath() {
  return path.join(repoRoot, 'src-tauri', 'target', 'debug', 'syncwatcher');
}

function readYamlFile(pathname) {
  return yaml.load(fs.readFileSync(pathname, 'utf8'));
}

function writeYamlFile(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, yaml.dump(value, { noRefs: true }), 'utf8');
}

function setMcpEnabledInSettings(pathname, enabled) {
  const settings = fs.existsSync(pathname) ? (readYamlFile(pathname) ?? {}) : {};
  settings.mcpEnabled = enabled;
  writeYamlFile(pathname, settings);
}

function readMcpAuthToken(pathname) {
  const settings = fs.existsSync(pathname) ? (readYamlFile(pathname) ?? {}) : {};
  const token = typeof settings.mcpAuthToken === 'string' ? settings.mcpAuthToken.trim() : '';
  return token || null;
}

function createFixture(layout, payloadMib) {
  const sourceDir = path.join(layout.fixtureRoot, 'source');
  const targetDir = path.join(layout.fixtureRoot, 'target');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const notesText = `SyncWatcher live MCP smoke ${new Date().toISOString()}\n`;
  const notesPath = path.join(sourceDir, 'notes.txt');
  const payloadPath = path.join(sourceDir, 'payload.bin');
  const excludedPath = path.join(sourceDir, '.DS_Store');
  const orphanPath = path.join(targetDir, 'orphan.txt');

  fs.writeFileSync(notesPath, notesText, 'utf8');
  fs.writeFileSync(excludedPath, 'exclude-me', 'utf8');
  fs.writeFileSync(orphanPath, 'orphan', 'utf8');
  execFileSync('mkfile', [`${payloadMib}m`, payloadPath]);

  return {
    sourceDir,
    targetDir,
    notesPath,
    payloadPath,
    excludedPath,
    orphanPath,
    notesText,
  };
}

function ensureMcpBinary() {
  const binaryPath = mcpBinaryPath();
  log('setup', 'Building syncwatcher binary with MCP stdio mode');
  execFileSync(
    'cargo',
    ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'syncwatcher'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  assert(fs.existsSync(binaryPath), 'syncwatcher binary was not built', binaryPath);
  return binaryPath;
}

async function hashFile(pathname) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(pathname);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function waitFor(check, timeoutMs, description, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }
  fail(`Timed out waiting for ${description}`);
}

class LoggedProcess {
  constructor(child, name, options = {}) {
    this.child = child;
    this.name = name;
    this.useProcessGroup = options.useProcessGroup ?? false;
    this.tail = [];
    this.exited = false;

    const track = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      this.tail.push(trimmed);
      if (this.tail.length > 40) {
        this.tail.shift();
      }
      console.log(`[${name}] ${trimmed}`);
    };

    const streamConfigs = [
      [child.stdout, 'stdout', options.captureStdout ?? true],
      [child.stderr, 'stderr', options.captureStderr ?? true],
    ];
    for (const [stream, label, enabled] of streamConfigs) {
      if (!enabled) {
        continue;
      }
      if (!stream) {
        continue;
      }
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          track(label === 'stderr' ? `${line}` : line);
          newlineIndex = buffer.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (buffer.trim()) {
          track(buffer);
        }
      });
    }

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.tail.push(`process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (this.tail.length > 40) {
        this.tail.shift();
      }
    });
  }

  async stop() {
    if (this.exited) {
      return;
    }
    const pid = this.child.pid;
    if (!pid) {
      return;
    }

    try {
      if (this.useProcessGroup) {
        process.kill(-pid, 'SIGTERM');
      } else {
        this.child.kill('SIGTERM');
      }
    } catch {
      // Best-effort shutdown.
    }

    const exited = await Promise.race([
      new Promise((resolve) => this.child.once('exit', () => resolve(true))),
      delay(5_000).then(() => false),
    ]);

    if (exited) {
      return;
    }

    try {
      if (this.useProcessGroup) {
        process.kill(-pid, 'SIGKILL');
      } else {
        this.child.kill('SIGKILL');
      }
    } catch {
      // Best-effort forced shutdown.
    }
    await Promise.race([
      new Promise((resolve) => this.child.once('exit', () => resolve(true))),
      delay(3_000),
    ]);
  }
}

function startApp(appSupportDir) {
  fs.mkdirSync(appSupportDir, { recursive: true });
  const child = spawn('npm', ['run', 'tauri', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SYNCWATCHER_APP_SUPPORT_DIR: appSupportDir,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new LoggedProcess(child, 'syncwatcher-app', { useProcessGroup: true });
}

class McpStdioClient {
  constructor(appSupportDir, protocolVersion, authToken) {
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.child = spawn(mcpBinaryPath(), ['--mcp-stdio', '--mcp-token', authToken], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SYNCWATCHER_APP_SUPPORT_DIR: appSupportDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.logs = new LoggedProcess(this.child, 'syncwatcher --mcp-stdio', {
      captureStdout: false,
      captureStderr: true,
      useProcessGroup: false,
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.#drain();
    });
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`syncwatcher --mcp-stdio exited before reply (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
      }
      this.pending.clear();
    });
    this.protocolVersion = protocolVersion;
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  #drain() {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    this.#send(message);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params) {
    this.#send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: 'syncwatcher-live-mcp-smoke',
        version: '1.0.0',
      },
    });
    this.notify('notifications/initialized', {});
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    });
    if (result?.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((item) => item?.type === 'text')
            .map((item) => item.text)
            .join('\n')
        : JSON.stringify(result);
      const error = new Error(errorText || `Tool call failed: ${name}`);
      error.toolResult = result;
      throw error;
    }
    return result?.structuredContent ?? result;
  }

  async close() {
    if (!this.child.killed) {
      this.child.stdin.end();
    }
    await this.logs.stop();
  }
}

async function withClient(appSupportDir, protocolVersion, authToken, fn) {
  const client = new McpStdioClient(appSupportDir, protocolVersion, authToken);
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function expectDisabled(appSupportDir, protocolVersion, authToken) {
  return withClient(appSupportDir, protocolVersion, authToken, async (client) => {
    let message = '';
    try {
      await client.callTool('syncwatcher_get_settings', {});
      fail('Expected disabled error from syncwatcher_get_settings');
    } catch (error) {
      message = error.message;
      assert(message.includes('MCP control is disabled in SyncWatcher'), 'Expected disabled MCP error', message);
    }
    return message;
  });
}

async function waitForSocket(appSupportDir) {
  const socketPath = socketFilePath(appSupportDir);
  await waitFor(() => fs.existsSync(socketPath), SOCKET_TIMEOUT_MS, `socket at ${socketPath}`);
  return socketPath;
}

async function waitForToolSuccess(appSupportDir, protocolVersion, authToken, toolName, args = {}, timeoutMs = SOCKET_TIMEOUT_MS) {
  return waitFor(async () => {
    try {
      return await withClient(appSupportDir, protocolVersion, authToken, async (client) => client.callTool(toolName, args));
    } catch {
      return null;
    }
  }, timeoutMs, `${toolName} success`);
}

async function pollJob(client, jobId, timeoutMs, screenshotPath) {
  const startedAt = Date.now();
  let sawRunning = false;
  let sawProgress = false;
  let capturedScreenshot = false;
  let lastJob = null;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await client.callTool('syncwatcher_get_job', { jobId });
    const job = result.job;
    lastJob = job;
    if (job.status === 'running') {
      sawRunning = true;
      const processedBytes = job.progress?.processedBytes ?? 0;
      const current = job.progress?.current ?? 0;
      sawProgress ||= processedBytes > 0 || current > 0;
      if (!capturedScreenshot && screenshotPath) {
        try {
          execFileSync('osascript', ['-e', 'tell application "Sync Watcher" to activate']);
          await delay(1_500);
          execFileSync('screencapture', ['-x', screenshotPath]);
          capturedScreenshot = true;
        } catch (error) {
          log('ui', 'Failed to capture sync screenshot', String(error));
        }
      }
    }

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      return { job, sawRunning, sawProgress, capturedScreenshot };
    }
    await delay(POLL_INTERVAL_MS);
  }

  fail(`Timed out waiting for job ${jobId}`, JSON.stringify(lastJob, null, 2));
}

function relativeDiffPaths(diffs) {
  return diffs.map((diff) => String(diff.path));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const layout = mkArtifactLayout();
  const relayBinary = ensureMcpBinary();
  const report = {
    artifactRoot: layout.artifactRoot,
    protocolVersion: options.protocolVersion,
    payloadMib: options.payloadMib,
    relayBinary,
    phases: [],
    screenshotPath: null,
    cleanup: {},
  };
  let app = null;

  const cleanup = async () => {
    if (app) {
      await app.stop();
      app = null;
    }
    const fixtureRemoved = fs.rmSync(layout.fixtureRoot, { recursive: true, force: true });
    const supportRemoved = fs.rmSync(layout.appSupportDir, { recursive: true, force: true });
    report.cleanup.fixtureRemoved = fixtureRemoved === undefined;
    report.cleanup.appSupportRemoved = supportRemoved === undefined;
    writeJson(layout.reportPath, report);
    if (!options.retainArtifacts) {
      fs.rmSync(layout.artifactRoot, { recursive: true, force: true });
    }
  };

  try {
    log('setup', 'Artifacts', layout.artifactRoot);

    const settingsPath = settingsFilePath(layout.appSupportDir);
    setMcpEnabledInSettings(settingsPath, false);
    report.phases.push({
      name: 'disabled-setup',
      settingsPath,
    });

    log('phase', 'Starting app to generate MCP token');
    app = startApp(layout.appSupportDir);
    const authToken = await waitFor(
      () => readMcpAuthToken(settingsPath),
      SOCKET_TIMEOUT_MS,
      'generated MCP auth token'
    );
    report.phases.push({
      name: 'token-generated',
      tokenLength: authToken.length,
    });

    const disabledMessage = await waitFor(
      async () => {
        try {
          return await expectDisabled(
            layout.appSupportDir,
            options.protocolVersion,
            authToken
          );
        } catch {
          return null;
        }
      },
      DISABLED_PHASE_TIMEOUT_MS,
      'disabled MCP error'
    );
    report.phases.push({
      name: 'disabled-error',
      message: disabledMessage,
    });

    log('phase', 'Enabling MCP in isolated settings');
    await app.stop();
    app = null;
    setMcpEnabledInSettings(settingsPath, true);
    log('phase', 'Restarting app with MCP enabled');
    app = startApp(layout.appSupportDir);

    const socketPath = await waitForSocket(layout.appSupportDir);
    const enabledSettings = await waitForToolSuccess(
      layout.appSupportDir,
      options.protocolVersion,
      authToken,
      'syncwatcher_get_settings',
      {}
    );
    assert(enabledSettings.settings?.mcpEnabled === true, 'Expected settings.mcpEnabled=true', JSON.stringify(enabledSettings));
    report.phases.push({
      name: 'enabled-startup',
      socketPath,
      settings: enabledSettings.settings,
    });

    const fixture = createFixture(layout, options.payloadMib);
    report.fixture = {
      sourceDir: fixture.sourceDir,
      targetDir: fixture.targetDir,
      notesPath: fixture.notesPath,
      payloadPath: fixture.payloadPath,
      orphanPath: fixture.orphanPath,
    };

    await withClient(layout.appSupportDir, options.protocolVersion, authToken, async (client) => {
      const listedTools = await client.listTools();
      const toolNames = (listedTools.tools ?? []).map((tool) => tool.name).sort();
      for (const toolName of EXPECTED_TOOLS) {
        assert(toolNames.includes(toolName), `Missing MCP tool '${toolName}'`);
      }
      report.phases.push({
        name: 'tools-list',
        toolCount: toolNames.length,
      });

      const taskName = `MCP Live Smoke ${new Date().toISOString()}`;
      const emptyTasks = await client.callTool('syncwatcher_list_sync_tasks', {});
      assert(Array.isArray(emptyTasks.tasks), 'Expected tasks array from list_sync_tasks');

      const createdTask = await client.callTool('syncwatcher_create_sync_task', {
        name: taskName,
        source: fixture.sourceDir,
        target: fixture.targetDir,
        checksumMode: false,
        verifyAfterCopy: true,
        exclusionSets: ['system-defaults'],
        watchMode: false,
        autoUnmount: false,
        sourceType: 'path',
      });
      const taskId = createdTask.task?.id;
      assert(typeof taskId === 'string' && taskId.length > 0, 'Expected created task id', JSON.stringify(createdTask));
      report.task = createdTask.task;

      const taskList = await client.callTool('syncwatcher_list_sync_tasks', {});
      assert(taskList.tasks.some((task) => task.id === taskId), 'Created task missing from task list');

      const fetchedTask = await client.callTool('syncwatcher_get_sync_task', { taskId });
      assert(fetchedTask.task?.id === taskId, 'Fetched task id mismatch');
      assert(fetchedTask.task?.watchMode === false, 'watchMode should be false');

      const runtimeState = await client.callTool('syncwatcher_get_runtime_state', {});
      assert(Array.isArray(runtimeState.runtimeState?.syncingTasks), 'Expected runtimeState.syncingTasks');
      const volumes = await client.callTool('syncwatcher_list_removable_volumes', {});
      assert(Array.isArray(volumes.volumes), 'Expected removable volumes array');
      report.phases.push({
        name: 'read-only-sanity',
        runtimeState: runtimeState.runtimeState,
        removableVolumeCount: volumes.volumes.length,
      });

      const dryRunStart = await client.callTool('syncwatcher_start_dry_run', { taskId });
      const dryRunJob = await pollJob(client, dryRunStart.jobId, JOB_TIMEOUTS_MS.dryRun);
      assert(dryRunJob.job.status === 'completed', 'Dry-run job did not complete', JSON.stringify(dryRunJob.job));
      const dryRunResult = dryRunJob.job.result;
      const dryRunPaths = relativeDiffPaths(dryRunResult.diffs ?? []);
      assert(!dryRunPaths.includes('.DS_Store'), 'Excluded .DS_Store appeared in dry-run');
      assert(dryRunPaths.includes('notes.txt'), 'notes.txt missing from dry-run diffs');
      assert(dryRunPaths.includes('payload.bin'), 'payload.bin missing from dry-run diffs');
      report.phases.push({
        name: 'dry-run',
        jobId: dryRunStart.jobId,
        filesToCopy: dryRunResult.filesToCopy,
        diffPaths: dryRunPaths,
      });

      const orphanStart = await client.callTool('syncwatcher_start_orphan_scan', { taskId });
      const orphanJob = await pollJob(client, orphanStart.jobId, JOB_TIMEOUTS_MS.orphanScan);
      assert(orphanJob.job.status === 'completed', 'Orphan-scan job did not complete', JSON.stringify(orphanJob.job));
      const orphanPaths = (orphanJob.job.result ?? []).map((entry) => String(entry.path));
      assert(orphanPaths.includes('orphan.txt'), 'Expected orphan.txt in orphan scan result');
      report.phases.push({
        name: 'orphan-scan',
        jobId: orphanStart.jobId,
        orphanPaths,
      });

      const syncStart = await client.callTool('syncwatcher_start_sync', { taskId });
      const syncJob = await pollJob(
        client,
        syncStart.jobId,
        JOB_TIMEOUTS_MS.sync,
        layout.syncScreenshotPath
      );
      assert(syncJob.job.status === 'completed', 'Sync job did not complete', JSON.stringify(syncJob.job));
      const syncResult = syncJob.job.result;
      const copiedFiles =
        syncResult.syncResult?.filesCopied ?? syncResult.syncResult?.files_copied ?? 0;
      assert(syncResult.hasPendingConflicts === false, 'Expected hasPendingConflicts=false');
      assert(syncResult.conflictSessionId === null, 'Expected conflictSessionId=null', JSON.stringify(syncResult));
      assert(copiedFiles >= 2, 'Expected at least 2 copied files', JSON.stringify(syncResult));

      const notesTarget = path.join(fixture.targetDir, 'notes.txt');
      const payloadTarget = path.join(fixture.targetDir, 'payload.bin');
      assert(fs.existsSync(notesTarget), 'Missing target notes.txt');
      assert(fs.existsSync(payloadTarget), 'Missing target payload.bin');
      assert(fs.readFileSync(notesTarget, 'utf8') === fixture.notesText, 'notes.txt content mismatch');
      assert(fs.statSync(payloadTarget).size === fs.statSync(fixture.payloadPath).size, 'payload.bin size mismatch');
      const [sourceHash, targetHash] = await Promise.all([
        hashFile(fixture.payloadPath),
        hashFile(payloadTarget),
      ]);
      assert(sourceHash === targetHash, 'payload.bin hash mismatch');

      const postSyncRuntime = await client.callTool('syncwatcher_get_runtime_state', {});
      assert(postSyncRuntime.runtimeState.syncingTasks.length === 0, 'Expected no syncingTasks after sync');
      assert(postSyncRuntime.runtimeState.queuedTasks.length === 0, 'Expected no queuedTasks after sync');
      report.phases.push({
        name: 'sync',
        jobId: syncStart.jobId,
        sawRunning: syncJob.sawRunning,
        sawProgress: syncJob.sawProgress,
        screenshotCaptured: syncJob.capturedScreenshot && fs.existsSync(layout.syncScreenshotPath),
        syncResult,
        payloadHash: targetHash,
      });
      report.screenshotPath = fs.existsSync(layout.syncScreenshotPath) ? layout.syncScreenshotPath : null;

      const deleted = await client.callTool('syncwatcher_delete_sync_task', { taskId });
      assert(deleted.deleted === true, 'Expected task deletion to succeed');
      const postDeleteTasks = await client.callTool('syncwatcher_list_sync_tasks', {});
      assert(postDeleteTasks.tasks.every((task) => task.id !== taskId), 'Deleted task still present');
      report.phases.push({
        name: 'cleanup-task',
        deleted: true,
      });

      const disabledSettings = await client.callTool('syncwatcher_update_settings', {
        mcpEnabled: false,
      });
      assert(disabledSettings.settings?.mcpEnabled === false, 'Expected settings.mcpEnabled=false after cleanup');
      await waitFor(
        () => !fs.existsSync(socketPath),
        10_000,
        'socket removal after disabling MCP'
      );

      let disabledAgain = '';
      try {
        await client.callTool('syncwatcher_get_settings', {});
        fail('Expected disabled MCP error after cleanup');
      } catch (error) {
        disabledAgain = error.message;
        assert(disabledAgain.includes('MCP control is disabled in SyncWatcher'), 'Expected disabled error after cleanup', disabledAgain);
      }
      report.phases.push({
        name: 'cleanup-disable',
        message: disabledAgain,
      });
    });

    await cleanup();
    log('result', 'Smoke test completed successfully');
    log('result', 'Report', layout.reportPath);
    if (report.screenshotPath) {
      log('result', 'Screenshot', report.screenshotPath);
    }
  } catch (error) {
    report.error = {
      message: error.message,
      detail: error.detail ?? null,
      stack: error.stack,
    };
    writeJson(layout.reportPath, report);
    if (app) {
      await app.stop();
    }
    log('error', 'Smoke test failed');
    log('error', 'Report', layout.reportPath);
    throw error;
  }
}

await run();
