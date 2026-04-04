import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspace = {
    id: 'ws-ssh',
    name: 'remote-host',
    path: 'ssh-workspace-1',
    kind: 'ssh' as const,
    sshCommand: 'ssh dev@remote-host',
    remotePath: '~/projects/example',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const baseThread = {
    id: 'thread-1',
    workspaceId: 'ws-ssh',
    agentId: 'claude-code',
    fullAccess: false,
    enabledSkills: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New thread',
    isArchived: false,
    lastRunStatus: 'Idle' as const,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    claudeSessionId: null,
    lastResumeAt: null,
    lastNewSessionAt: null
  };

  let threadState = [{ ...baseThread }];
  let nextSessionId = 1;
  let terminalDataHandler:
    | ((event: {
        sessionId: string;
        threadId?: string | null;
        data: string;
        startPosition: number;
        endPosition: number;
      }) => void)
    | null = null;
  let terminalReadyHandler:
    | ((event: { sessionId: string; threadId?: string | null }) => void)
    | null = null;
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

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => [workspace]),
    addWorkspace: vi.fn(async () => workspace),
    addSshWorkspace: vi.fn(async () => workspace),
    removeWorkspace: vi.fn(async () => true),
    setWorkspaceOrder: vi.fn(async () => [workspace]),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async () => workspace),
    getGitInfo: vi.fn(async () => null),
    getGitDiffSummary: vi.fn(async () => ({ stat: '', diffExcerpt: '' })),
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
    setThreadClaudeSessionId: vi.fn(async () => {
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
    terminalStartSession: vi.fn(async () => ({
      sessionId: `session-${nextSessionId++}`,
      sessionMode: 'new' as const,
      resumeSessionId: null,
      thread: {
        ...threadState[0],
        lastNewSessionAt: new Date().toISOString()
      }
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
    openExternalUrl: vi.fn(async () => undefined),
    openTerminalCommand: vi.fn(async () => undefined),
    copyTerminalEnvDiagnostics: vi.fn(async () => 'diagnostics'),
    setAppBadgeCount: vi.fn(async () => true),
    validateImportableClaudeSession: vi.fn(async () => true),
    discoverImportableClaudeSessions: vi.fn(async () => []),
    writeTextToClipboard: vi.fn(async () => undefined)
  };

  const reset = () => {
    threadState = [{ ...baseThread }];
    nextSessionId = 1;
    terminalDataHandler = null;
    terminalReadyHandler = null;
    terminalSshAuthStatusHandler = null;
    terminalExitHandler = null;
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
  };

  return {
    api,
    reset,
    emitTerminalData: (event: { sessionId: string; threadId?: string | null; data: string }) => {
      terminalDataHandler?.({
        ...event,
        startPosition: 0,
        endPosition: event.data.length
      });
    },
    emitTerminalReady: (event: { sessionId: string; threadId?: string | null }) => {
      terminalReadyHandler?.(event);
    },
    emitTerminalSshAuthStatus: (event: {
      sessionId: string;
      workspaceId: string;
      threadId?: string | null;
      reason: 'host-verification-required' | 'password-auth-unsupported' | 'interactive-auth-unsupported';
    }) => {
      terminalSshAuthStatusHandler?.(event);
    },
    emitTerminalExit: (event: { sessionId: string; code?: number | null; signal?: string | null }) => {
      terminalExitHandler?.(event);
    },
    onRunStream: vi.fn(async () => () => undefined),
    onRunExit: vi.fn(async () => () => undefined),
    onTerminalData: vi.fn(
      async (
        handler: (event: {
          sessionId: string;
          threadId?: string | null;
          data: string;
          startPosition: number;
          endPosition: number;
        }) => void
      ) => {
        terminalDataHandler = handler;
        return () => {
          if (terminalDataHandler === handler) {
            terminalDataHandler = null;
          }
        };
      }
    ),
    onTerminalReady: vi.fn(async (handler: (event: { sessionId: string; threadId?: string | null }) => void) => {
      terminalReadyHandler = handler;
      return () => {
        if (terminalReadyHandler === handler) {
          terminalReadyHandler = null;
        }
      };
    }),
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
    onTerminalExit: vi.fn(async (handler: (event: { sessionId: string; code?: number | null; signal?: string | null }) => void) => {
      terminalExitHandler = handler;
      return () => {
        if (terminalExitHandler === handler) {
          terminalExitHandler = null;
        }
      };
    }),
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
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true)
}));

vi.mock('../../src/lib/taskCompletionAlerts', () => ({
  sendTaskCompletionAlert: vi.fn(async () => true),
  sendTaskCompletionAlertsEnabledConfirmation: vi.fn(async () => true),
  sendTaskCompletionAlertsTestNotification: vi.fn(async () => true)
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
    </section>
  )
}));

