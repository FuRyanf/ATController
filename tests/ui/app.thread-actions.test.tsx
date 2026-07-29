import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    path: '/tmp/workspace',
    kind: 'local' as const,
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
    title: 'Rename me',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    codexSessionId: '123e4567-e89b-12d3-a456-426614174000',
    forkedFromCodexSessionId: null,
    pendingForkSourceCodexSessionId: null,
    pendingForkKnownChildSessionIds: [] as string[],
    pendingForkRequestedAt: null,
    pendingForkLaunchConsumed: false,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
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
    gitListBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, lastCommitUnix: 1700000000 }]),
    gitWorkspaceStatus: vi.fn(async () => ({
      isDirty: false,
      uncommittedFiles: 0,
      insertions: 0,
      deletions: 0
    })),
    gitCheckoutBranch: vi.fn(async () => true),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => threadState),
    createThread: vi.fn(async () => {
      throw new Error('not needed');
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
    clearThreadCodexSession: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        codexSessionId: null,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    clearThreadPendingFork: vi.fn(async (_workspaceId: string, threadId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        pendingForkSourceCodexSessionId: null,
        pendingForkKnownChildSessionIds: [] as string[],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    commitPreparedThreadPendingFork: vi.fn(
      async (_workspaceId: string, threadId: string, prepared: { sourceCodexSessionId: string; knownChildSessionIds: string[]; requestedAt: string }) => {
        const updated = {
          ...threadState.find((thread) => thread.id === threadId)!,
          pendingForkSourceCodexSessionId: prepared.sourceCodexSessionId,
          pendingForkKnownChildSessionIds: prepared.knownChildSessionIds,
          pendingForkRequestedAt: prepared.requestedAt,
          pendingForkLaunchConsumed: true,
          updatedAt: new Date().toISOString()
        };
        threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
        return updated;
      }
    ),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    prepareThreadNativeFork: vi.fn(async () => ({
      sourceCodexSessionId: '123e4567-e89b-12d3-a456-426614174000',
      knownChildSessionIds: [],
      requestedAt: new Date().toISOString()
    })),
    resolveThreadForkCandidate: vi.fn(async () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    setThreadCodexSessionId: vi.fn(async (_workspaceId: string, threadId: string, codexSessionId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        codexSessionId,
        pendingForkSourceCodexSessionId: null,
        pendingForkKnownChildSessionIds: [],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    listSkills: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ codexCliPath: '/usr/local/bin/codex' })),
    saveSettings: vi.fn(async (settings: { codexCliPath: string | null }) => settings),
    detectCodexCliPath: vi.fn(async () => '/usr/local/bin/codex'),
    latestCodexSessionCwd: vi.fn(async () => null),
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
        thread.pendingForkSourceCodexSessionId
          ? {
              ...thread,
              pendingForkLaunchConsumed: true
            }
          : thread;
      threadState = threadState.map((item) => (item.id === responseThread.id ? responseThread : item));
      return {
        sessionId: `session-${params.threadId}`,
        sessionMode: thread.pendingForkSourceCodexSessionId ? 'forked' : thread.codexSessionId ? 'resumed' : 'new',
        resumeSessionId: thread.pendingForkSourceCodexSessionId ? null : thread.codexSessionId,
        thread: responseThread
      };
    }),
    terminalWrite: vi.fn(async () => true),
    terminalRebindCodexSession: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    openInFinder: vi.fn(async () => undefined),
    openInTerminal: vi.fn(async () => undefined),
    openTerminalCommand: vi.fn(async () => undefined),
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
    api.latestCodexSessionCwd.mockReset();
    api.latestCodexSessionCwd.mockImplementation(async () => null);
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

  it('copies normal resume commands with workspace sandbox and on-request approvals', async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Copy resume command' }));

    await waitFor(() => {
      expect(mocks.api.writeTextToClipboard).toHaveBeenCalledWith(
        "codex resume '123e4567-e89b-12d3-a456-426614174000' --sandbox workspace-write --ask-for-approval on-request"
      );
    });
    expect(mocks.api.writeTextToClipboard).not.toHaveBeenCalledWith(
      expect.stringContaining('--dangerously-bypass-approvals-and-sandbox')
    );
  });

  it('opens normal resume commands in Terminal from the workspace folder', async () => {
    const user = userEvent.setup();
    mocks.api.latestCodexSessionCwd.mockResolvedValue('/tmp/workspace/subdir');
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Open in Terminal' }));

    await waitFor(() => {
      expect(mocks.api.openTerminalCommand).toHaveBeenCalledWith(
        "cd '/tmp/workspace/subdir' && codex resume '123e4567-e89b-12d3-a456-426614174000' --sandbox workspace-write --ask-for-approval on-request"
      );
    });
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

  it('keeps a thread when its ATController deletion warning is canceled', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(false);
    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.stringContaining('The source Codex session history remains in Codex.'),
      expect.objectContaining({
        title: 'ATController',
        kind: 'warning',
        okLabel: 'Delete'
      })
    );
    expect(mocks.api.deleteThread).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Rename me/i })).toBeInTheDocument();
  });

  it('does not resurrect a deleted thread while the follow-up refresh is still pending', async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: unknown) => void) | null = null;

    render(<App />);

    const row = await screen.findByRole('button', { name: /Rename me/i });
    mocks.api.listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    await user.pointer([{ target: row, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.api.deleteThread).toHaveBeenCalledWith('ws-1', 'thread-1');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Rename me/i })).not.toBeInTheDocument();
    });

    await act(async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 100);
      });
    });

    expect(screen.queryByRole('button', { name: /Rename me/i })).not.toBeInTheDocument();

    resolveRefresh?.([]);
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
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'Rename me',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        codexSessionId: null,
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
