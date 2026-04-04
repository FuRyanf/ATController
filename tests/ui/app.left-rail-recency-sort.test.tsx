import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const THREAD_ATTENTION_STATE_V2_KEY = 'claudex:thread-attention-v2';

function seedThreadAttentionState(stateByThread: Record<string, unknown>) {
  window.localStorage.setItem(THREAD_ATTENTION_STATE_V2_KEY, JSON.stringify(stateByThread));
}

const mocks = vi.hoisted(() => {
  const baseNow = Date.parse('2026-02-22T10:00:00.000Z');
  const workspace = {
    id: 'ws-1',
    name: 'Workspace',
    kind: 'local' as const,
    path: '/tmp/workspace',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date(baseNow - 10_000).toISOString(),
    updatedAt: new Date(baseNow - 10_000).toISOString()
  };

  const baseThreads = [
    {
      id: 'thread-older',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(baseNow - 7_200_000).toISOString(),
      updatedAt: new Date(baseNow - 7_200_000).toISOString(),
      title: 'Older thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      claudeSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    },
    {
      id: 'thread-newer',
      workspaceId: 'ws-1',
      agentId: 'claude-code',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date(baseNow - 3_600_000).toISOString(),
      updatedAt: new Date(baseNow - 3_600_000).toISOString(),
      title: 'Newer thread',
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
  let terminalDataHandler: ((event: { sessionId: string; data: string; startPosition: number; endPosition: number }) => void) | null = null;
  let terminalTurnCompletedHandler: ((event: {
    sessionId: string;
    threadId?: string | null;
    status?: 'Succeeded' | 'Failed';
    hasMeaningfulOutput?: boolean;
    completedAtMs?: number | null;
  }) => void) | null = null;
  let terminalExitHandler: ((event: { sessionId: string; code: number | null; signal: number | null }) => void) | null = null;
  const terminalPositions = new Map<string, number>();

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
    renameThread: vi.fn(async (_workspaceId: string, threadId: string, title: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        title,
        updatedAt: new Date().toISOString()
      };
      threadState = threadState.map((thread) => (thread.id === threadId ? updated : thread));
      return updated;
    }),
    archiveThread: vi.fn(async () => true),
    deleteThread: vi.fn(async (_workspaceId: string, threadId: string) => {
      threadState = threadState.filter((thread) => thread.id !== threadId);
      return true;
    }),
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
    terminalStartSession: vi.fn(async (params: { threadId: string }) => ({
      sessionId: `session-${params.threadId}`,
      sessionMode: 'new',
      resumeSessionId: null,
      thread: threadState.find((thread) => thread.id === params.threadId) ?? threadState[0]
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
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const helperMocks = {
    sendTaskCompletionAlert: vi.fn(async () => true),
    sendTaskCompletionAlertsEnabledConfirmation: vi.fn(async () => true),
    sendTaskCompletionAlertsTestNotification: vi.fn(async () => true)
  };

  const reset = () => {
    threadState = baseThreads.map((thread) => ({ ...thread }));
    terminalDataHandler = null;
    terminalTurnCompletedHandler = null;
    terminalExitHandler = null;
    terminalPositions.clear();
    window.localStorage.clear();
    helperMocks.sendTaskCompletionAlert.mockClear();
    helperMocks.sendTaskCompletionAlertsEnabledConfirmation.mockClear();
    helperMocks.sendTaskCompletionAlertsTestNotification.mockClear();
    helperMocks.sendTaskCompletionAlertsEnabledConfirmation.mockResolvedValue(true);
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    ...helperMocks,
    getThread: (threadId: string) => threadState.find((thread) => thread.id === threadId) ?? threadState[0],
    prependThread: (thread: (typeof baseThreads)[number]) => {
      threadState = [thread, ...threadState];
    },
    emitTerminalData: (event: { sessionId: string; data: string }) => {
      const startPosition = terminalPositions.get(event.sessionId) ?? 0;
      const endPosition = startPosition + event.data.length;
      terminalPositions.set(event.sessionId, endPosition);
      terminalDataHandler?.({
        ...event,
        startPosition,
        endPosition
      });
    },
    emitTerminalTurnCompleted: (event: {
      sessionId: string;
      threadId?: string | null;
      status?: 'Succeeded' | 'Failed';
      hasMeaningfulOutput?: boolean;
      completedAtMs?: number | null;
    }) => {
      terminalTurnCompletedHandler?.(event);
    },
    emitTerminalExit: (event: { sessionId: string; code: number | null; signal: number | null }) => {
      terminalExitHandler?.(event);
    },
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(async (handler: (event: {
      sessionId: string;
      data: string;
      startPosition: number;
      endPosition: number;
    }) => void) => {
      terminalDataHandler = handler;
      return () => {
        if (terminalDataHandler === handler) {
          terminalDataHandler = null;
        }
      };
    }),
    onTerminalReady: vi.fn(async () => () => undefined),
    onTerminalSshAuthStatus: vi.fn(async () => () => undefined),
    onTerminalTurnCompleted: vi.fn(
      async (
        handler: (event: {
          sessionId: string;
          threadId?: string | null;
          status?: 'Succeeded' | 'Failed';
          hasMeaningfulOutput?: boolean;
          completedAtMs?: number | null;
        }) => void
      ) => {
        terminalTurnCompletedHandler = handler;
        return () => {
          if (terminalTurnCompletedHandler === handler) {
            terminalTurnCompletedHandler = null;
          }
        };
      }
    ),
    onTerminalExit: vi.fn(
      async (handler: (event: { sessionId: string; code: number | null; signal: number | null }) => void) => {
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

vi.mock('../../src/lib/taskCompletionAlerts', () => ({
  sendTaskCompletionAlert: mocks.sendTaskCompletionAlert,
  sendTaskCompletionAlertsEnabledConfirmation: mocks.sendTaskCompletionAlertsEnabledConfirmation,
  sendTaskCompletionAlertsTestNotification: mocks.sendTaskCompletionAlertsTestNotification
}));

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: (props: { onData?: (data: string) => void }) => (
    <section className="terminal-panel" data-testid="terminal-panel-mock">
      <button type="button" onClick={() => props.onData?.('x')}>
        type-char
      </button>
      <button type="button" onClick={() => props.onData?.('Submitted prompt\r')}>
        submit-input
      </button>
    </section>
  )
}));

import App from '../../src/App';

function getThreadOrder(): string[] {
  return Array.from(document.querySelectorAll('.workspace-thread-list .thread-title'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

describe('Left rail recency and sorting semantics', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.reset();
  });

  it('keeps the header clear of timer badges even after terminal output events', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();
  });

  it('uses persisted lastRunEndedAt for recency display with minute-level values', async () => {
    const baseMs = Date.parse('2026-02-22T10:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(baseMs);
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const customThreads = [
        {
          id: 'thread-older',
          workspaceId: 'ws-1',
          agentId: 'claude-code',
          fullAccess: false,
          enabledSkills: [] as string[],
          createdAt: new Date(baseMs - 3_600_000).toISOString(),
          updatedAt: new Date(baseMs - 3_600_000).toISOString(),
          title: 'Older thread',
          isArchived: false,
          lastRunStatus: 'Idle',
          lastRunStartedAt: null,
          lastRunEndedAt: new Date(baseMs - 3_600_000).toISOString(),
          claudeSessionId: null,
          lastResumeAt: null,
          lastNewSessionAt: null
        },
        {
          id: 'thread-newer',
          workspaceId: 'ws-1',
          agentId: 'claude-code',
          fullAccess: false,
          enabledSkills: [] as string[],
          createdAt: new Date(baseMs - 30_000).toISOString(),
          updatedAt: new Date(baseMs - 30_000).toISOString(),
          title: 'Newer thread',
          isArchived: false,
          lastRunStatus: 'Idle',
          lastRunStartedAt: null,
          lastRunEndedAt: new Date(baseMs - 30_000).toISOString(),
          claudeSessionId: null,
          lastResumeAt: null,
          lastNewSessionAt: null
        }
      ];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        mocks.api.listThreads.mockResolvedValueOnce(customThreads);
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        mocks.api.terminalStartSession.mockImplementationOnce(async (params: { threadId: string }) => ({
          sessionId: `session-${params.threadId}`,
          sessionMode: 'new',
          resumeSessionId: null,
          thread: customThreads.find((thread) => thread.id === params.threadId) ?? customThreads[0]
        }));
      }
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);
      expect(screen.queryByTestId('thread-recency-thread-newer')).not.toBeInTheDocument();

      // Advance the fake clock by 60s to fire LeftRail's setInterval, updating its nowMs state.
      // After this, Date.now() ≈ baseMs + 60_000, so the "Newer thread" (lastRunEndedAt = baseMs - 30_000)
      // is ~90s old → formatRecencyShort returns "1m".
      await act(async () => { vi.advanceTimersByTime(60_000); });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      expect(screen.getByTestId('thread-recency-thread-newer')).toHaveTextContent('1m');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores persisted user-input recency after relaunch', async () => {
    const nowMs = Date.parse('2026-02-22T10:00:00.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(nowMs);
    try {
      window.localStorage.setItem(
        'claudex:last-user-input-at',
        JSON.stringify({
          'thread-older': nowMs - 20_000
        })
      );

      render(<App />);

      await screen.findByRole('button', { name: /Older thread/i });
      expect(getThreadOrder()).toEqual(['Older thread', 'Newer thread']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-sort threads from output-only activity', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });
    await waitFor(() => {
      expect(mocks.api.terminalResize).toHaveBeenCalledWith('session-thread-older', expect.any(Number), expect.any(Number));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-older', data: 'assistant output\n' });
    });

    await waitFor(() => {
      expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);
    });
  });

  it('does not change thread order when only selecting threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);
  });

  it('re-sorts only after explicit submit events, not clicks, typing, or output', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-older', data: 'assistant reply\n' });
    });
    expect(getThreadOrder()).toEqual(['Newer thread', 'Older thread']);

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(getThreadOrder()).toEqual(['Older thread', 'Newer thread']);
    });
  });

  it('puts a newly created thread at the top even when another thread has recent submitted input', async () => {
    const user = userEvent.setup();
    mocks.api.createThread.mockImplementationOnce(async () => {
      const next = {
        id: 'thread-new',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [] as string[],
        title: 'Newest thread',
        isArchived: false,
        lastRunStatus: 'Idle' as const,
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      mocks.prependThread(next);
      return next;
    });
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });
    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(getThreadOrder()).toEqual(['Older thread', 'Newer thread']);
    });

    await user.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(getThreadOrder()).toEqual(['Newest thread', 'Older thread', 'Newer thread']);
    });
  });

  it('shows working spinner while generating and blue unread marker after completion on non-selected threads', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });
    expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();

    await waitFor(
      () => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      },
      { timeout: 2500 }
    );

    await user.click(screen.getByRole('button', { name: /Newer thread/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });
  });

  it('reconciles a persisted local running turn exactly once on resumed attach when completion already exists', async () => {
    window.localStorage.setItem('claudex:selected-thread:ws-1', 'thread-newer');
    seedThreadAttentionState({
      'thread-newer': {
        activeTurnId: 1,
        activeTurnStatus: 'running',
        activeTurnStartedAtMs: 2_000,
        activeTurnHasMeaningfulOutput: false,
        activeTurnLastOutputAtMs: null,
        lastCompletedTurnIdWithOutput: 0,
        lastCompletedTurnStatus: null,
        lastCompletedTurnAtMs: null,
        lastCompletedTurnLastOutputAtMs: null,
        lastViewedTurnId: 0,
        lastViewedAtMs: null,
        lastNotifiedTurnId: 0,
        lastNotifiedTurnStatus: null
      }
    });

    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => ({
        sessionId: `session-${params.threadId}`,
        sessionMode: params.threadId === 'thread-newer' ? 'resumed' : 'new',
        resumeSessionId: params.threadId === 'thread-newer' ? 'resume-thread-newer' : null,
        turnCompletionMode: params.threadId === 'thread-newer' ? 'jsonl' : 'idle',
        thread: mocks.getThread(params.threadId)
      }));

      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();

      act(() => {
        mocks.emitTerminalTurnCompleted({
          sessionId: 'session-thread-newer',
          threadId: 'thread-newer',
          status: 'Succeeded',
          hasMeaningfulOutput: true,
          completedAtMs: 3_000
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
    }
  });

  it('does not falsely reconcile a resumed local running turn when no completion exists yet', async () => {
    window.localStorage.setItem('claudex:selected-thread:ws-1', 'thread-newer');
    seedThreadAttentionState({
      'thread-newer': {
        activeTurnId: 1,
        activeTurnStatus: 'running',
        activeTurnStartedAtMs: 2_000,
        activeTurnHasMeaningfulOutput: false,
        activeTurnLastOutputAtMs: null,
        lastCompletedTurnIdWithOutput: 0,
        lastCompletedTurnStatus: null,
        lastCompletedTurnAtMs: null,
        lastCompletedTurnLastOutputAtMs: null,
        lastViewedTurnId: 0,
        lastViewedAtMs: null,
        lastNotifiedTurnId: 0,
        lastNotifiedTurnStatus: null
      }
    });

    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => ({
        sessionId: `session-${params.threadId}`,
        sessionMode: params.threadId === 'thread-newer' ? 'resumed' : 'new',
        resumeSessionId: params.threadId === 'thread-newer' ? 'resume-thread-newer' : null,
        turnCompletionMode: params.threadId === 'thread-newer' ? 'jsonl' : 'idle',
        thread: mocks.getThread(params.threadId)
      }));

      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
    }
  });

  it('does not request local reattach reconciliation when there is no persisted running turn', async () => {
    window.localStorage.setItem('claudex:selected-thread:ws-1', 'thread-newer');

    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string; reattachCompletionAfterMs?: number | null }) => ({
        sessionId: `session-${params.threadId}`,
        sessionMode: 'resumed',
        resumeSessionId: 'resume-thread-newer',
        turnCompletionMode: 'jsonl',
        reattachTurnCompletion: null,
        thread: mocks.getThread(params.threadId)
      }));

      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'thread-newer'
          })
        );
      });

      const [firstCall] = mocks.api.terminalStartSession.mock.calls;
      expect(firstCall?.[0]).not.toHaveProperty('reattachCompletionAfterMs');
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
    }
  });

  it('does not turn blue on a quiet pause alone when structured completion mode is enabled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => ({
        sessionId: `session-${params.threadId}`,
        sessionMode: 'new',
        resumeSessionId: null,
        turnCompletionMode: params.threadId === 'thread-newer' ? 'jsonl' : 'idle',
        thread: mocks.getThread(params.threadId)
      }));

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await waitFor(() => {
        expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
      });

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();

      act(() => {
        mocks.emitTerminalTurnCompleted({
          sessionId: 'session-thread-newer',
          threadId: 'thread-newer',
          status: 'Succeeded',
          hasMeaningfulOutput: true,
          completedAtMs: Date.now()
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      });
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
      vi.useRealTimers();
    }
  });

  it('keeps unread when structured completion arrives before the final PTY chunk', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation(async (params: { threadId: string }) => ({
        sessionId: `session-${params.threadId}`,
        sessionMode: 'new',
        resumeSessionId: null,
        turnCompletionMode: params.threadId === 'thread-newer' ? 'jsonl' : 'idle',
        thread: mocks.getThread(params.threadId)
      }));

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await waitFor(() => {
        expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
      });

      act(() => {
        mocks.emitTerminalTurnCompleted({
          sessionId: 'session-thread-newer',
          threadId: 'thread-newer',
          status: 'Succeeded',
          hasMeaningfulOutput: true,
          completedAtMs: Date.now()
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      });

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      });
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
      vi.useRealTimers();
    }
  });

  it('does not duplicate unread or notifications when reconciliation is followed by the same completion event', async () => {
    window.localStorage.setItem('claudex:selected-thread:ws-1', 'thread-older');
    window.localStorage.setItem('claudex:task-completion-alerts-bootstrap-v1', '1');
    seedThreadAttentionState({
      'thread-newer': {
        activeTurnId: 1,
        activeTurnStatus: 'running',
        activeTurnStartedAtMs: 2_000,
        activeTurnHasMeaningfulOutput: false,
        activeTurnLastOutputAtMs: null,
        lastCompletedTurnIdWithOutput: 0,
        lastCompletedTurnStatus: null,
        lastCompletedTurnAtMs: null,
        lastCompletedTurnLastOutputAtMs: null,
        lastViewedTurnId: 0,
        lastViewedAtMs: null,
        lastNotifiedTurnId: 0,
        lastNotifiedTurnStatus: null
      }
    });
    mocks.api.getSettings.mockResolvedValueOnce({
      claudeCliPath: '/usr/local/bin/claude',
      taskCompletionAlerts: true
    });

    let resolveNewerStart: ((value: {
      sessionId: string;
      sessionMode: 'resumed' | 'new';
      resumeSessionId: string | null;
      turnCompletionMode: 'jsonl' | 'idle';
      thread: ReturnType<typeof mocks.getThread>;
    }) => void) | null = null;
    const newerStartPromise = new Promise<{
      sessionId: string;
      sessionMode: 'resumed' | 'new';
      resumeSessionId: string | null;
      turnCompletionMode: 'jsonl' | 'idle';
      thread: ReturnType<typeof mocks.getThread>;
    }>((resolve) => {
      resolveNewerStart = resolve;
    });

    const originalTerminalStartSession = mocks.api.terminalStartSession.getMockImplementation();
    try {
      mocks.api.terminalStartSession.mockImplementation((params: { threadId: string }) => {
        if (params.threadId === 'thread-newer') {
          return newerStartPromise;
        }
        return Promise.resolve({
          sessionId: `session-${params.threadId}`,
          sessionMode: 'new' as const,
          resumeSessionId: null,
          turnCompletionMode: 'idle' as const,
          thread: mocks.getThread(params.threadId)
        });
      });

      const user = userEvent.setup();
      render(<App />);

      await screen.findByRole('button', { name: /Older thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
      });

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      await act(async () => {
        resolveNewerStart?.({
          sessionId: 'session-thread-newer',
          sessionMode: 'resumed',
          resumeSessionId: 'resume-thread-newer',
          turnCompletionMode: 'jsonl',
          thread: mocks.getThread('thread-newer')
        });
        await Promise.resolve();
      });

      act(() => {
        mocks.emitTerminalTurnCompleted({
          sessionId: 'session-thread-newer',
          threadId: 'thread-newer',
          status: 'Succeeded',
          hasMeaningfulOutput: true,
          completedAtMs: 3_000
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
        expect(mocks.sendTaskCompletionAlert).toHaveBeenCalledTimes(1);
      });

      act(() => {
        mocks.emitTerminalTurnCompleted({
          sessionId: 'session-thread-newer',
          threadId: 'thread-newer',
          status: 'Succeeded',
          hasMeaningfulOutput: true,
          completedAtMs: 3_000
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
        expect(mocks.sendTaskCompletionAlert).toHaveBeenCalledTimes(1);
      });
    } finally {
      if (originalTerminalStartSession) {
        mocks.api.terminalStartSession.mockImplementation(originalTerminalStartSession);
      }
    }
  });

  it('does not resurface unread after the user reads output before idle timeout completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await waitFor(() => {
        expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
      });

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mark unread when a run completes offscreen but no new output arrived after it was read', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
    }, { timeout: 2500 });
    expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
  });

  it('does not mark unread from control-only terminal chunks', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: '\u001b[?25l\u001b[1G\u001b[K' });
    });

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 50);
    });

    expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
  });

  it('does not mark unread from split OSC title chunks', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: '\u001b]10;rgb:d8d8/e0e0/efef' });
    });
    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: '\u0007' });
    });

    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 50);
    });

    expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
  });

  it('does not re-mark unread from duplicate redraw chunks after unread is cleared', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await user.click(screen.getByRole('button', { name: /Older thread/i }));

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      },
      { timeout: 2500 }
    );

    await user.click(screen.getByRole('button', { name: /Newer thread/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: '\u001b[1G\u001b[Kassistant output\r' });
    });
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 80);
    });

    expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
  });

  it('does not re-mark unread from replayed plain-text output after unread is cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });
      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-mark unread from replayed output that was already visible via snapshot hydration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      let nowMs = Date.parse('2026-02-22T10:00:00.000Z');
      dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        nowMs += 1;
        return nowMs;
      });
      mocks.api.terminalReadOutput.mockImplementation(async (sessionId: string) => {
        const text = sessionId === 'session-thread-newer' ? 'assistant output\n' : '';
        return {
          text,
          startPosition: 0,
          endPosition: text.length,
          truncated: false
        };
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await waitFor(() => {
        expect(mocks.api.terminalReadOutput).toHaveBeenCalledWith('session-thread-newer');
      });
      await waitFor(() => {
        const raw = window.localStorage.getItem('claudex:visible-output-guard') ?? '{}';
        const parsed = JSON.parse(raw) as Record<string, { tail?: unknown }>;
        expect(parsed['thread-newer']).toMatchObject({ tail: 'assistant output' });
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
      });

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      dateNowSpy?.mockRestore();
      mocks.api.terminalReadOutput.mockImplementation(async () => ({
        text: '',
        startPosition: 0,
        endPosition: 0,
        truncated: false
      }));
      vi.useRealTimers();
    }
  });

  it('fires an alert when a background thread first turns unread', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem('claudex:task-completion-alerts-bootstrap-v1', '1');
      mocks.api.getSettings.mockResolvedValueOnce({
        claudeCliPath: '/usr/local/bin/claude',
        taskCompletionAlerts: true
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      expect(mocks.sendTaskCompletionAlert).toHaveBeenCalledWith({
        threadTitle: 'Newer thread',
        status: 'Succeeded'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('mirrors unread thread count to the app badge and clears it once read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.setAppBadgeCount).toHaveBeenLastCalledWith(null);
      });
      mocks.api.setAppBadgeCount.mockClear();

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
        expect(mocks.api.setAppBadgeCount).toHaveBeenLastCalledWith(1);
      });

      mocks.api.setAppBadgeCount.mockClear();

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
        expect(mocks.api.setAppBadgeCount).toHaveBeenLastCalledWith(null);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts multiple unread threads in the app badge', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const baseMs = Date.parse('2026-02-22T10:00:00.000Z');
      mocks.prependThread({
        id: 'thread-oldest',
        workspaceId: 'ws-1',
        agentId: 'claude-code',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date(baseMs - 10_800_000).toISOString(),
        updatedAt: new Date(baseMs - 10_800_000).toISOString(),
        title: 'Oldest thread',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        claudeSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      mocks.api.setAppBadgeCount.mockClear();

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));
      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });
      await act(async () => {
        vi.advanceTimersByTime(1400);
      });
      await waitFor(() => {
        expect(mocks.api.setAppBadgeCount).toHaveBeenLastCalledWith(1);
      });

      mocks.api.setAppBadgeCount.mockClear();

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Oldest thread/i }));
      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-older', data: 'assistant output\n' });
      });
      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-older')).toBeInTheDocument();
        expect(mocks.api.setAppBadgeCount).toHaveBeenLastCalledWith(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a second identical reply as unread after a new prompt is submitted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem('claudex:task-completion-alerts-bootstrap-v1', '1');
      mocks.api.getSettings.mockResolvedValueOnce({
        claudeCliPath: '/usr/local/bin/claude',
        taskCompletionAlerts: true
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'Done.\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'Done.\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      expect(mocks.sendTaskCompletionAlert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-mark unread on terminal exit after unread has already been cleared', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await user.click(screen.getByRole('button', { name: /Older thread/i }));

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      },
      { timeout: 2500 }
    );

    await user.click(screen.getByRole('button', { name: /Newer thread/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    act(() => {
      mocks.emitTerminalExit({ sessionId: 'session-thread-newer', code: 0, signal: null });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });
  });

  it('does not resurface unread when a completed turn receives a replay of earlier seen output', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'first line\nsecond line\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'first line\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires a failed alert when a background run exits before the idle unread timer fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem('claudex:task-completion-alerts-bootstrap-v1', '1');
      mocks.api.getSettings.mockResolvedValueOnce({
        claudeCliPath: '/usr/local/bin/claude',
        taskCompletionAlerts: true
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
        mocks.emitTerminalExit({ sessionId: 'session-thread-newer', code: 1, signal: null });
      });

      await waitFor(() => {
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      });
      expect(mocks.sendTaskCompletionAlert).toHaveBeenCalledWith({
        threadTitle: 'Newer thread',
        status: 'Failed'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrades an existing background success alert to failed if the run exits non-zero later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem('claudex:task-completion-alerts-bootstrap-v1', '1');
      mocks.api.getSettings.mockResolvedValueOnce({
        claudeCliPath: '/usr/local/bin/claude',
        taskCompletionAlerts: true
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });

      expect(mocks.sendTaskCompletionAlert).toHaveBeenNthCalledWith(1, {
        threadTitle: 'Newer thread',
        status: 'Succeeded'
      });

      act(() => {
        mocks.emitTerminalExit({ sessionId: 'session-thread-newer', code: 1, signal: null });
      });

      await waitFor(() => {
        expect(mocks.sendTaskCompletionAlert).toHaveBeenNthCalledWith(2, {
          threadTitle: 'Newer thread',
          status: 'Failed'
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-mark unread from shell prompt noise after the thread was already read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      render(<App />);

      await screen.findByRole('button', { name: /Newer thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
      });

      await user.click(screen.getByRole('button', { name: 'submit-input' }));
      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });
      expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Newer thread/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Older thread/i }));

      act(() => {
        mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: '/tmp/workspace % ' });
      });

      await act(async () => {
        vi.advanceTimersByTime(1400);
      });
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps unread cleared after relaunch when read state was persisted', async () => {
    const user = userEvent.setup();
    const view = render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-newer' }));
    });

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    await waitFor(() => {
      expect(screen.getByTestId('thread-running-thread-newer')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Older thread/i }));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-older' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
        expect(screen.getByTestId('thread-unread-thread-newer')).toBeInTheDocument();
      },
      { timeout: 2500 }
    );

    await user.click(screen.getByRole('button', { name: /Newer thread/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem('claudex:last-read-at') ?? '{}';
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof parsed['thread-newer']).toBe('number');
    });

    view.unmount();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    expect(screen.queryByTestId('thread-unread-thread-newer')).not.toBeInTheDocument();
  });

  it('keeps a single terminal data subscription while run state changes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /Newer thread/i });
    const subscriptionCallsAfterMount = mocks.onTerminalData.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'submit-input' }));
    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-newer', data: 'assistant output\n' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('thread-running-thread-newer')).not.toBeInTheDocument();
    }, { timeout: 2500 });

    expect(mocks.onTerminalData.mock.calls.length).toBe(subscriptionCallsAfterMount);
  });
});
