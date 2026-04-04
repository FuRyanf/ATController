import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = process.cwd();
const artifactsDir = path.join(root, 'artifacts');
const e2eDir = path.join(artifactsDir, 'e2e');

const steps = [
  {
    id: 'frontend-build',
    cmd: 'yarn',
    args: ['build']
  },
  {
    id: 'ui-tests',
    cmd: 'yarn',
    args: ['test:ui']
  },
  {
    id: 'rust-tests',
    cmd: 'cargo',
    args: ['test', '--manifest-path', 'src-tauri/Cargo.toml']
  },
  {
    id: 'claude-pty-smoke',
    cmd: 'python3',
    args: ['scripts/claude_pty_smoke.py']
  }
];

async function ensureDirs() {
  await mkdir(e2eDir, { recursive: true });
}

function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, {
      cwd: root,
      env: { ...process.env, RUST_BACKTRACE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

async function writeLog(stepId, output) {
  const filePath = path.join(e2eDir, `${stepId}.log`);
  await writeFile(filePath, output, 'utf8');
  return filePath;
}

function httpReady(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForHttp(url, maxAttempts = 30, delayMs = 500) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await httpReady(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function captureScreenshots() {
  const preview = spawn('yarn', ['preview', '--host', '127.0.0.1', '--port', '4173'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let previewOutput = '';
  preview.stdout.on('data', (chunk) => {
    previewOutput += chunk.toString();
  });
  preview.stderr.on('data', (chunk) => {
    previewOutput += chunk.toString();
  });

  try {
    const ready = await waitForHttp('http://127.0.0.1:4173');
    if (!ready) {
      throw new Error('vite preview did not start in time');
    }

    let chromium;
    try {
      ({ chromium } = await import('@playwright/test'));
    } catch (error) {
      throw new Error(`Playwright import failed: ${String(error)}`);
    }

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const install = await runStep({
        id: 'install-playwright',
        cmd: 'yarn',
        args: ['playwright', 'install', 'chromium']
      });
      await writeLog('playwright-install', install.output);
      if (install.code !== 0) {
        throw new Error(`Playwright browser install failed: ${install.output.split('\n').slice(-20).join('\n')}`);
      }
      browser = await chromium.launch({ headless: true });
    }

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(e2eDir, 'app-shell.png'), fullPage: true });

    await browser.close();
  } finally {
    preview.kill('SIGTERM');
    await writeFile(path.join(e2eDir, 'preview.log'), previewOutput, 'utf8');
  }
}

function summarizeRootCause(stepId) {
  if (stepId.includes('ui-tests')) {
    return [
      '- UI behavior regressed against expected interactions.',
      '- Check `/Users/you/Claudex/src/App.tsx`, `/Users/you/Claudex/src/components/LeftRail.tsx`, and `/Users/you/Claudex/src/components/TerminalPanel.tsx`.'
    ];
  }
  if (stepId.includes('rust-tests')) {
    return [
      '- Backend persistence or git detection behavior regressed.',
      '- Check `/Users/you/Claudex/src-tauri/src/storage.rs`, `/Users/you/Claudex/src-tauri/src/git_tools.rs`, and `/Users/you/Claudex/src-tauri/src/skills.rs`.'
    ];
  }
  if (stepId.includes('claude-pty-smoke')) {
    return [
      '- Claude interactive PTY behavior regressed.',
      '- Check `/Users/you/Claudex/src-tauri/src/runner.rs` and `/Users/you/Claudex/src/components/TerminalPanel.tsx` for key forwarding or streaming issues.'
    ];
  }
  return [
    '- Build pipeline regression detected.',
    '- Check frontend dependency or compile errors in `/Users/you/Claudex/package.json` and `/Users/you/Claudex/src`.'
  ];
}

async function writeDiagnosis(failure) {
  const lines = [];
  lines.push('Last Diagnosis');
  lines.push('');

  if (!failure) {
    lines.push('No failures detected.');
    lines.push('');
    lines.push('Checks passed:');
    for (const step of steps) {
      lines.push(`- ${step.id}`);
    }
    await writeFile(path.join(artifactsDir, 'last_diagnosis.txt'), lines.join('\n'), 'utf8');
    return;
  }

  lines.push(`Failing step: ${failure.id}`);
  lines.push(`Exit code: ${failure.code}`);
  lines.push(`Log file: artifacts/e2e/${failure.id}.log`);
  lines.push('');
  lines.push('Likely root causes:');
  lines.push(...summarizeRootCause(failure.id));
  lines.push('');
  lines.push('Suggested next changes:');
  lines.push('- Re-run the failing step locally with verbose output.');
  lines.push('- Use artifacts/e2e screenshots and logs to confirm UI state and stack traces.');
  lines.push('- Patch the implicated files, then run `make verify` again.');
  lines.push('');
  lines.push('Failure excerpt (tail):');

  const tail = failure.output.split('\n').slice(-60);
  for (const line of tail) {
    lines.push(`    ${line}`);
  }

  await writeFile(path.join(artifactsDir, 'last_diagnosis.txt'), lines.slice(0, 190).join('\n'), 'utf8');
}

async function main() {
  await ensureDirs();

  let failure = null;

  for (const step of steps) {
    console.log(`\n==> ${step.id}`);
    const result = await runStep(step);
    await writeLog(step.id, result.output);

    if (result.code !== 0) {
      failure = { id: step.id, code: result.code, output: result.output };
      break;
    }
  }

  if (failure) {
    try {
      if (existsSync(path.join(root, 'dist', 'index.html'))) {
        await captureScreenshots();
      }
    } catch (error) {
      await writeFile(path.join(e2eDir, 'screenshot-error.log'), String(error), 'utf8');
    }
  }

  await writeDiagnosis(failure);

  if (failure) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  await ensureDirs();
  await writeFile(path.join(e2eDir, 'verify-crash.log'), String(error), 'utf8');
  await writeDiagnosis({ id: 'verify-script', code: 1, output: String(error) });
  process.exit(1);
});
