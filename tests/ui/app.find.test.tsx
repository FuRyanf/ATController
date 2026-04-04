import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    kind: 'local' as const,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const thread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    agentId: 'claude-code',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Search thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    addSshWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceOrder: vi.fn(async () => [workspace]),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => workspace),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: false,
      uncommittedFiles: 0,
      insertions: 0,
      deletions: 0
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => [thread]),
    createThread: vi.fn(async () => thread),
    renameThread: vi.fn(async () => thread),
    archiveThread: vi.fn(async () => thread),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => thread),
    clearThreadClaudeSession: vi.fn(async () => thread),
    setThreadSkills: vi.fn(async () => thread),
    setThreadAgent: vi.fn(async () => thread),
    appendUserMessage: vi.fn(async () => thread),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
    saveSettings: vi.fn(async (settings: { claudeCliPath: string | null }) => settings),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.28',
      latestVersion: '0.1.28',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new' as const,
      resumeSessionId: null,
      thread
    })),
    workspaceShellStartSession: vi.fn(async () => ({
      sessionId: 'shell-session-1'
    })),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    window.localStorage.clear();
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async () => () => undefined),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
    onTerminalTurnCompleted: vi.fn(async () => () => undefined),
    onTerminalExit: vi.fn(async () => () => undefined),
    onThreadUpdated: vi.fn(async () => () => undefined),
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true)
  };
});

vi.mock('../../src/lib/api', () => ({
  api: mocks.api,
  onRunStream: mocks.onRunStream,
  onRunExit: mocks.onRunExit,
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

vi.mock('../../src/components/TerminalPanel', async () => {
  const React = await import('react');

  return {
    TerminalPanel: ({
      sessionId,
      searchToggleRequestId = 0,
      onFocusChange
    }: {
      sessionId?: string | null;
      searchToggleRequestId?: number;
      onFocusChange?: (focused: boolean) => void;
    }) => (
      <section data-testid={`terminal-panel-${sessionId ?? 'pending'}`}>
        <button type="button" onClick={() => onFocusChange?.(true)}>
          focus-{sessionId ?? 'pending'}
        </button>
        {searchToggleRequestId % 2 === 1 ? <div>search-{sessionId ?? 'pending'}</div> : null}
      </section>
    )
  };
});

import App from '../../src/App';

describe('Terminal search shortcuts', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('toggles terminal search on the focused Claude terminal with Cmd+F', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Search thread/i });
    await user.click(await screen.findByRole('button', { name: 'focus-session-1' }));

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(await screen.findByText('search-session-1')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await waitFor(() => {
      expect(screen.queryByText('search-session-1')).not.toBeInTheDocument();
    });
  });

  it('routes Cmd+F to the workspace shell when the shell terminal is focused', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Search thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalled();
    });

    await user.click(await screen.findByRole('button', { name: 'focus-shell-session-1' }));

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(await screen.findByText('search-shell-session-1')).toBeInTheDocument();
    expect(screen.queryByText('search-session-1')).not.toBeInTheDocument();
  });
});
