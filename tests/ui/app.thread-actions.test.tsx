import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-1',
    agentId: 'claude-code',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Rename me',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: '123e4567-e89b-12d3-a456-426614174000',
    forkedFromClaudeSessionId: null,
    pendingForkSourceClaudeSessionId: null,
    pendingForkKnownChildSessionIds: [] as string[],
    pendingForkRequestedAt: null,
    pendingForkLaunchConsumed: false,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/Claudex'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
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
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    createForkedThread: vi.fn(async (_workspaceId: string, sourceThreadId: string) => {
      const source = threadState.find((thread) => thread.id === sourceThreadId) ?? threadState[0];
      const forked = {
        ...source,
        id: `thread-${threadState.length + 1}`,
        title: `${source.title} (Fork)`,
        claudeSessionId: null,
        forkedFromClaudeSessionId: source.claudeSessionId,
        pendingForkSourceClaudeSessionId: source.claudeSessionId,
        pendingForkKnownChildSessionIds: [],
        pendingForkRequestedAt: new Date().toISOString(),
        pendingForkLaunchConsumed: false,
        lastResumeAt: null,
        lastNewSessionAt: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      threadState = [forked, ...threadState];
      return forked;
    }),
    forkThreadFromUi: vi.fn(async (_workspaceId: string, sourceThreadId: string, sourceTitle: string, forkedTitle: string) => {
      const source = threadState.find((thread) => thread.id === sourceThreadId) ?? threadState[0];
      const updatedSource = {
        ...source,
        title: sourceTitle,
        updatedAt: new Date().toISOString()
      };
      const forked = {
        ...source,
        id: `thread-${threadState.length + 1}`,
        title: forkedTitle,
        claudeSessionId: null,
        forkedFromClaudeSessionId: source.claudeSessionId,
        pendingForkSourceClaudeSessionId: source.claudeSessionId,
        pendingForkKnownChildSessionIds: [],
        pendingForkRequestedAt: new Date().toISOString(),
        pendingForkLaunchConsumed: false,
        lastResumeAt: null,
        lastNewSessionAt: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      threadState = [forked, updatedSource, ...threadState.filter((thread) => thread.id !== sourceThreadId)];
      return {
        sourceThread: updatedSource,
        forkedThread: forked
      };
    }),
    renameThread: vi.fn(async (_workspaceId: string, threadId: string, title: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        title,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    archiveThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        isArchived: true,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    deleteThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      threadState = threadState.filter((thread) => thread.id !== threadId);
      return true;
    }),
    setThreadFullAccess: vi.fn(async (_workspaceId: string, threadId: string, fullAccess: boolean) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        fullAccess,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    clearThreadClaudeSession: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        claudeSessionId: null,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    clearThreadPendingFork: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        pendingForkSourceClaudeSessionId: null,
        pendingForkKnownChildSessionIds: [] as string[],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    commitPreparedThreadPendingFork: vi.fn(
      async (_workspaceId: string, threadId: string, prepared: { sourceClaudeSessionId: string; knownChildSessionIds: string[]; requestedAt: string }) => {
        const updated = {
          ...threadState.find((thread) => thread.id === threadId)!,
          pendingForkSourceClaudeSessionId: prepared.sourceClaudeSessionId,
          pendingForkKnownChildSessionIds: prepared.knownChildSessionIds,
          pendingForkRequestedAt: prepared.requestedAt,
          pendingForkLaunchConsumed: true,
          updatedAt: new Date().toISOString()
        };
        threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
        return updated;
      }
    ),
    markThreadPendingForkConsumed: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        pendingForkLaunchConsumed: true,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    prepareThreadNativeFork: vi.fn(async () => ({
      sourceClaudeSessionId: '123e4567-e89b-12d3-a456-426614174000',
      knownChildSessionIds: [],
      requestedAt: new Date().toISOString()
    })),
    resolveThreadForkCandidate: vi.fn(async () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    finalizeThreadNativeFork: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadClaudeSessionId: vi.fn(async (_workspaceId: string, threadId: string, claudeSessionId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        claudeSessionId,
        pendingForkSourceClaudeSessionId: null,
        pendingForkKnownChildSessionIds: [],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
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
    terminalStartSession: vi.fn(async (params: { threadId: string }) => {
      const thread = threadState.find((item) => item.id === params.threadId) ?? threadState[0] ?? { ...baseThread };
      const responseThread =
        thread.pendingForkSourceClaudeSessionId
          ? {
              ...thread,
              pendingForkLaunchConsumed: true
            }
          : thread;
      threadState = threadState.map((item) => (item.id === responseThread.id ? responseThread : item));
      return {
        sessionId: `session-${params.threadId}`,
        sessionMode: thread.pendingForkSourceClaudeSessionId ? 'forked' : thread.claudeSessionId ? 'resumed' : 'new',
        resumeSessionId: thread.pendingForkSourceClaudeSessionId ? null : thread.claudeSessionId,
        thread: responseThread
      };
    }),
    terminalWrite: vi.fn(async () => true),
    terminalRebindClaudeSession: vi.fn(async () => true),
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
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
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
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
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

import App from '../../src/App';

describe('Thread actions', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('supports rename from context menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);

    const menu = (await screen.findByRole('button', { name: 'Rename' })).closest('.thread-context-menu');
    expect(menu).not.toBeNull();
    expect(screen.getByTestId('sidebar')).not.toContainElement(menu);

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const renameInput = await screen.findByDisplayValue('Rename me');
    await user.clear(renameInput);
    await user.type(renameInput, 'Renamed thread{enter}');

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-1', 'Renamed thread');
    });
  });

  it('does not show a fork action in the thread context menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);

    expect(screen.queryByRole('button', { name: 'Fork thread' })).toBeNull();
  });

  it('supports delete from context menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.api.deleteThread).toHaveBeenCalledWith('ws-1', 'thread-1');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Rename me/i })).not.toBeInTheDocument();
    });
  });

  it('closes context menu immediately even if backend delete is slow', async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | null = null;
    mocks.api.deleteThread.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDelete = () => resolve(true);
        })
    );

    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    });

    resolveDelete?.();
  });

  it('does not resurrect a deleted thread when a stale terminal start resolves', async () => {
    const user = userEvent.setup();
    let resolveStart: ((value: {
      sessionId: string;
      sessionMode: 'new';
      resumeSessionId: null;
      thread: typeof mocks.api.listThreads extends (...args: unknown[]) => Promise<infer T> ? T[number] : never;
    }) => void) | null = null;

    mocks.api.terminalStartSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve as typeof resolveStart;
        })
    );

    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-1' })
      );
    });

    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.api.deleteThread).toHaveBeenCalledWith('ws-1', 'thread-1');
    });

    resolveStart?.({
      sessionId: 'session-stale',
      sessionMode: 'new',
      resumeSessionId: null,
      thread: {
        id: 'thread-1',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'Rename me',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    });

    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-stale');
    });
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
  });
});
