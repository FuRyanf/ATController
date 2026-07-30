import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InspectorPanel } from '../../src/components/InspectorPanel';
import type {
  BrowserDiagnostics,
  BrowserSessionMetadata,
  CodexDiagnostics,
  CodexThread,
  GitInfo,
  GitWorkspaceStatus
} from '../../src/types';

const thread: CodexThread = {
  id: 'thread-1',
  sessionId: 'thread-1',
  title: 'Inspector workflow',
  preview: 'Changed a file',
  cwd: '/tmp/project',
  modelProvider: 'openai',
  createdAt: 1,
  updatedAt: 2,
  status: 'idle',
  source: 'appServer',
  cliVersion: '0.144.0',
  archived: false,
  turns: [
    {
      id: 'turn-1',
      status: 'completed',
      itemsView: 'full',
      items: [
        {
          id: 'command-1',
          kind: 'commandExecution',
          status: 'completed',
          command: 'git status',
          cwd: '/tmp/project',
          exitCode: 0,
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        },
        {
          id: 'file-1',
          kind: 'fileChange',
          summary: [],
          reasoning: [],
          content: [],
          changes: [
            {
              path: 'src/main.ts',
              kind: 'modified',
              diff: '-old\n+new\n'
            }
          ]
        }
      ]
    }
  ]
};

const gitInfo: GitInfo = {
  branch: 'main',
  shortHash: 'abc1234',
  isDirty: true,
  ahead: 0,
  behind: 0,
  isMainWorktree: true
};

const gitStatus: GitWorkspaceStatus = {
  isDirty: true,
  uncommittedFiles: 1,
  insertions: 1,
  deletions: 1,
  files: [
    {
      path: 'src/main.ts',
      status: 'modified',
      staged: false,
      insertions: 1,
      deletions: 1,
      binary: false
    }
  ]
};

const diagnostics: CodexDiagnostics = {
  atcontrollerVersion: '0.0.22',
  appServerSupported: true,
  generatedSchemaVersion: '0.144.0',
  transport: 'stdio-jsonl',
  connectionState: 'ready',
  initialized: true,
  pendingRequests: 0,
  eventQueueDepth: 0,
  recentStderr: [],
  recentProtocolErrors: [],
  restartAttempts: 0
};

const browserDiagnostics: BrowserDiagnostics = {
  node: { available: true, path: '/opt/node', version: 'v22.22.0' },
  npx: { available: true, path: '/opt/npx', version: '10.9.4' },
  browser: { available: true, path: '/opt/chrome', version: 'Chrome 150' },
  playwrightBrowsersAvailable: true,
  configuration: {
    serverName: 'atcontroller-playwright',
    configured: true,
    managedByAtcontroller: true,
    command: '/opt/npx',
    arguments: ['-y', '@playwright/mcp@0.0.77', '--isolated'],
    package: '@playwright/mcp',
    packageVersion: '0.0.77',
    isolated: true,
    headed: true,
    outputDirectory: '/tmp/browser-cache'
  },
  codexCanSeeServer: true,
  codexCanSeeBrowserTools: true,
  toolNames: ['browser_navigate', 'browser_take_screenshot'],
  screenshotCachePath: '/tmp/browser-cache',
  connectionState: 'ready'
};

const browserSession: BrowserSessionMetadata = {
  threadId: 'thread-1',
  workspacePath: '/tmp/project',
  browserSessionId: 'browser-session-1',
  state: 'ready',
  lastUrl: 'http://127.0.0.1:3000/',
  lastPageTitle: 'Local application',
  panelVisible: true,
  windowVisible: true,
  controlOwner: 'codex',
  lastActivityAt: '2026-07-29T12:00:00Z',
  consoleErrorCount: 2,
  failedRequestCount: 1,
  recentActivities: []
};

