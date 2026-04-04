import { readFile, writeFile } from 'node:fs/promises';

const mode = process.argv[2];
const versionArg = process.argv[3];
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const packageJsonPath = new URL('../package.json', import.meta.url);
const tauriConfigPath = new URL('../src-tauri/tauri.conf.json', import.meta.url);
const cargoTomlPath = new URL('../src-tauri/Cargo.toml', import.meta.url);
const cargoLockPath = new URL('../src-tauri/Cargo.lock', import.meta.url);

function assertSemver(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid version "${version}". Expected SemVer like 0.0.1.`);
  }
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readVersions() {
  const pkg = await readJson(packageJsonPath);
  const tauri = await readJson(tauriConfigPath);
  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const cargoLock = await readFile(cargoLockPath, 'utf8');

  const cargoTomlMatch = cargoToml.match(/^version = "([^"]+)"/m);
  const cargoLockMatch = cargoLock.match(/name = "atcontroller"\nversion = "([^"]+)"/m);

  if (!cargoTomlMatch || !cargoLockMatch) {
    throw new Error('Unable to parse Rust version metadata.');
  }

  return {
    packageJson: pkg.version,
    tauriConfig: tauri.version,
    cargoToml: cargoTomlMatch[1],
    cargoLock: cargoLockMatch[1]
  };
}

async function setVersion(version) {
  assertSemver(version);

  const pkg = await readJson(packageJsonPath);
  pkg.version = version;
  await writeJson(packageJsonPath, pkg);

  const tauri = await readJson(tauriConfigPath);
  tauri.version = version;
  await writeJson(tauriConfigPath, tauri);

  const cargoToml = await readFile(cargoTomlPath, 'utf8');
  const nextCargoToml = cargoToml.replace(/^version = "([^"]+)"/m, `version = "${version}"`);
  await writeFile(cargoTomlPath, nextCargoToml, 'utf8');

  const cargoLock = await readFile(cargoLockPath, 'utf8');
  const nextCargoLock = cargoLock.replace(
    /name = "atcontroller"\nversion = "([^"]+)"/m,
    `name = "atcontroller"\nversion = "${version}"`
  );
  await writeFile(cargoLockPath, nextCargoLock, 'utf8');
}

async function checkVersion(expectedVersion) {
  if (expectedVersion) {
    assertSemver(expectedVersion);
  }

  const versions = await readVersions();
  const unique = [...new Set(Object.values(versions))];

  if (unique.length !== 1) {
    throw new Error(
      `Version mismatch: ${Object.entries(versions)
        .map(([name, value]) => `${name}=${value}`)
        .join(', ')}`
    );
  }

  const [currentVersion] = unique;
  if (expectedVersion && currentVersion !== expectedVersion) {
    throw new Error(`Version mismatch: repo is ${currentVersion}, expected ${expectedVersion}.`);
  }

  console.log(currentVersion);
}

if (mode === 'set') {
  if (!versionArg) {
    throw new Error('Usage: node scripts/sync-version.mjs set <version>');
  }
  await setVersion(versionArg);
  await checkVersion(versionArg);
} else if (mode === 'check') {
  await checkVersion(versionArg);
} else {
  throw new Error('Usage: node scripts/sync-version.mjs <set|check> [version]');
}
