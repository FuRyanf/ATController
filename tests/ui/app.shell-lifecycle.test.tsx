import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspaces = [
    {
      id: 'ws-1',
      name: 'Workspace One',
      path: '/tmp/workspace-one',
      kind: 'local' as const,
      sshCommand: null,
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: 'ws-2',
      name: 'Workspace Two',
      path: '/tmp/workspace-two',
      kind: 'local' as const,
      sshCommand: null,
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: 'ws-ssh',
      name: 'Workspace SSH',
      path: 'ssh-workspace-shell',
      kind: 'ssh' as const,
      sshCommand: 'ssh dev@remote-host',
      remotePath: '~/projects/example',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  const threadsByWorkspace = {
    'ws-1': [
      {
        id: 'thread-a',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        updatedAt: new Date(Date.now() - 10_000).toISOString(),
        title: 'Alpha thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ],
    'ws-2': [
      {
        id: 'thread-b',
        workspaceId: 'ws-2',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        updatedAt: new Date(Date.now() - 5_000).toISOString(),
        title: 'Beta thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ],
    'ws-ssh': [
      {
        id: 'thread-ssh',
        workspaceId: 'ws-ssh',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        createdAt: new Date(Date.now() - 2_000).toISOString(),
        updatedAt: new Date(Date.now() - 2_000).toISOString(),
        title: 'Gamma SSH thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ]
  };

  let terminalSshAuthStatusHandler:
    | ((event: {
        sessionId: string;
        workspaceId: string;
        threadId?: string | null;
        reason: 'host-verification-required' | 'password-auth-unsupported' | 'interactive-auth-unsupported';
      }) => void)
    | null = null;
  let terminalExitHandler: ((event: { sessionId: string; code?: number | null; signal?: string | null }) => void) | null =
    null;

  const getGitInfoImpl = async (workspacePath: string) => ({
    branch: workspacePath.includes('two') ? 'feature/two' : 'main',
    shortHash: 'abc123',
    isDirty: false,
    ahead: 0,
    behind: 0
  });
  const gitListBranchesImpl = async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }];
  const listThreadsImpl = async (workspaceId: string) =>
    threadsByWorkspace[workspaceId as 'ws-1' | 'ws-2' | 'ws-ssh'] ?? [];
  const terminalStartSessionImpl = async (params: { threadId: string }) => ({
    sessionId: `session-${params.threadId}`,
    sessionMode: 'new' as const,
    resumeSessionId: null,
    thread: Object.values(threadsByWorkspace)
      .flat()
      .find((thread) => thread.id === params.threadId)
  });
  const workspaceShellStartSessionImpl = async () => ({
    sessionId: 'shell-session-default'
  });
  const terminalReadOutputImpl = async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false });

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => workspaces),
    addWorkspace: vi.fn(async () => workspaces[0]),
    addSshWorkspace: vi.fn(async () => workspaces[0]),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceOrder: vi.fn(async (workspaceIds: string[]) => {
      return workspaceIds
        .map((workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId))
        .filter(Boolean);
    }),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (workspaceId: string, enabled: boolean) => {
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0];
      return {
        ...workspace,
        gitPullOnMasterForNewThreads: enabled,
        updatedAt: new Date().toISOString()
      };
    }),
    getGitInfo: vi.fn(getGitInfoImpl),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(gitListBranchesImpl),
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
    listThreads: vi.fn(listThreadsImpl),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    renameThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    archiveThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    deleteThread: vi.fn(async () => true),
    setThreadFullAccess: vi.fn(async () => {
      throw new Error('not needed');
    }),
    clearThreadClaudeSession: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    appendUserMessage: vi.fn(async () => {
      throw new Error('not needed');
    }),
    loadTranscript: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    buildContextPreview: vi.fn(async () => ({ files: [], totalSize: 0, contextText: '' })),
    getSettings: vi.fn(async () => ({ claudeCliPath: '/usr/local/bin/claude' })),
    saveSettings: vi.fn(async (settings: { claudeCliPath: string | null }) => settings),
    detectClaudeCliPath: vi.fn(async () => '/usr/local/bin/claude'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(terminalStartSessionImpl),
    workspaceShellStartSession: vi.fn(workspaceShellStartSessionImpl),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async (_workspaceId: string, threadId: string) => ({
      text: `log-${threadId}`,
      startPosition: 0,
      endPosition: `log-${threadId}`.length,
      truncated: false
    })),
    terminalReadOutput: vi.fn(terminalReadOutputImpl),
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
    terminalSshAuthStatusHandler = null;
    terminalExitHandler = null;
    api.getGitInfo.mockReset();
    api.getGitInfo.mockImplementation(getGitInfoImpl);
    api.gitListBranches.mockReset();
    api.gitListBranches.mockImplementation(gitListBranchesImpl);
    api.gitCheckoutBranch.mockReset();
    api.gitCheckoutBranch.mockResolvedValue(true);
    api.listThreads.mockReset();
    api.listThreads.mockImplementation(listThreadsImpl);
    api.terminalStartSession.mockReset();
    api.terminalStartSession.mockImplementation(terminalStartSessionImpl);
    api.workspaceShellStartSession.mockReset();
    api.workspaceShellStartSession.mockImplementation(workspaceShellStartSessionImpl);
    api.terminalReadOutput.mockReset();
    api.terminalReadOutput.mockImplementation(terminalReadOutputImpl);
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
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async () => () => undefined),
    onTerminalReady: vi.fn(async () => () => undefined),
    emitTerminalSshAuthStatus: (event: {
      sessionId: string;
      workspaceId: string;
      threadId?: string | null;
      reason: 'host-verification-required' | 'password-auth-unsupported' | 'interactive-auth-unsupported';
    }) => {
      terminalSshAuthStatusHandler?.(event);
    },
    onTerminalSshAuthStatus: vi.fn(
      async (
        handler: (event: {
          sessionId: string;
          workspaceId: string;
          threadId?: string | null;
          reason: 'host-verification-required' | 'password-auth-unsupported' | 'interactive-auth-unsupported';
        }) => void
      ) => {
        terminalSshAuthStatusHandler = handler;
        return () => {
          if (terminalSshAuthStatusHandler === handler) {
            terminalSshAuthStatusHandler = null;
          }
        };
      }
    ),
    onTerminalTurnCompleted: vi.fn(async () => () => undefined),
    emitTerminalExit: (event: { sessionId: string; code?: number | null; signal?: string | null }) => {
      terminalExitHandler?.(event);
    },
    onTerminalExit: vi.fn(
      async (handler: (event: { sessionId: string; code?: number | null; signal?: string | null }) => void) => {
        terminalExitHandler = handler;
        return () => {
          if (terminalExitHandler === handler) {
            terminalExitHandler = null;
          }
        };
      }
    ),
    onThreadUpdated: vi.fn(async () => () => undefined)
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

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel-mock" />
}));

