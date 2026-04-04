import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    title: 'First thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null,
    forkedFromClaudeSessionId: null,
    pendingForkSourceClaudeSessionId: null,
    pendingForkKnownChildSessionIds: [] as string[],
    pendingForkRequestedAt: null,
    pendingForkLaunchConsumed: false,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];
  let terminalDataHandler: ((event: {
    sessionId: string;
    data: string;
    startPosition: number;
    endPosition: number;
    sequence?: number;
  }) => void) | null = null;
  const terminalPositions = new Map<string, number>();
  const terminalSequencePositions = new Map<string, { startPosition: number; endPosition: number }>();

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
      const next = {
        ...baseThread,
        id: `thread-${threadState.length + 1}`,
        title: 'New thread',
        updatedAt: new Date().toISOString()
      };
      threadState = [next, ...threadState];
      return next;
    }),
    createForkedThread: vi.fn(async () => {
      throw new Error('not needed');
    }),
    forkThreadFromUi: vi.fn(async () => {
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
    prepareThreadNativeFork: vi.fn(async (_workspaceId: string, threadId: string) => {
      return {
        sourceClaudeSessionId: '99999999-9999-9999-9999-999999999999',
        knownChildSessionIds: [],
        requestedAt: new Date().toISOString()
      };
    }),
    resolveThreadForkCandidate: vi.fn(async () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    finalizeThreadNativeFork: vi.fn(async (_workspaceId: string, threadId: string, childClaudeSessionId: string) => {
      const current = threadState.find((item) => item.id === threadId) ?? threadState[0];
      const currentThread = {
        ...current,
        claudeSessionId: childClaudeSessionId,
        forkedFromClaudeSessionId: '99999999-9999-9999-9999-999999999999',
        pendingForkSourceClaudeSessionId: null,
        pendingForkKnownChildSessionIds: [] as string[],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString()
      };
      const preservedThread = {
        ...current,
        id: `thread-${threadState.length + 1}`,
        title: `${current.title} (Original)`,
        claudeSessionId: '99999999-9999-9999-9999-999999999999',
        forkedFromClaudeSessionId: null,
        pendingForkSourceClaudeSessionId: null,
        pendingForkKnownChildSessionIds: [] as string[],
        pendingForkRequestedAt: null,
        pendingForkLaunchConsumed: false,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      threadState = [currentThread, preservedThread, ...threadState.filter((item) => item.id !== threadId)];
      return { currentThread, preservedThread };
    }),
    setThreadAgent: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadClaudeSessionId: vi.fn(async (_workspaceId: string, threadId: string, claudeSessionId: string) => {
      const updated = {
        ...threadState.find((thread) => thread.id === threadId)!,
        claudeSessionId,
        pendingForkSourceClaudeSessionId: null,
        pendingForkKnownChildSessionIds: [] as string[],
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
      const thread = threadState.find((item) => item.id === params.threadId) ?? threadState[0];
      return {
        sessionId: `session-${params.threadId}`,
        sessionMode: thread?.claudeSessionId ? 'resumed' : 'new',
        resumeSessionId: thread?.claudeSessionId ?? null,
        thread: {
          ...thread,
          claudeSessionId: thread?.claudeSessionId ?? null,
          lastResumeAt: thread?.claudeSessionId ? new Date().toISOString() : null,
          lastNewSessionAt: thread?.claudeSessionId ? null : new Date().toISOString()
        }
      };
    }),
    terminalWrite: vi.fn(async () => true),
    terminalRebindClaudeSession: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalKill: vi.fn(async () => true),
    terminalSendSignal: vi.fn(async () => true),
    terminalGetLastLog: vi.fn(async () => ({ text: '', startPosition: 0, endPosition: 0, truncated: false })),
    terminalReadOutput: vi.fn(async () => ({
      text: '> ',
      startPosition: 0,
      endPosition: 2,
      truncated: false
    })),
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
    terminalDataHandler = null;
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
    emitTerminalData: (event: { sessionId: string; data: string; sequence?: number }) => {
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
    openDialog: vi.fn(async () => null),
    confirmDialog: vi.fn(async () => true),
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(
      async (handler: (event: {
        sessionId: string;
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

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: (props: {
    content?: string;
    streamState?: { text?: string } | null;
    onData?: (data: string) => void;
    inputEnabled?: boolean;
    overlayMessage?: string;
  }) => (
    <section className="terminal-panel" data-testid="terminal-panel-mock">
      <pre data-testid="terminal-content-mock">{props.streamState?.text ?? props.content ?? ''}</pre>
      <output data-testid="terminal-input-enabled">{String(Boolean(props.inputEnabled))}</output>
      <output data-testid="terminal-overlay">{props.overlayMessage ?? ''}</output>
      <button type="button" onClick={() => props.onData?.('   First prompt title line\r')}>
        send-first-prompt
      </button>
      <button
        type="button"
        onClick={() => {
          props.onData?.('\u001b[');
          props.onData?.('31m   Escaped title line\r');
        }}
      >
        send-split-escape-prompt
      </button>
      <button
        type="button"
        onClick={() =>
          props.onData?.(
            '   This title is intentionally very long and should be trimmed to fifty characters max\r'
          )
        }
      >
        send-long-first-prompt
      </button>
      <button type="button" onClick={() => props.onData?.('Second title should not apply\r')}>
        send-second-prompt
      </button>
      <button type="button" onClick={() => props.onData?.('/fork\r')}>
        send-native-fork
      </button>
      <button type="button" onClick={() => props.onData?.('x')}>
        type-char
      </button>
    </section>
  )
}));

import App from '../../src/App';

describe('Sidebar behavior', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does not render Crunching/Running/Completed labels in the UI', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });

    expect(screen.queryByText(/Crunching/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Running for/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Completed$/i)).not.toBeInTheDocument();
  });

  it('does not show a header timer badge even after output is emitted', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'Claude output\n' });
    });

    expect(screen.queryByTestId('header-output-age')).not.toBeInTheDocument();
  });

  it('keeps snapshot backlog and buffered prompt output during pending hydration without typing', async () => {
    let releaseSnapshotReads: (() => void) | null = null;
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshotReads = resolve;
    });
    mocks.api.terminalReadOutput.mockImplementation(async () => {
      await snapshotReady;
      return {
        text: 'Claude Code banner\n',
        startPosition: 0,
        endPosition: 'Claude Code banner\n'.length,
        truncated: false
      };
    });

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: '\n> Try "create a test"\n' });
    });

    act(() => {
      releaseSnapshotReads?.();
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('Claude Code banner');
      expect(rendered).toContain('Try "create a test"');
    });
  });

  it('keeps input enabled when switching back to an existing session while hydration is pending', async () => {
    const user = userEvent.setup();
    let releaseSnapshotReads: (() => void) | null = null;
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshotReads = resolve;
    });
    mocks.api.terminalReadOutput.mockImplementation(async () => {
      await snapshotReady;
      return {
        text: '',
        startPosition: 0,
        endPosition: 0,
        truncated: false
      };
    });

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: /First thread/i }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled').textContent).toBe('true');
    });

    act(() => {
      releaseSnapshotReads?.();
    });
  });

  it('does not overwrite live terminal output with stale snapshot content', async () => {
    let resolveSnapshot: ((value: { text: string; startPosition: number; endPosition: number; truncated: boolean }) => void) | null = null;
    mocks.api.terminalReadOutput.mockImplementationOnce(
      () =>
        new Promise<{ text: string; startPosition: number; endPosition: number; truncated: boolean }>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'LIVE_OUTPUT\n' });
    });

    act(() => {
      resolveSnapshot?.({
        text: 'STALE_SNAPSHOT\n',
        startPosition: 0,
        endPosition: 'STALE_SNAPSHOT\n'.length,
        truncated: false
      });
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect(rendered).toContain('LIVE_OUTPUT');
      expect(rendered).not.toContain('STALE_SNAPSHOT');
    });
  });

  it('ignores duplicate terminal data events when sequence ids repeat', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'DUPLICATE_LINE\n', sequence: 7 });
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'DUPLICATE_LINE\n', sequence: 7 });
    });

    await waitFor(() => {
      const rendered = screen.getByTestId('terminal-content-mock').textContent ?? '';
      expect((rendered.match(/DUPLICATE_LINE/g) ?? []).length).toBe(1);
    });
  });

  it('queues attachments and sends them with the next Enter submit', async () => {
    const user = userEvent.setup();
    mocks.openDialog.mockResolvedValueOnce(['/tmp/screenshot.png', '/tmp/spec.md']);
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    await user.click(screen.getByRole('button', { name: 'Add attachments' }));

    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));

    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalled();
    });

    const matchingCall = (mocks.api.terminalWrite as { mock: { calls: Array<[string, string]> } }).mock.calls.find(
      ([, payload]) => payload.includes('/tmp/screenshot.png') && payload.includes('/tmp/spec.md')
    );
    expect(matchingCall).toBeDefined();
    expect(matchingCall?.[0]).toBe('session-thread-1');
    expect(matchingCall?.[1]).toContain('Inspect image and screenshot files visually.');
    expect(matchingCall?.[1]).toContain('First prompt title line');
    expect(matchingCall?.[1].endsWith('\r')).toBe(true);
  });

  it('sets title once from first prompt and does not change while typing or later submits', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-long-first-prompt' }));
    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith(
        'ws-1',
        'thread-2',
        'This title is intentionally very long and should b'
      );
    });

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    await user.click(screen.getByRole('button', { name: 'send-second-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledTimes(1);
    });
  });

  it('tracks native /fork only after the terminal write succeeds and rebinds the current thread', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-native-fork' }));

    await waitFor(() => {
      expect(mocks.api.prepareThreadNativeFork).toHaveBeenCalledWith('ws-1', 'thread-1', 'session-thread-1');
    });
    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-thread-1', '/fork\r');
    });
    await waitFor(() => {
      expect(mocks.api.commitPreparedThreadPendingFork).toHaveBeenCalledWith(
        'ws-1',
        'thread-1',
        expect.objectContaining({
          sourceClaudeSessionId: '99999999-9999-9999-9999-999999999999'
        })
      );
    });
    expect(mocks.api.renameThread).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.api.setThreadClaudeSessionId).toHaveBeenCalledWith(
        'ws-1',
        'thread-1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      );
    });
    expect(mocks.api.finalizeThreadNativeFork).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /First thread \(Original\)/i })).not.toBeInTheDocument();
  });

  it('leaves the source session unclaimed after native /fork so it can be imported', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-native-fork' }));

    await waitFor(() => {
      expect(mocks.api.setThreadClaudeSessionId).toHaveBeenCalledWith(
        'ws-1',
        'thread-1',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      );
    });

    // After resolution, the thread must hold the child session, not the source.
    const allThreads = await mocks.api.listThreads();
    const resolvedThread = allThreads.find(
      (t: { id: string }) => t.id === 'thread-1'
    );
    expect(resolvedThread?.claudeSessionId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    // The source session id must not appear as any thread's claudeSessionId.
    const sourceStillClaimed = allThreads.some(
      (t: { claudeSessionId: string | null }) =>
        t.claudeSessionId === '99999999-9999-9999-9999-999999999999'
    );
    expect(sourceStillClaimed).toBe(false);
  });

  it('clears pending fork tracking when native /fork fails to write to the terminal', async () => {
    const user = userEvent.setup();
    mocks.api.terminalWrite.mockResolvedValueOnce(false);
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-native-fork' }));

    await waitFor(() => {
      expect(mocks.api.prepareThreadNativeFork).toHaveBeenCalledWith('ws-1', 'thread-1', 'session-thread-1');
    });
    expect(mocks.api.clearThreadPendingFork).not.toHaveBeenCalled();
    expect(mocks.api.commitPreparedThreadPendingFork).not.toHaveBeenCalled();
    expect(mocks.api.markThreadPendingForkConsumed).not.toHaveBeenCalled();
  });

  it('handles split terminal control sequences when deriving the first thread title', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });
    fireEvent.click(screen.getByTestId('workspace-new-thread-ws-1'));

    await waitFor(() => {
      expect(mocks.api.createThread).toHaveBeenCalledWith('ws-1', 'claude-code');
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-2' }));
    });

    await user.click(screen.getByRole('button', { name: 'send-split-escape-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith('ws-1', 'thread-2', 'Escaped title line');
    });
  });

  it('does not rerender the sidebar on terminal keystrokes', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: /First thread/i });

    act(() => {
      mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'ready\n' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-content-mock').textContent ?? '').toContain('ready');
    });

    const sidebar = await screen.findByTestId('sidebar');
    const before = Number(sidebar.getAttribute('data-render-count') ?? '0');

    await user.click(screen.getByRole('button', { name: 'type-char' }));
    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalled();
    });

    const after = Number(screen.getByTestId('sidebar').getAttribute('data-render-count') ?? '0');
    expect(after).toBe(before);
  });

  it('clears stuck working state when only control chunks keep arriving', async () => {
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, 'now');
    let nowMs = Date.now();
    nowSpy.mockImplementation(() => nowMs);

    try {
      render(<App />);

      await screen.findByRole('button', { name: /First thread/i });
      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
      });

      await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));
      act(() => {
        nowMs += 10;
        mocks.emitTerminalData({ sessionId: 'session-thread-1', data: 'working...\n' });
      });
      await waitFor(() => {
        expect(screen.getByTestId('thread-running-thread-1')).toBeInTheDocument();
      });

      for (let index = 0; index < 40; index += 1) {
        act(() => {
          nowMs += 500;
          mocks.emitTerminalData({ sessionId: 'session-thread-1', data: '\u001b[2K\r' });
        });
      }

      await waitFor(() => {
        expect(screen.queryByTestId('thread-running-thread-1')).not.toBeInTheDocument();
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
