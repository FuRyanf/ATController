import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const decode = (hex) => Buffer.from(hex, 'hex').toString('utf8');
const forbiddenPatterns = [
  { id: 'retired-runtime-1', value: decode('636c61756465') },
  { id: 'retired-runtime-2', value: decode('636f70696c6f74') },
  { id: 'invalid-product-alias-1', value: decode('636f64657820636f6e74726f6c6c6572') },
  { id: 'invalid-product-alias-2', value: decode('6174636f6e74726f6c6c657220636f646578') },
  { id: 'invalid-product-alias-3', value: decode('636f646578636f6e74726f6c6c6572') },
  { id: 'retired-runtime-abstraction', value: decode('6167656e7470726f7669646572') }
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function trackedFiles() {
  const raw = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'buffer'
    }
  );
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => existsSync(path.join(root, relativePath)));
}

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

function auditTrackedSources() {
  for (const relativePath of trackedFiles()) {
    const lowerPath = relativePath.toLocaleLowerCase('en-US');
    for (const pattern of forbiddenPatterns) {
      if (lowerPath.includes(pattern.value)) {
        fail(`${pattern.id}: forbidden tracked path: ${relativePath}`);
      }
    }

    const buffer = readFileSync(path.join(root, relativePath));
    if (!isText(buffer)) {
      continue;
    }
    const lines = buffer.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const lowerLine = line.toLocaleLowerCase('en-US');
      for (const pattern of forbiddenPatterns) {
        if (lowerLine.includes(pattern.value)) {
          fail(`${pattern.id}: forbidden source reference at ${relativePath}:${index + 1}`);
        }
      }
    });
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
  }
}

function auditIdentity() {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(
    readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')
  );
  const cargoToml = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const workflow = readFileSync(
    path.join(root, '.github/workflows/build-macos.yml'),
    'utf8'
  );
  const tauriMain = readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

  requireEqual(packageJson.name, 'atcontroller', 'package name');
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    fail('package version must use stable numeric SemVer (major.minor.patch)');
  }
  if (!packageJson.description?.startsWith('ATController ')) {
    fail('package description must lead with the ATController product name');
  }
  if (!cargoToml.includes('description = "ATController ')) {
    fail('Rust package description must lead with the ATController product name');
  }
  requireEqual(tauriConfig.productName, 'ATController', 'Tauri product name');
  requireEqual(tauriConfig.identifier, 'com.furyanf.atcontroller', 'macOS bundle identifier');
  requireEqual(tauriConfig.app?.windows?.[0]?.title, 'ATController', 'main window title');
  requireEqual(
    tauriConfig.bundle?.macOS?.bundleVersion,
    packageJson.version,
    'macOS bundle version'
  );
  if (!tauriMain.includes('.enable_macos_default_menu(true)')) {
    fail('Tauri must enable the native macOS application and About menu');
  }

  for (const requiredText of [
    'release-assets/ATController.dmg',
    'release-assets/ATController.app.zip'
  ]) {
    if (!workflow.includes(requiredText)) {
      fail(`Release workflow is missing exact artifact path: ${requiredText}`);
    }
  }

  if (!readme.startsWith('# ATController\n')) {
    fail('README must start with the ATController product name');
  }
  if (!readme.includes('~/Library/Application Support/ATController/')) {
    fail('README must document the stable ATController application-support directory');
  }
}

auditTrackedSources();
auditIdentity();

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('ATController branding and runtime audit passed.');
