#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const checkedInRoot = join(repositoryRoot, 'generated', 'codex-app-server');
const checkOnly = process.argv.includes('--check');

function readConfiguredBinary() {
  if (process.env.CODEX_CLI_PATH?.trim()) {
    return process.env.CODEX_CLI_PATH.trim();
  }

  const settingsPath = join(
    homedir(),
    'Library',
    'Application Support',
    'ATController',
    'settings.json'
  );
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (typeof settings.codexCliPath === 'string' && settings.codexCliPath.trim()) {
        return settings.codexCliPath.trim().replace(/^~(?=\/)/, homedir());
      }
    } catch {
      // A malformed application settings file should not prevent PATH discovery.
    }
  }

  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const marker = 'ATCONTROLLER_CODEX_CLI';
    const output = execFileSync(
      shell,
      ['-lic', `printf '\\036${marker}=%s\\036' "$(command -v codex 2>/dev/null || true)"`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    );
    const start = output.lastIndexOf(`\u001e${marker}=`);
    const valueStart = start < 0 ? -1 : start + marker.length + 2;
    const end = valueStart < 0 ? -1 : output.indexOf('\u001e', valueStart);
    const discovered = valueStart >= 0 && end >= 0 ? output.slice(valueStart, end).trim() : '';
    if (discovered && !discovered.includes('\n')) {
      return discovered;
    }
  } catch {
    // Fall through to the current process PATH.
  }
  return 'codex';
}

function run(binary, args, label) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed${detail ? `:\n${detail}` : '.'}`);
  }
  return result.stdout.trim();
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function treeDigest(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return null;
  }
  const digest = createHash('sha256');
  for (const path of walkFiles(root).sort()) {
    digest.update(relative(root, path));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

function canonicalizeJsonFiles(root) {
  for (const path of walkFiles(root).filter((entry) => entry.endsWith('.json'))) {
    const canonical = sortJson(JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(path, `${JSON.stringify(canonical, null, 2)}\n`);
  }
}

function writeVersionMetadata(root, version) {
  const metadata = {
    codexVersion: version,
    protocolTransport: 'stdio-jsonl',
    experimentalApi: false,
    generatedBy: 'codex app-server generate-ts and generate-json-schema'
  };
  writeFileSync(join(root, 'version.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

function generateInto(root, binary, version) {
  run(
    binary,
    ['app-server', 'generate-ts', '--out', root],
    'Codex app-server TypeScript generation'
  );
  run(
    binary,
    ['app-server', 'generate-json-schema', '--out', join(root, 'schema')],
    'Codex app-server JSON Schema generation'
  );
  writeVersionMetadata(root, version);
  canonicalizeJsonFiles(root);
}

const binary = readConfiguredBinary();
let version;
try {
  version = run(binary, ['--version'], 'Codex version detection');
  run(binary, ['app-server', 'generate-ts', '--help'], 'Codex app-server capability check');
  run(
    binary,
    ['app-server', 'generate-json-schema', '--help'],
    'Codex app-server schema capability check'
  );
} catch (error) {
  console.error(
    `Unable to generate the ATController protocol bindings with ${binary}.\n` +
      'Install or upgrade the official Codex CLI to a version that supports ' +
      '`codex app-server generate-ts` and `generate-json-schema`.\n' +
      String(error instanceof Error ? error.message : error)
  );
  process.exit(1);
}

if (checkOnly) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'atcontroller-codex-protocol-'));
  try {
    generateInto(temporaryRoot, binary, version);
    const expected = treeDigest(temporaryRoot);
    const actual = treeDigest(checkedInRoot);
    if (!actual || expected !== actual) {
      console.error(
        `Checked-in Codex app-server bindings do not match ${version}.\n` +
          'Run `yarn codex:generate-protocol` and commit the generated changes.'
      );
      process.exit(1);
    }
    console.log(`Codex app-server bindings match ${version}.`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
} else {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'atcontroller-codex-protocol-'));
  try {
    generateInto(temporaryRoot, binary, version);
    rmSync(checkedInRoot, { recursive: true, force: true });
    // Rename stays on the same APFS volume only when tmpdir and the repository do.
    // Copy through the filesystem API so generation also works in CI workspaces.
    const copyTree = (source, destination) => {
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory()) copyTree(from, to);
        else if (entry.isFile()) copyFileSync(from, to);
      }
    };
    copyTree(temporaryRoot, checkedInRoot);
    console.log(`Generated Codex app-server bindings for ${version}.`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