vi.mock('../../src/components/WorkspaceShellDrawer', () => ({
  WorkspaceShellDrawer: (props: {
    open: boolean;
    workspace?: { name?: string };
    sessionId?: string | null;
    starting?: boolean;
    blockedMessage?: string;
    streamState?: { text?: string; phase?: string } | null;
    onClose: () => void;
    onOpenInTerminal?: () => void;
  }) =>
    props.open ? (
      <section data-testid="workspace-shell-drawer">
        <span>{props.workspace?.name ?? 'No workspace'}</span>
        <span>{props.sessionId ?? 'pending'}</span>
        <span>{String(Boolean(props.starting))}</span>
        <span data-testid="workspace-shell-stream-phase">{props.streamState?.phase ?? 'missing'}</span>
        <span data-testid="workspace-shell-stream-text">{props.streamState?.text ?? ''}</span>
        <span data-testid="workspace-shell-blocked-message">{props.blockedMessage ?? ''}</span>
        <button type="button" onClick={props.onOpenInTerminal}>
          open-external-shell
        </button>
        <button type="button" onClick={props.onClose}>
          close-shell
        </button>
      </section>
    ) : null
}));

import App from '../../src/App';

describe('Workspace shell lifecycle', () => {
  beforeEach(() => {
    mocks.reset();
    mocks.onTerminalData.mockReset();
    mocks.onTerminalData.mockImplementation(async () => () => undefined);
    mocks.api.workspaceShellStartSession.mockReset();
    mocks.api.workspaceShellStartSession.mockResolvedValue({
      sessionId: 'shell-session-default'
    });
    mocks.api.gitListBranches.mockReset();
    mocks.api.gitListBranches.mockResolvedValue([{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]);
  });

  it('starts the workspace shell only once while the initial open is pending', async () => {
    const user = userEvent.setup();
    let resolveShellStart: ((value: { sessionId: string }) => void) | null = null;
    mocks.api.workspaceShellStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveShellStart = resolve;
        })
    );

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(1);
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 40);
    });
    expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(1);

    resolveShellStart?.({ sessionId: 'shell-session-ws1' });

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
    });
  });

  it('kills stale shell starts when the selected workspace changes mid-launch', async () => {
    const user = userEvent.setup();
    let resolveFirstShellStart: ((value: { sessionId: string }) => void) | null = null;

    let shellStartCount = 0;
    mocks.api.workspaceShellStartSession.mockImplementation(async () => {
      shellStartCount += 1;
      if (shellStartCount === 1) {
        return await new Promise((resolve) => {
          resolveFirstShellStart = resolve;
        });
      }
      return {
        sessionId: 'shell-session-ws2'
      };
    });

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.click(screen.getByRole('button', { name: /Beta thread/i }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-two' })
      );
    });

    resolveFirstShellStart?.({ sessionId: 'shell-session-ws1' });

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ws1');
    });
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('Workspace Two');
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws2');
  });

  it('renders live workspace shell output chunks', async () => {
    const user = userEvent.setup();
    let terminalDataHandler: ((event: {
      sessionId: string;
      threadId?: string | null;
      data: string;
      startPosition: number;
      endPosition: number;
    }) => void) | null = null;
    mocks.onTerminalData.mockImplementation(async (handler) => {
      terminalDataHandler = handler;
      return () => undefined;
    });
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
      expect(screen.getByTestId('workspace-shell-stream-phase')).toHaveTextContent('ready');
    });

    terminalDataHandler?.({
      sessionId: 'shell-session-ws1',
      threadId: null,
      data: 'echo hi',
      startPosition: 0,
      endPosition: 7
    });

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-stream-text')).toHaveTextContent('echo hi');
    });
  });

  it('keeps the replacement workspace shell marked as starting when a stale prior start fails', async () => {
    const user = userEvent.setup();
    let rejectFirstShellStart: ((reason?: unknown) => void) | null = null;
    let resolveSecondShellStart: ((value: { sessionId: string }) => void) | null = null;

    mocks.api.workspaceShellStartSession
      .mockImplementationOnce(
        async () =>
          await new Promise((_, reject) => {
            rejectFirstShellStart = reject;
          })
      )
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            resolveSecondShellStart = resolve;
          })
      );

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.click(screen.getByRole('button', { name: /Beta thread/i }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-two' })
      );
    });

    rejectFirstShellStart?.(new Error('stale shell failed'));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('Workspace Two');
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('pending');
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('true');
    });

    resolveSecondShellStart?.({ sessionId: 'shell-session-ws2' });

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws2');
    });
  });

  it('stops the active shell session before removing its workspace', async () => {
    const user = userEvent.setup();
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });

    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace One/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ws1');
      expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByTestId('workspace-shell-drawer')).not.toBeInTheDocument();
  });

  it('cancels a pending shell start before removing its workspace', async () => {
    const user = userEvent.setup();
    let resolveShellStart: ((value: { sessionId: string }) => void) | null = null;
    mocks.api.workspaceShellStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveShellStart = resolve;
        })
    );

    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace One/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    await waitFor(() => {
      expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-1');
    });

    resolveShellStart?.({ sessionId: 'shell-session-ws1-late' });

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ws1-late');
    });
    expect(screen.queryByTestId('workspace-shell-drawer')).not.toBeInTheDocument();
  });

  it('ignores late thread SSH auth events after the workspace is removed', async () => {
    const user = userEvent.setup();
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace One/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-a' })
      );
    });

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    await waitFor(() => {
      expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-1');
    });
    const killCallCountAfterRemoval = mocks.api.terminalKill.mock.calls.length;

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-thread-a',
        workspaceId: 'ws-1',
        threadId: 'thread-a',
        reason: 'password-auth-unsupported'
      });
    });

    expect(mocks.api.terminalKill.mock.calls.length).toBe(killCallCountAfterRemoval);
    expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();
  });

  it('keeps the workspace shell session running during branch checkout', async () => {
    const user = userEvent.setup();
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });
    mocks.api.gitListBranches.mockResolvedValueOnce([
      { name: 'main', isCurrent: true, lastCommitUnix: 1700000000 },
      { name: 'feature/test', isCurrent: false, lastCommitUnix: 1690000000 }
    ]);

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/workspace-one' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledWith('/tmp/workspace-one', 'feature/test');
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mocks.api.terminalKill).not.toHaveBeenCalledWith('shell-session-ws1');
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
  });

  it('does not restart pending thread or shell sessions during branch checkout', async () => {
    const user = userEvent.setup();
    let currentBranch = 'main';
    const selectedThread = {
      id: 'thread-a',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
      title: 'Alpha thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      lastResumeAt: null,
      lastNewSessionAt: null
    };

    mocks.api.listThreads.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === 'ws-1') {
        return [selectedThread];
      }
      return [];
    });
    mocks.api.getGitInfo.mockImplementation(async () => ({
      branch: currentBranch,
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    }));
    mocks.api.gitListBranches.mockResolvedValueOnce([
      { name: 'main', isCurrent: true, lastCommitUnix: 1700000000 },
      { name: 'feature/test', isCurrent: false, lastCommitUnix: 1690000000 }
    ]);
    mocks.api.gitCheckoutBranch.mockImplementation(async (_workspacePath: string, branchName: string) => {
      currentBranch = branchName;
      return true;
    });
    mocks.api.terminalStartSession.mockImplementationOnce(async () => await new Promise(() => undefined));
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.gitCheckoutBranch).toHaveBeenNthCalledWith(1, '/tmp/workspace-one', 'feature/test');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledTimes(1);
    expect(mocks.api.clearThreadClaudeSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Failed to resume session\. Start fresh\?/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
    expect(screen.getByRole('button', { name: /^feature\/test$/i })).toBeInTheDocument();
  });

  it('opens the workspace shell in Terminal.app and closes the drawer', async () => {
    const user = userEvent.setup();
    mocks.api.workspaceShellStartSession.mockResolvedValueOnce({
      sessionId: 'shell-session-ws1'
    });

    render(<App />);

    await screen.findByRole('button', { name: /Alpha thread/i });
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('Workspace One');
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ws1');
    });

    await user.click(screen.getByRole('button', { name: 'open-external-shell' }));

    await waitFor(() => {
      expect(mocks.api.openInTerminal).toHaveBeenCalledWith('/tmp/workspace-one');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-shell-drawer')).not.toBeInTheDocument();
    });
  });

  it('clears SSH shell block state on close and allows reopening the shell', async () => {
    const user = userEvent.setup();
    mocks.api.workspaceShellStartSession
      .mockResolvedValueOnce({
        sessionId: 'shell-session-ssh-1'
      })
      .mockResolvedValueOnce({
        sessionId: 'shell-session-ssh-2'
      });

    render(<App />);

    await screen.findByRole('button', { name: /Gamma SSH thread/i });
    await user.click(screen.getByRole('button', { name: /Gamma SSH thread/i }));
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: 'ssh-workspace-shell' })
      );
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ssh-1');
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'shell-session-ssh-1',
        workspaceId: 'ws-ssh',
        reason: 'password-auth-unsupported'
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-ssh-1');
    });
    expect(screen.getByTestId('workspace-shell-blocked-message')).toHaveTextContent(
      'SSH setup blocked. ATController requires key-based auth via macOS Keychain or ssh-agent.'
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('workspace-shell-drawer')).toHaveTextContent('shell-session-ssh-2');
    });
    expect(screen.getByTestId('workspace-shell-blocked-message')).toBeEmptyDOMElement();
  });

  it('blocks a shell auth challenge that arrives before the shell start response resolves', async () => {
    const user = userEvent.setup();
    let resolveShellStart: ((value: any) => void) | null = null;
    mocks.api.workspaceShellStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveShellStart = resolve;
        })
    );

    render(<App />);

    await screen.findByRole('button', { name: /Gamma SSH thread/i });
    await user.click(screen.getByRole('button', { name: /Gamma SSH thread/i }));
    await user.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => {
      expect(mocks.api.workspaceShellStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: 'ssh-workspace-shell' })
      );
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'shell-session-prebind',
        workspaceId: 'ws-ssh',
        reason: 'password-auth-unsupported'
      });
    });

    expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();

    await act(async () => {
      resolveShellStart?.({
        sessionId: 'shell-session-prebind'
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('shell-session-prebind');
    });
    expect(screen.getByTestId('workspace-shell-blocked-message')).toHaveTextContent(
      'SSH setup blocked. ATController requires key-based auth via macOS Keychain or ssh-agent.'
    );
  });
});
