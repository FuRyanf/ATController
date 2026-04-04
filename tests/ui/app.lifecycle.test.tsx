import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => true)
}));

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

  const now = Date.now();
  let terminalDataHandler: ((
    event: {
      sessionId: string;
      threadId?: string;
      data: string;
      startPosition: number;
      endPosition: number;
      sequence?: number;
    }
  ) => void) | null = null;
  let terminalExitHandler: ((event: { sessionId: string; code?: number | null; signal?: string | null }) => void) | null =
    null;
  const terminalPositions = new Map<string, number>();
  const terminalSequencePositions = new Map<string, { startPosition: number; endPosition: number }>();
  const baseThreads = [
    {
      id: 'thread-1',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(now - 2_000).toISOString(),
      updatedAt: new Date(now - 2_000).toISOString(),
      title: 'Thread one',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    },
    {
      id: 'thread-2',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(now - 4_000).toISOString(),
      updatedAt: new Date(now - 4_000).toISOString(),
      title: 'Thread two',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    }
  ];

  let threadState = baseThreads.map((thread) => ({ ...thread }));
  let workspaceState = { ...workspace };

  const listWorkspacesImpl = async () => [workspaceState];
  const setWorkspaceGitPullOnMasterForNewThreadsImpl = async (_workspaceId: string, enabled: boolean) => {
    workspaceState = {
      ...workspaceState,
      gitPullOnMasterForNewThreads: enabled,
      updatedAt: new Date().toISOString()
    };
    return workspaceState;
  };
  const listThreadsImpl = async () => threadState;
  const createThreadImpl = async () => {
    const next = {
      ...threadState[0],
      id: `thread-${threadState.length + 1}`,
      title: 'New thread',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    threadState = [next, ...threadState];
    return next;
  };
  const renameThreadImpl = async (_workspaceId: string, threadId: string, title: string) => {
    const updated = {
      ...threadState.find((thread) => thread.id === threadId)!,
      title,
      updatedAt: new Date().toISOString()
    };
    threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
    return updated;
  };
  const archiveThreadImpl = async (_workspaceId: string, threadId: string) => {
    const updated = {
      ...threadState.find((thread) => thread.id === threadId)!,
      isArchived: true,
      updatedAt: new Date().toISOString()
    };
    threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
    return updated;
  };
  const deleteThreadImpl = async (_workspaceId: string, threadId: string) => {
    threadState = threadState.filter((thread) => thread.id !== threadId);
    return true;
  };
  const setThreadFullAccessImpl = async (_workspaceId: string, threadId: string, fullAccess: boolean) => {
    const updated = {
      ...threadState.find((thread) => thread.id === threadId)!,
      fullAccess,
      updatedAt: new Date().toISOString()
    };
    threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
    return updated;
  };
  const clearThreadClaudeSessionImpl = async (_workspaceId: string, threadId: string) => {
    const updated = {
      ...threadState.find((thread) => thread.id === threadId)!,
      claudeSessionId: null,
      updatedAt: new Date().toISOString()
    };
    threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
    return updated;
  };
  const terminalStartSessionImpl = async (params: { threadId: string }) => ({
    sessionId: `session-${params.threadId}`,
    sessionMode: 'new' as const,
    resumeSessionId: null,
    thread: threadState.find((thread) => thread.id === params.threadId) ?? threadState[0]
  });
  const terminalReadOutputImpl = async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false });
  const gitPullMasterForNewThreadImpl = async () => ({
    outcome: 'pulled' as const,
    message: 'Checked out master and pulled latest changes.'
  });

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/Claudex'),
    listWorkspaces: vi.fn(listWorkspacesImpl),
    addWorkspace: vi.fn(async () => workspaceState),
    addSshWorkspace: vi.fn(async () => workspaceState),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(setWorkspaceGitPullOnMasterForNewThreadsImpl),
    getGitInfo: vi.fn(async () => ({
      branch: 'main',
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    })),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
    gitListBranches: vi.fn(async () => [
      { name: 'main', isCurrent: true, lastCommitUnix: 1700000000 },
      { name: 'feature/test', isCurrent: false, lastCommitUnix: 1690000000 }
    ]),
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: false,
      uncommittedFiles: 0,
      insertions: 0,
      deletions: 0
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitCreateAndCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(gitPullMasterForNewThreadImpl),
    listThreads: vi.fn(listThreadsImpl),
    createThread: vi.fn(createThreadImpl),
    renameThread: vi.fn(renameThreadImpl),
    archiveThread: vi.fn(archiveThreadImpl),
    deleteThread: vi.fn(deleteThreadImpl),
    setThreadFullAccess: vi.fn(setThreadFullAccessImpl),
    clearThreadClaudeSession: vi.fn(clearThreadClaudeSessionImpl),
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
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(terminalReadOutputImpl),
    runClaude: vi.fn(async () => ({ runId: 'run-1' })),
    cancelRun: vi.fn(async () => true),
    generateCommitMessage: vi.fn(async () => 'chore: update'),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    threadState = baseThreads.map((thread) => ({ ...thread }));
    workspaceState = { ...workspace };
    window.localStorage.clear();
    api.listWorkspaces.mockReset();
    api.listWorkspaces.mockImplementation(listWorkspacesImpl);
    api.setWorkspaceGitPullOnMasterForNewThreads.mockReset();
    api.setWorkspaceGitPullOnMasterForNewThreads.mockImplementation(setWorkspaceGitPullOnMasterForNewThreadsImpl);
    api.gitPullMasterForNewThread.mockReset();
    api.gitPullMasterForNewThread.mockImplementation(gitPullMasterForNewThreadImpl);
    api.listThreads.mockReset();
    api.listThreads.mockImplementation(listThreadsImpl);
    api.createThread.mockReset();
    api.createThread.mockImplementation(createThreadImpl);
    api.renameThread.mockReset();
    api.renameThread.mockImplementation(renameThreadImpl);
    api.archiveThread.mockReset();
    api.archiveThread.mockImplementation(archiveThreadImpl);
    api.deleteThread.mockReset();
    api.deleteThread.mockImplementation(deleteThreadImpl);
    api.setThreadFullAccess.mockReset();
    api.setThreadFullAccess.mockImplementation(setThreadFullAccessImpl);
    api.clearThreadClaudeSession.mockReset();
    api.clearThreadClaudeSession.mockImplementation(clearThreadClaudeSessionImpl);
    api.terminalStartSession.mockReset();
    api.terminalStartSession.mockImplementation(terminalStartSessionImpl);
    api.terminalReadOutput.mockReset();
    api.terminalReadOutput.mockImplementation(terminalReadOutputImpl);
    terminalDataHandler = null;
    terminalExitHandler = null;
    terminalPositions.clear();
    terminalSequencePositions.clear();
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
    emitTerminalData: (event: { sessionId: string; threadId?: string; data: string; sequence?: number }) => {
      const sequenceKey =
        typeof event.sequence === 'number' ? `${event.sessionId}:${event.sequence}` : null;
      const sequenceRange = sequenceKey ? terminalSequencePositions.get(sequenceKey) : null;
      const startPosition = sequenceRange?.startPosition ?? (terminalPositions.get(event.sessionId) ?? 0);
      const endPosition = sequenceRange?.endPosition ?? (startPosition + event.data.length);
      if (sequenceKey && !sequenceRange) {
        terminalSequencePositions.set(sequenceKey, { startPosition, endPosition });
      }
      if (!sequenceRange) {
        terminalPositions.set(event.sessionId, endPosition);
      }
      terminalDataHandler?.({
        ...event,
        startPosition,
        endPosition
      });
    },
    onTerminalData: vi.fn(
      async (handler: (event: {
        sessionId: string;
        threadId?: string;
        data: string;
        startPosition: number;
        endPosition: number;
        sequence?: number;
      }) => void) => {
        terminalDataHandler = handler;
        return () => {
          if (terminalDataHandler === handler) {
            terminalDataHandler = null;
          }
        };
      }
    ),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
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

