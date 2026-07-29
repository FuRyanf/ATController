import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks (minimal — mirrors app.full-access.test.tsx) ───────────────────────

const mocks = vi.hoisted(() => {
  const baseWorkspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    kind: 'local' as const,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Test Thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    codexSessionId: null
  };

  let threadState = [{ ...baseThread }];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => [baseWorkspace]),
    addWorkspace: vi.fn(async () => baseWorkspace),
    addSshWorkspace: vi.fn(async () => baseWorkspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => baseWorkspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({ isDirty: false, uncommittedFiles: 0, insertions: 0, deletions: 0 })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({ outcome: 'pulled' as const, message: '' })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      const t = { ...baseThread, id: 'thread-2', title: 'New Thread' };
      threadState = [t, ...threadState];
      return t;
    }),
    renameThread: vi.fn(async () => threadState[0]),
    archiveThread: vi.fn(async () => threadState[0]),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => threadState[0]),
    clearThreadCodexSession: vi.fn(async () => threadState[0]),
    setThreadSkills: vi.fn(async () => { throw new Error('not needed'); }),
    listSkills: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ codexCliPath: '/usr/local/bin/codex' })),
    saveSettings: vi.fn(async (s: { codexCliPath: string | null }) => s),
    detectCodexCliPath: vi.fn(async () => '/usr/local/bin/codex'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new' as const,
      resumeSessionId: null,
      thread: { ...baseThread, codexSessionId: null, lastResumeAt: null, lastNewSessionAt: new Date().toISOString() }
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    openExternalUrl: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableCodexSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    threadState = [{ ...baseThread }];
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onTerminalData: vi.fn(async () => () => undefined),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
    onTerminalTurnCompleted: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    onThreadUpdated: vi.fn(async () => () => undefined)
  };
});

vi.mock('../../src/lib/api', () => ({
  api: mocks.api,
  onTerminalData: mocks.onTerminalData,
  onTerminalReady: mocks.onTerminalReady,
  onTerminalSshAuthStatus: mocks.onTerminalSshAuthStatus,
  onTerminalTurnCompleted: mocks.onTerminalTurnCompleted,
  onTerminalExit: mocks.onTerminalExit,
  onThreadUpdated: mocks.onThreadUpdated
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
  confirm: mocks.confirmDialog
}));

import App from '../../src/App';

// ── tests ────────────────────────────────────────────────────────────────────

describe('Header actions', () => {
  beforeEach(() => {
    mocks.reset();
    window.localStorage.clear();
  });

  it('does not render a refresh display button', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /Test Thread/i });
    expect(screen.queryByRole('button', { name: 'Refresh Display' })).not.toBeInTheDocument();
  });

  it('orders header actions with update first when available', async () => {
    mocks.api.checkForUpdate.mockResolvedValueOnce({
      currentVersion: '0.1.0',
      latestVersion: '0.1.1',
      updateAvailable: true,
      releaseNotes: null,
      releaseUrl: null
    });

    render(<App />);
    await screen.findByRole('button', { name: /Test Thread/i });
    await screen.findByRole('button', { name: 'Update' });

    const headerActions = screen.getByTestId('header').querySelector('.header-actions');
    expect(headerActions).not.toBeNull();

    const actionLabels = Array.from(headerActions?.querySelectorAll('button') ?? []).map((button) =>
      button.textContent?.trim()
    );

    expect(actionLabels).toEqual(['Update', 'Open', 'Terminal']);
  });
});