function props() {
  return {
    thread,
    workspacePath: '/tmp/project',
    diagnostics,
    browserDiagnostics: null,
    browserBusy: false,
    gitInfo,
    gitStatus,
    gitBranches: [
      { name: 'main', isCurrent: true, lastCommitUnix: 2 },
      { name: 'feature', isCurrent: false, lastCommitUnix: 1 }
    ],
    onClose: vi.fn(),
    onCopy: vi.fn(),
    onOpenFile: vi.fn(),
    onRevealFile: vi.fn(),
    onLoadDiff: vi.fn(async () => '-old\n+new\n'),
    onRevertFile: vi.fn(),
    onSwitchBranch: vi.fn(),
    onCreateBranch: vi.fn(),
    onCopyPatch: vi.fn(),
    onCopyResume: vi.fn(),
    onOpenResumeInTerminal: vi.fn(),
    onOpenTerminal: vi.fn(),
    onRestartRuntime: vi.fn(),
    onBrowserAction: vi.fn(),
    onBrowserSetup: vi.fn(),
    onBrowserDiagnostics: vi.fn(),
    onOpenBrowserPage: vi.fn()
  };
}

describe('structured session inspector', () => {
  it('loads Git diffs, exposes file actions, and locks branch changes while dirty', async () => {
    const user = userEvent.setup();
    const control = props();
    render(<InspectorPanel {...control} />);

    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeDisabled();
    expect(screen.getByText(/Branch changes are locked/)).toBeInTheDocument();
    await user.click(screen.getByText('main.ts'));
    await waitFor(() => expect(screen.getByText(/\+new/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Open file' }));
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await user.click(
      screen.getByRole('button', { name: /Copy working tree patch/ })
    );

    expect(control.onLoadDiff).toHaveBeenCalledWith('src/main.ts');
    expect(control.onOpenFile).toHaveBeenCalledWith('src/main.ts');
    expect(control.onRevealFile).toHaveBeenCalledWith('src/main.ts');
    expect(control.onRevertFile).toHaveBeenCalledWith('src/main.ts');
    expect(control.onCopyPatch).toHaveBeenCalledOnce();
  });

  it('summarizes command history, canonical thread details, and runtime recovery', async () => {
    const user = userEvent.setup();
    const control = props();
    render(<InspectorPanel {...control} />);

    await user.click(screen.getByRole('button', { name: /^commands/i }));
    expect(screen.getByText('git status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^thread/i }));
    expect(screen.getByText('thread-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy resume command' }));
    await user.click(screen.getByRole('button', { name: 'Copy Full Access resume command' }));
    await user.click(screen.getByRole('button', { name: 'Open resume command in Terminal' }));
    expect(control.onCopyResume).toHaveBeenNthCalledWith(1, false);
    expect(control.onCopyResume).toHaveBeenNthCalledWith(2, true);
    expect(control.onOpenResumeInTerminal).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /^runtime/i }));
    expect(screen.getByText('Structured app-server connection initialized')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /Restart Codex runtime/ })
    );
    expect(control.onRestartRuntime).toHaveBeenCalledOnce();
  });

  it('shows browser state and routes browser lifecycle actions', async () => {
    const user = userEvent.setup();
    const control = {
      ...props(),
      browserDiagnostics,
      browserSession
    };
    render(<InspectorPanel {...control} />);

    await user.click(screen.getByRole('button', { name: /^browser/i }));
    expect(screen.getByText('Local application')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take Control' }));
    await user.click(
      screen.getByRole('button', { name: 'Inspect console errors' })
    );
    await user.click(
      screen.getByRole('button', { name: 'Inspect failed requests' })
    );
    expect(control.onBrowserAction).toHaveBeenNthCalledWith(1, 'takeControl');
    expect(control.onBrowserAction).toHaveBeenNthCalledWith(2, 'inspectConsole');
    expect(control.onBrowserAction).toHaveBeenNthCalledWith(3, 'inspectNetwork');
  });

  it('offers explicit browser recovery after an app-server disconnect', async () => {
    const user = userEvent.setup();
    const control = {
      ...props(),
      browserDiagnostics,
      browserSession: {
        ...browserSession,
        state: 'disconnected' as const,
        windowVisible: false
      }
    };
    render(<InspectorPanel {...control} />);

    await user.click(screen.getByRole('button', { name: /^browser/i }));
    expect(screen.getByText('Browser disconnected')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Recover Browser Session' })
    );
    expect(control.onBrowserAction).toHaveBeenCalledWith('restart');
  });
});