vi.mock('@tauri-apps/api/core', () => coreMocks);

import App from '../../src/App';

describe('Thread lifecycle integration', () => {
  beforeEach(() => {
    mocks.reset();
    coreMocks.invoke.mockClear();
    coreMocks.invoke.mockResolvedValue(true);
  });

  it('auto-starts the selected thread session when opening an existing workspace', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    expect(mocks.api.createThread).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('sends the alerts-enabled confirmation when settings load with task completion alerts on', async () => {
    mocks.api.getSettings.mockResolvedValueOnce({
      claudeCliPath: '/usr/local/bin/claude',
      taskCompletionAlerts: true
    });

    render(<App />);

    await waitFor(() => {
      expect(coreMocks.invoke).toHaveBeenCalledWith('send_desktop_notification', {
        title: 'Claudex alerts enabled',
        body: 'You will now get a notification when Claude finishes a task.'
      });
    });
  });

  it('shows an update button only when a newer release is available', async () => {
    const user = userEvent.setup();
    mocks.api.checkForUpdate.mockResolvedValueOnce({
      currentVersion: '0.1.12',
      latestVersion: '0.1.14',
      updateAvailable: true,
      releaseUrl: 'https://github.com/FuRyanf/Claudex/releases/tag/v0.1.14'
    });

    render(<App />);

    const updateButton = await screen.findByRole('button', { name: 'Update' });
    expect(updateButton).toBeInTheDocument();

    await user.click(updateButton);

    await waitFor(() => {
      expect(mocks.api.installLatestUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it('starts ssh workspace sessions with null initial cwd', async () => {
    const remoteWorkspace = {
      id: 'ws-ssh',
      name: 'remote-host',
      path: 'ssh-workspace-1',
      kind: 'ssh' as const,
      sshCommand: 'ssh dev@remote-host',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const remoteThread = {
      id: 'thread-ssh',
      workspaceId: 'ws-ssh',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'SSH thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    };

    mocks.api.listWorkspaces.mockResolvedValueOnce([remoteWorkspace]);
    mocks.api.listThreads.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-ssh' ? [remoteThread] : []
    );

    render(<App />);

    await screen.findByRole('button', { name: /SSH thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: 'ssh-workspace-1',
          initialCwd: null,
          threadId: 'thread-ssh'
        })
      );
    });
  });

  it('still auto-starts after delayed thread metadata hydration', async () => {
    const originalListThreads = mocks.api.listThreads.getMockImplementation();
    mocks.api.listThreads.mockImplementation(async (workspaceId: string) => {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 30);
      });
      if (originalListThreads) {
        return originalListThreads(workspaceId);
      }
      return [];
    });

    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('waits for terminal data subscription before starting a thread session', async () => {
    let releaseSubscription: (() => void) | null = null;
    mocks.onTerminalData.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseSubscription = resolve;
      });
      return () => undefined;
    });

    render(<App />);

    await screen.findByRole('button', { name: /Thread one/i });
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 120);
    });
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalled();

    act(() => {
      releaseSubscription?.();
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
  });

  it('auto-recovers the selected ssh thread session after focus when the previous session is gone', async () => {
    const remoteWorkspace = {
      id: 'ws-ssh-recover',
      name: 'remote-host',
      path: 'ssh-workspace-recover',
      kind: 'ssh' as const,
      sshCommand: 'ssh dev@remote-host',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const remoteThread = {
      id: 'thread-ssh-recover',
      workspaceId: 'ws-ssh-recover',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Remote recover thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    mocks.api.listWorkspaces.mockResolvedValueOnce([remoteWorkspace]);
    mocks.api.listThreads.mockImplementation(async (workspaceId: string) =>
      workspaceId === remoteWorkspace.id ? [remoteThread] : []
    );
    mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => ({
      sessionId: `session-${params.threadId}`,
      sessionMode: 'new',
      resumeSessionId: null,
      thread: {
        ...remoteThread,
        id: params.threadId
      }
    }));

    let disconnected = false;
    mocks.api.terminalReadOutput.mockImplementation(async (sessionId: string) => {
      if (disconnected && sessionId === 'session-thread-ssh-recover') {
        throw new Error('Terminal session not found');
      }
      return { text: '', startPosition: 0, endPosition: 0, truncated: false };
    });

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-ssh-recover' })
      );
    });
    const startCallsBefore = mocks.api.terminalStartSession.mock.calls.length;

    disconnected = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession.mock.calls.length).toBeGreaterThan(startCallsBefore);
    });
    expect(mocks.api.terminalStartSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: 'thread-ssh-recover' })
    );
  });

  it('does not auto-recover local workspace sessions on focus', async () => {
    let disconnected = false;
    mocks.api.terminalReadOutput.mockImplementation(async (sessionId: string) => {
      if (disconnected && sessionId === 'session-thread-1') {
        throw new Error('Terminal session not found');
      }
      return { text: '', startPosition: 0, endPosition: 0, truncated: false };
    });

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });
    const startCallsBefore = mocks.api.terminalStartSession.mock.calls.length;

    disconnected = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 180);
    });
    expect(mocks.api.terminalStartSession.mock.calls.length).toBe(startCallsBefore);
  });

  it('stops retrying selected remote sessions after three failed exits', async () => {
    const remoteWorkspace = {
      id: 'ws-ssh-loop',
      name: 'remote-host',
      path: 'ssh-workspace-loop',
      kind: 'ssh' as const,
      sshCommand: 'ssh dev@remote-host',
      gitPullOnMasterForNewThreads: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const remoteThread = {
      id: 'thread-ssh-loop',
      workspaceId: remoteWorkspace.id,
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Looping remote thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    };

    mocks.api.listWorkspaces.mockResolvedValueOnce([remoteWorkspace]);
    mocks.api.listThreads.mockImplementation(async (workspaceId: string) =>
      workspaceId === remoteWorkspace.id ? [remoteThread] : []
    );

    let startAttempt = 0;
    mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => {
      startAttempt += 1;
      return {
        sessionId: `session-fail-${startAttempt}`,
        sessionMode: 'new' as const,
        resumeSessionId: null,
        thread: {
          ...remoteThread,
          id: params.threadId
        }
      };
    });

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-fail-1', code: 1, signal: null });
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-fail-2', code: 1, signal: null });
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(3);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-fail-3', code: 1, signal: null });
    });
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 180);
    });
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(3);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 180);
    });
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(3);
  });

  it('keeps the previous thread session running and starts the next one when switching threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /Thread two/i }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-2' })
      );
    });
    expect(mocks.api.terminalSendSignal).not.toHaveBeenCalledWith('session-thread-1', 'SIGINT');
    expect(mocks.api.terminalKill).not.toHaveBeenCalledWith('session-thread-1');
  });

  it('switches branches without prompting or tearing down the active session', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledWith('/tmp/workspace', 'feature/test');
    });
    expect(mocks.api.terminalKill).not.toHaveBeenCalledWith('session-thread-1');
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('switches branches without restarting selected thread sessions', async () => {
    const user = userEvent.setup();
    let currentBranch = 'main';
    const threadOne = {
      id: 'thread-1',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Thread one',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      lastResumeAt: null,
      lastNewSessionAt: null
    };

    mocks.api.listThreads.mockImplementation(async () => [threadOne]);
    mocks.api.getGitInfo.mockImplementation(async () => ({
      branch: currentBranch,
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    }));
    mocks.api.gitCheckoutBranch.mockImplementation(async (_workspacePath: string, branchName: string) => {
      currentBranch = branchName;
      return true;
    });
    mocks.api.terminalStartSession.mockResolvedValueOnce({
      sessionId: 'session-thread-1',
      sessionMode: 'resumed' as const,
      resumeSessionId: threadOne.claudeSessionId,
      thread: threadOne
    });

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.gitCheckoutBranch).toHaveBeenNthCalledWith(1, '/tmp/workspace', 'feature/test');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mocks.api.clearThreadClaudeSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Failed to resume session\. Start fresh\?/i)).not.toBeInTheDocument();
    expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^feature\/test$/i })).toBeInTheDocument();
  });

  it('suppresses local resume-failure modal without clearing the session id during branch switch', async () => {
    const user = userEvent.setup();
    let currentBranch = 'main';
    const threadOne = {
      id: 'thread-1',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Thread one',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      lastResumeAt: null,
      lastNewSessionAt: null
    };

    mocks.api.listThreads.mockImplementation(async () => [threadOne]);
    mocks.api.getGitInfo.mockImplementation(async () => ({
      branch: currentBranch,
      shortHash: 'abc123',
      isDirty: false,
      ahead: 0,
      behind: 0
    }));
    mocks.api.gitCheckoutBranch.mockImplementation(async (_workspacePath: string, branchName: string) => {
      currentBranch = branchName;
      return true;
    });
    mocks.api.terminalStartSession
      .mockResolvedValueOnce({
        sessionId: 'session-thread-1',
        sessionMode: 'resumed' as const,
        resumeSessionId: threadOne.claudeSessionId,
        thread: threadOne
      })
      .mockResolvedValueOnce({
        sessionId: 'session-thread-1-r2',
        sessionMode: 'resumed' as const,
        resumeSessionId: threadOne.claudeSessionId,
        thread: threadOne
      })
      .mockResolvedValueOnce({
        sessionId: 'session-thread-1-r3',
        sessionMode: 'resumed' as const,
        resumeSessionId: threadOne.claudeSessionId,
        thread: threadOne
      })
      .mockResolvedValueOnce({
        sessionId: 'session-thread-1-r4',
        sessionMode: 'resumed' as const,
        resumeSessionId: threadOne.claudeSessionId,
        thread: threadOne
      });

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.click(await screen.findByRole('button', { name: /^main$/i }));
    await screen.findByRole('dialog', { name: 'Branch switcher' });
    await user.click(await screen.findByRole('button', { name: 'feature/test' }));

    await waitFor(() => {
      expect(mocks.api.gitCheckoutBranch).toHaveBeenNthCalledWith(1, '/tmp/workspace', 'feature/test');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-thread-1', code: 1 });
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-thread-1-r2', code: 1 });
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(3);
    });

    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-thread-1-r3', code: 1 });
    });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(4);
    });

    expect(mocks.api.clearThreadClaudeSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Failed to resume session\. Start fresh\?/i)).not.toBeInTheDocument();
    expect(mocks.api.gitCheckoutBranch).toHaveBeenCalledTimes(1);
  });

  it('shows exactly one thread creation entry point under expanded workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Workspace/i });
    expect(screen.getByTestId('workspace-new-thread-ws-1')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-compose-ws-1')).not.toBeInTheDocument();

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    const menu = (await screen.findByRole('button', { name: 'Open folder' })).closest('.thread-context-menu');
    expect(menu).not.toBeNull();
    expect(within(menu as HTMLElement).queryByRole('button', { name: /^New thread$/i })).not.toBeInTheDocument();
  });

  it('creates a new thread from the in-list new thread row and selects it', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Workspace/i });
    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-3' })
      );
    });
  });

  it('suppresses duplicate new-thread creation while the first request is still pending', async () => {
    const user = userEvent.setup();
    let resolveCreateThread: ((value: Awaited<ReturnType<typeof mocks.api.createThread>>) => void) | null = null;
    mocks.api.createThread.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveCreateThread = resolve;
        })
    );

    render(<App />);

    await screen.findByRole('button', { name: /Workspace/i });
    const newThreadButton = screen.getByTestId('workspace-new-thread-ws-1');

    await user.click(newThreadButton);
    await user.click(newThreadButton);

    expect(mocks.api.createThread).toHaveBeenCalledTimes(1);
    expect(newThreadButton).toBeDisabled();

    resolveCreateThread?.({
      id: 'thread-3',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'New thread',
      isArchived: false,
      lastRunStatus: 'Idle',
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-3' })
      );
    });
  });

  it('runs git pull pre-step before creating a thread when project setting is enabled', async () => {
    const user = userEvent.setup();
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));

    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    const indicator = screen.getByText('master pull enabled');
    expect(indicator).toHaveAttribute(
      'title',
      'Upon new threads, master is checked out and pulled automatically.'
    );

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });

    const pullInvocation = (mocks.api.gitPullMasterForNewThread as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const createInvocation = (mocks.api.createThread as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    expect(pullInvocation).toBeLessThan(createInvocation);
  });

  it('shows the pulled commit id in a popup toast after successful pre-step', async () => {
    const user = userEvent.setup();
    mocks.api.gitPullMasterForNewThread.mockResolvedValueOnce({
      outcome: 'pulled',
      message: 'Checked out master and pulled latest changes to commit 4befdb3.'
    });
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));
    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    expect(await screen.findByText('Checked out master and pulled latest changes to commit 4befdb3.')).toBeInTheDocument();
  });

  it('uses the toggled pull setting immediately when creating a thread before setting persistence resolves', async () => {
    const user = userEvent.setup();

    let resolveSettingUpdate: (() => void) | null = null;
    mocks.api.setWorkspaceGitPullOnMasterForNewThreads.mockImplementationOnce(
      async (_workspaceId: string, enabled: boolean) =>
        await new Promise((resolve) => {
          resolveSettingUpdate = () =>
            resolve({
              id: 'ws-1',
              name: 'Workspace',
              path: '/tmp/workspace',
              gitPullOnMasterForNewThreads: enabled,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
        })
    );

    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
    });

    resolveSettingUpdate?.();

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });
  });

  it('skips git pull when dirty and still creates thread with non-blocking error toast', async () => {
    const user = userEvent.setup();
    mocks.api.gitPullMasterForNewThread.mockResolvedValueOnce({
      outcome: 'skipped',
      message: 'Skipped git pull: working tree is dirty. Commit or stash changes first.'
    });
    render(<App />);

    const workspaceRow = await screen.findByRole('button', { name: /Workspace/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Enable git pull on master for new threads' }));
    await waitFor(() => {
      expect(mocks.api.setWorkspaceGitPullOnMasterForNewThreads).toHaveBeenCalledWith('ws-1', true);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.gitPullMasterForNewThread).toHaveBeenCalledWith('/tmp/workspace');
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
    });
    expect(await screen.findByText('Skipped git pull: working tree is dirty. Commit or stash changes first.')).toBeInTheDocument();
  });

  it('renames a thread through inline edit and persists the title', async () => {
    const user = userEvent.setup();
    render(<App />);

    const title = await screen.findByRole('button', { name: 'Thread one' });
    await user.dblClick(title);

    const input = await screen.findByDisplayValue('Thread one');
    await user.clear(input);
    await user.type(input, 'Renamed inline{enter}');

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-1', 'Renamed inline');
    });
    expect(await screen.findByRole('button', { name: /^Renamed inline$/ })).toBeInTheDocument();
  });

  it('keeps inline rename active for navigation/modifier keys and only exits on Enter/Escape/blur', async () => {
    const user = userEvent.setup();
    render(<App />);

    const title = await screen.findByRole('button', { name: 'Thread one' });
    await user.dblClick(title);

    let input = await screen.findByDisplayValue('Thread one');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    fireEvent.keyDown(input, { key: 'Meta' });
    fireEvent.keyDown(input, { key: 'Control' });
    fireEvent.keyDown(input, { key: 'Alt' });
    fireEvent.keyDown(input, { key: 'Shift' });
    await user.type(input, ' ');

    expect(input).toHaveValue('Thread one ');
    expect(input).toHaveFocus();
    expect(mocks.api.renameThread).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('Thread one')).not.toBeInTheDocument();
    });
    expect(mocks.api.renameThread).not.toHaveBeenCalled();

    await user.dblClick(await screen.findByRole('button', { name: 'Thread one' }));
    input = await screen.findByDisplayValue('Thread one');
    await user.clear(input);
    await user.type(input, 'Renamed by blur');
    fireEvent.blur(input);
    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-1', 'Renamed by blur');
    });

    await user.dblClick(await screen.findByRole('button', { name: 'Renamed by blur' }));
    input = await screen.findByDisplayValue('Renamed by blur');
    await user.clear(input);
    await user.type(input, 'Renamed by enter');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-1', 'Renamed by enter');
    });
  });

  it('deletes a thread and keeps remaining threads interactive', async () => {
    const user = userEvent.setup();
    render(<App />);

    const firstRow = await screen.findByRole('button', { name: /Thread one/i });
    await user.pointer([{ target: firstRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.api.deleteThread).toHaveBeenCalledWith('ws-1', 'thread-1');
      expect(screen.queryByRole('button', { name: /Thread one/i })).not.toBeInTheDocument();
    });

    await user.click(await screen.findByRole('button', { name: /Thread two/i }));
    expect(screen.getByRole('button', { name: /Thread two/i })).toBeInTheDocument();
  });
});