import App from '../../src/App';

describe('App SSH auth flow', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('shows a keys-only SSH block modal when the host prompts for a password', async () => {
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-1',
        workspaceId: 'ws-ssh',
        threadId: 'thread-1',
        reason: 'password-auth-unsupported'
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    expect(screen.getByText(/Configure SSH keys with macOS Keychain or ssh-agent/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-1');
    });
    expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('terminal-overlay')).toHaveTextContent(
      'SSH setup blocked. ATController requires key-based auth via macOS Keychain or ssh-agent.'
    );
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(1);
  });

  it('clears the blocked overlay when the SSH block modal is closed', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-1',
        workspaceId: 'ws-ssh',
        threadId: 'thread-1',
        reason: 'password-auth-unsupported'
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
    });

    act(() => {
      mocks.emitTerminalReady({
        sessionId: 'session-2',
        threadId: 'thread-1'
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('true');
    });
  });

  it('ignores stale SSH auth-status events from the prior session while a retry is still pending', async () => {
    const user = userEvent.setup();
    let resolveRetryStart: ((value: any) => void) | null = null;
    mocks.api.terminalStartSession
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        sessionMode: 'new',
        resumeSessionId: null,
        thread: {
          ...({
            id: 'thread-1',
            workspaceId: 'ws-ssh',
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
            lastNewSessionAt: new Date().toISOString()
          } as const)
        }
      })
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            resolveRetryStart = resolve;
          })
      );
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-1',
        workspaceId: 'ws-ssh',
        threadId: 'thread-1',
        reason: 'password-auth-unsupported'
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
    });
    const killCallCountBeforeLateEvent = mocks.api.terminalKill.mock.calls.length;

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-1',
        workspaceId: 'ws-ssh',
        threadId: 'thread-1',
        reason: 'password-auth-unsupported'
      });
    });

    expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();

    act(() => {
      resolveRetryStart?.({
        sessionId: 'session-2',
        sessionMode: 'new',
        resumeSessionId: null,
        thread: {
          id: 'thread-1',
          workspaceId: 'ws-ssh',
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
          lastNewSessionAt: new Date().toISOString()
        }
      });
    });

    act(() => {
      mocks.emitTerminalReady({
        sessionId: 'session-2',
        threadId: 'thread-1'
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('true');
    });
    expect(mocks.api.terminalKill.mock.calls.length).toBe(killCallCountBeforeLateEvent);
    expect(mocks.api.terminalStartSession).toHaveBeenCalledTimes(2);
  });

  it('expires ignored SSH auth-status sessions after TTL and reprocesses the event', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let resolveStart: ((value: any) => void) | null = null;
    mocks.api.terminalStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    try {
      render(<App />);

      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'thread-1'
          })
        );
      });
      await waitFor(() => {
        expect(mocks.onTerminalExit).toHaveBeenCalled();
      });

      act(() => {
        mocks.emitTerminalExit({
          sessionId: 'session-expiring',
          code: 0,
          signal: null
        });
      });

      act(() => {
        nowMs += 5 * 60 * 1000 + 1;
      });

      const killCallCountBeforeEvent = mocks.api.terminalKill.mock.calls.length;

      act(() => {
        mocks.emitTerminalSshAuthStatus({
          sessionId: 'session-expiring',
          workspaceId: 'ws-ssh',
          threadId: 'thread-1',
          reason: 'password-auth-unsupported'
        });
      });

      await waitFor(() => {
        expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-expiring');
      });
      expect(mocks.api.terminalKill.mock.calls.length).toBe(killCallCountBeforeEvent + 1);
    } finally {
      act(() => {
        resolveStart?.({
          sessionId: 'session-recovered',
          sessionMode: 'new',
          resumeSessionId: null,
          thread: {
            id: 'thread-1',
            workspaceId: 'ws-ssh',
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
            lastNewSessionAt: new Date().toISOString()
          }
        });
      });
      nowSpy.mockRestore();
    }
  });

  it('caps ignored SSH auth-status sessions and evicts the oldest entries', async () => {
    const maxIgnoredSessions = 512;
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let resolveStart: ((value: any) => void) | null = null;
    mocks.api.terminalStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    try {
      render(<App />);

      await waitFor(() => {
        expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'thread-1'
          })
        );
      });
      await waitFor(() => {
        expect(mocks.onTerminalExit).toHaveBeenCalled();
      });

      for (let index = 0; index <= maxIgnoredSessions; index += 1) {
        act(() => {
          nowMs += 1;
          mocks.emitTerminalExit({
            sessionId: `session-ignored-${index}`,
            code: 0,
            signal: null
          });
        });
      }

      act(() => {
        mocks.emitTerminalSshAuthStatus({
          sessionId: `session-ignored-${maxIgnoredSessions}`,
          workspaceId: 'ws-ssh',
          threadId: 'thread-1',
          reason: 'password-auth-unsupported'
        });
      });
      expect(mocks.api.terminalKill).not.toHaveBeenCalledWith(`session-ignored-${maxIgnoredSessions}`);

      act(() => {
        mocks.emitTerminalSshAuthStatus({
          sessionId: 'session-ignored-0',
          workspaceId: 'ws-ssh',
          threadId: 'thread-1',
          reason: 'password-auth-unsupported'
        });
      });
      await waitFor(() => {
        expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-ignored-0');
      });
      expect(mocks.api.terminalKill).not.toHaveBeenCalledWith(`session-ignored-${maxIgnoredSessions}`);
    } finally {
      act(() => {
        resolveStart?.({
          sessionId: 'session-recovered',
          sessionMode: 'new',
          resumeSessionId: null,
          thread: {
            id: 'thread-1',
            workspaceId: 'ws-ssh',
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
            lastNewSessionAt: new Date().toISOString()
          }
        });
      });
      nowSpy.mockRestore();
    }
  });

  it('blocks a startup auth challenge that arrives before terminalStartSession resolves', async () => {
    let resolveStart: ((value: any) => void) | null = null;
    mocks.api.terminalStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalSshAuthStatus({
        sessionId: 'session-prebind',
        workspaceId: 'ws-ssh',
        threadId: 'thread-1',
        reason: 'password-auth-unsupported'
      });
    });

    expect(screen.queryByText('ATController supports keys-only SSH')).not.toBeInTheDocument();

    act(() => {
      resolveStart?.({
        sessionId: 'session-prebind',
        sessionMode: 'new',
        resumeSessionId: null,
        thread: {
          id: 'thread-1',
          workspaceId: 'ws-ssh',
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
          lastNewSessionAt: new Date().toISOString()
        }
      });
    });

    expect(await screen.findByText('ATController supports keys-only SSH')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.api.terminalKill).toHaveBeenCalledWith('session-prebind');
    });
    expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('false');
  });

  it('does not unlock SSH readiness from terminal data that arrives before session metadata is bound', async () => {
    const user = userEvent.setup();
    let resolveStart: ((value: any) => void) | null = null;
    mocks.api.terminalStartSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalData({
        sessionId: 'session-1',
        threadId: 'thread-1',
        data: 'Connected to remote-host\n'
      });
    });

    act(() => {
      resolveStart?.({
        sessionId: 'session-1',
        sessionMode: 'new',
        resumeSessionId: null,
        thread: {
          id: 'thread-1',
          workspaceId: 'ws-ssh',
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
          lastNewSessionAt: new Date().toISOString()
        }
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('false');
    });

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));
    expect(mocks.api.renameThread).not.toHaveBeenCalled();
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();

    act(() => {
      mocks.emitTerminalReady({
        sessionId: 'session-1',
        threadId: 'thread-1'
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('true');
    });
  });

  it('does not mark ssh threads ready from generic startup output and only titles after the ready event', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1'
        })
      );
    });

    act(() => {
      mocks.emitTerminalData({
        sessionId: 'session-1',
        threadId: 'thread-1',
        data: 'Connected to remote-host\n'
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('false');
    });

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));
    expect(mocks.api.renameThread).not.toHaveBeenCalled();
    expect(mocks.api.terminalWrite).not.toHaveBeenCalled();

    act(() => {
      mocks.emitTerminalReady({
        sessionId: 'session-1',
        threadId: 'thread-1'
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-input-enabled')).toHaveTextContent('true');
    });

    await user.click(screen.getByRole('button', { name: 'send-first-prompt' }));

    await waitFor(() => {
      expect(mocks.api.renameThread).toHaveBeenCalledWith(
        'ws-ssh',
        'thread-1',
        'First prompt title line'
      );
    });
    await waitFor(() => {
      expect(mocks.api.terminalWrite).toHaveBeenCalledWith('session-1', '   First prompt title line\r');
    });
  });
});
