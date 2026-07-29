import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workspaceOne = {
    id: 'ws-added',
    name: 'workspace-added',
    path: '/tmp/workspace-added',
    kind: 'local' as const,
    rdevSshCommand: null,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceTwo = {
    id: 'ws-second',
    name: 'workspace-second',
    path: '/tmp/workspace-second',
    kind: 'local' as const,
    rdevSshCommand: null,
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceRdev = {
    id: 'ws-rdev',
    name: 'example-env',
    path: 'rdev-workspace-1',
    kind: 'rdev' as const,
    rdevSshCommand: 'rdev ssh team/example-env',
    sshCommand: null,
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspaceSsh = {
    id: 'ws-ssh',
    name: 'remote-host',
    path: 'ssh-workspace-1',
    kind: 'ssh' as const,
    rdevSshCommand: null,
    sshCommand: 'ssh dev@remote-host',
    remotePath: '~/projects/example',
    gitPullOnMasterForNewThreads: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  type WorkspaceFixture = typeof workspaceOne | typeof workspaceRdev | typeof workspaceSsh;
  let workspaceState: WorkspaceFixture[] = [];

  const api = {
    getAppStorageRoot: vi.fn(async () => '/tmp/ATController'),
    listWorkspaces: vi.fn(async () => workspaceState),
    addWorkspace: vi.fn(async () => {
      workspaceState = [workspaceOne];
      return workspaceOne;
    }),
    addRdevWorkspace: vi.fn(async () => {
      workspaceState = [workspaceRdev];
      return workspaceRdev;
    }),
    addSshWorkspace: vi.fn(async () => {
      workspaceState = [workspaceSsh];
      return workspaceSsh;
    }),
    removeWorkspace: vi.fn(async (workspaceId: string) => {
      const before = workspaceState.length;
      workspaceState = workspaceState.filter((workspace) => workspace.id !== workspaceId);
      return workspaceState.length !== before;
    }),
    setWorkspaceOrder: vi.fn(async (workspaceIds: string[]) => {
      const byId = new Map(workspaceState.map((workspace) => [workspace.id, workspace]));
      const reordered = workspaceIds
        .map((workspaceId) => byId.get(workspaceId))
        .filter((workspace): workspace is WorkspaceFixture => Boolean(workspace));
      workspaceState = [...reordered, ...workspaceState.filter((workspace) => !workspaceIds.includes(workspace.id))];
      return workspaceState;
    }),
    setWorkspaceGitPullOnMasterForNewThreads: vi.fn(async (workspaceId: string, enabled: boolean) => {
      workspaceState = workspaceState.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, gitPullOnMasterForNewThreads: enabled, updatedAt: new Date().toISOString() }
          : workspace
      );
      return workspaceState.find((workspace) => workspace.id === workspaceId) ?? workspaceOne;
    }),
    getGitInfo: vi.fn(async () => null),
    gitPullMasterForNewThread: vi.fn(async () => ({
      outcome: 'pulled' as const,
      message: 'Checked out master and pulled latest changes.'
    })),
    listThreads: vi.fn(async () => []),
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
    clearThreadCodexSession: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadCodexSessionId: vi.fn(async () => {
      throw new Error('not needed');
    }),
    setThreadSkills: vi.fn(async () => {
      throw new Error('not needed');
    }),
    listSkills: vi.fn(async () => []),
    listRecentCodexThreads: vi.fn(async () => []),
    getCodexRuntimeOverview: vi.fn(async () => ({
      selectedModel: null,
      selectedReasoningEffort: null,
      fastMode: false,
      configVersion: null,
      models: [],
      fiveHourLimit: null,
      weeklyLimit: null,
      rateLimitsAvailable: false
    })),
    updateCodexRuntimePreferences: vi.fn(async () => ({
      selectedModel: null,
      selectedReasoningEffort: null,
      fastMode: false,
      configVersion: null,
      models: [],
      fiveHourLimit: null,
      weeklyLimit: null,
      rateLimitsAvailable: false
    })),
    getSettings: vi.fn(async () => ({ codexCliPath: '/usr/local/bin/codex' })),
    saveSettings: vi.fn(async (settings: { codexCliPath: string | null }) => settings),
    detectCodexCliPath: vi.fn(async () => '/usr/local/bin/codex'),
    checkForUpdate: vi.fn(async () => ({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      releaseUrl: null
    })),
    installLatestUpdate: vi.fn(async () => true),
    terminalStartSession: vi.fn(async () => ({
      sessionId: 'session-1',
      sessionMode: 'new',
      resumeSessionId: null,
      thread: {
        id: 'thread-1',
        workspaceId: 'ws-added',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'New thread',
        isArchived: false,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        codexSessionId: null,
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    })),
    terminalWrite: vi.fn(async () => true),
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
    discoverImportableCodexSessions: vi.fn(async () => []),
    getImportableCodexSession: vi.fn(async () => null),
    importCodexSession: vi.fn(async () => {
      throw new Error('not needed');
    }),
    writeTextToClipboard: vi.fn(async () => undefined)
  };
  const openDialog = vi.fn(async () => null);
  const confirmDialog = vi.fn(async () => true);
  const helperMocks = {
    sendTaskCompletionAlert: vi.fn(async () => true),
    sendTaskCompletionAlertsEnabledConfirmation: vi.fn(async () => true),
    sendTaskCompletionAlertsTestNotification: vi.fn(async () => true)
  };

  const reset = () => {
    Object.values(api).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    });
    openDialog.mockClear();
    confirmDialog.mockClear();
    Object.values(helperMocks).forEach((fn) => {
      fn.mockClear();
    });
    workspaceState = [];
  };

  return {
    api,
    reset,
    ...helperMocks,
    seedWorkspaces: (next: WorkspaceFixture[]) => {
      workspaceState = next.map((workspace) => ({ ...workspace }));
    },
    sampleWorkspaces: {
      workspaceOne,
      workspaceTwo,
      workspaceRdev,
      workspaceSsh
    },
    openDialog,
    confirmDialog,
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

vi.mock('../../src/lib/taskCompletionAlerts', () => ({
  sendTaskCompletionAlert: mocks.sendTaskCompletionAlert,
  sendTaskCompletionAlertsEnabledConfirmation: mocks.sendTaskCompletionAlertsEnabledConfirmation,
  sendTaskCompletionAlertsTestNotification: mocks.sendTaskCompletionAlertsTestNotification
}));

import App from '../../src/App';

function getWorkspaceOrder(): string[] {
  return Array.from(document.querySelectorAll('.workspace-group .workspace-group-name'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((value) => value.length > 0);
}

function fireWorkspacePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init
  });
  Object.defineProperty(event, 'pointerId', {
    configurable: true,
    value: init.pointerId ?? 1
  });
  Object.defineProperty(event, 'isPrimary', {
    configurable: true,
    value: init.isPrimary ?? true
  });
  fireEvent(target, event);
}

function recentIsoTimestamp(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe('Workspace add flow', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('does nothing when native directory selection is canceled', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    expect(mocks.api.addWorkspace).not.toHaveBeenCalled();
  });

  it('adds workspace from manual fallback modal and updates UI immediately', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));

    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    expect(mocks.api.addWorkspace).toHaveBeenCalledWith('/tmp/workspace-added');
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('removes workspace from the workspace context menu', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(true);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).toHaveBeenCalledWith('ws-added');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /workspace-added/i })).not.toBeInTheDocument();
    });
  });

  it('does not remove workspace when remove confirmation is canceled', async () => {
    const user = userEvent.setup();
    mocks.confirmDialog.mockResolvedValueOnce(false);
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    await screen.findByRole('button', { name: /workspace-added/i });

    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });
    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Remove project' }));

    expect(mocks.confirmDialog).toHaveBeenCalled();
    expect(mocks.api.removeWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /workspace-added/i })).toBeInTheDocument();
  });

  it('reorders workspaces by dragging a project row', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const sourceRow = screen.getByRole('button', { name: /workspace-added/i });
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    expect(targetGroup).not.toBeNull();

    const targetElement = targetGroup as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => targetElement)
    });
    const targetRectSpy = vi.spyOn(targetElement, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 320,
      width: 320,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);

    fireWorkspacePointer(sourceRow, 'pointerdown', { button: 0, buttons: 1, clientX: 20, clientY: 10 });
    fireWorkspacePointer(window, 'pointermove', { buttons: 1, clientX: 20, clientY: 130 });
    fireWorkspacePointer(window, 'pointerup', { button: 0, clientX: 20, clientY: 130 });

    await waitFor(() => {
      expect(mocks.api.setWorkspaceOrder).toHaveBeenCalledWith(['ws-second', 'ws-added']);
    });
    await waitFor(() => {
      expect(getWorkspaceOrder()).toEqual(['workspace-second', 'workspace-added']);
    });

    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      delete (document as Partial<Document>).elementFromPoint;
    }
    targetRectSpy.mockRestore();
  });

  it('reorders workspaces by dragging the project grip', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const sourceRow = screen.getByRole('button', { name: /workspace-added/i });
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    expect(targetGroup).not.toBeNull();

    const sourceGrip = screen.getByTestId('workspace-drag-ws-added');
    const targetElement = targetGroup as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => targetElement)
    });
    const targetRectSpy = vi.spyOn(targetElement, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 320,
      width: 320,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);

    fireWorkspacePointer(sourceGrip, 'pointerdown', { button: 0, buttons: 1, clientX: 20, clientY: 10 });
    fireWorkspacePointer(window, 'pointermove', { buttons: 1, clientX: 20, clientY: 130 });
    fireWorkspacePointer(window, 'pointerup', { button: 0, clientX: 20, clientY: 130 });

    await waitFor(() => {
      expect(mocks.api.setWorkspaceOrder).toHaveBeenCalledWith(['ws-second', 'ws-added']);
    });
    await waitFor(() => {
      expect(getWorkspaceOrder()).toEqual(['workspace-second', 'workspace-added']);
    });

    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      delete (document as Partial<Document>).elementFromPoint;
    }
    targetRectSpy.mockRestore();
  });

  it('does not reorder workspaces when a drag is released outside the project list', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    const sourceGrip = screen.getByTestId('workspace-drag-ws-added');
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    const workspaceGroups = document.querySelector('.workspace-groups');
    expect(targetGroup).not.toBeNull();
    expect(workspaceGroups).not.toBeNull();

    const targetElement = targetGroup as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn((x: number) => (x > 400 ? document.body : targetElement))
    });
    const targetRectSpy = vi.spyOn(targetElement, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 320,
      width: 320,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);
    const groupsRectSpy = vi.spyOn(workspaceGroups as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 220,
      left: 0,
      right: 320,
      width: 320,
      height: 220,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    fireWorkspacePointer(sourceGrip, 'pointerdown', { button: 0, buttons: 1, clientX: 20, clientY: 10 });
    fireWorkspacePointer(window, 'pointermove', { buttons: 1, clientX: 20, clientY: 130 });
    fireWorkspacePointer(window, 'pointerup', { button: 0, clientX: 800, clientY: 130 });

    expect(mocks.api.setWorkspaceOrder).not.toHaveBeenCalled();
    expect(getWorkspaceOrder()).toEqual(['workspace-added', 'workspace-second']);

    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      delete (document as Partial<Document>).elementFromPoint;
    }
    targetRectSpy.mockRestore();
    groupsRectSpy.mockRestore();
  });

  it('cancels active workspace drags when the window loses focus', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });

    const sourceGrip = screen.getByTestId('workspace-drag-ws-added');
    const targetGroup = screen.getByRole('button', { name: /workspace-second/i }).closest('.workspace-group');
    expect(targetGroup).not.toBeNull();

    const targetElement = targetGroup as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => targetElement)
    });
    const targetRectSpy = vi.spyOn(targetElement, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 320,
      width: 320,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);

    fireWorkspacePointer(sourceGrip, 'pointerdown', { button: 0, buttons: 1, clientX: 20, clientY: 10 });
    fireWorkspacePointer(window, 'pointermove', { buttons: 1, clientX: 20, clientY: 130 });
    expect(document.querySelector('.workspace-group.dragging')).not.toBeNull();

    fireEvent.blur(window);
    fireWorkspacePointer(window, 'pointerup', { button: 0, clientX: 20, clientY: 130 });

    expect(mocks.api.setWorkspaceOrder).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.querySelector('.workspace-group.dragging')).toBeNull();
    });

    if (originalElementFromPoint) {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      delete (document as Partial<Document>).elementFromPoint;
    }
    targetRectSpy.mockRestore();
  });

  it('reorders workspaces with the project grip keyboard shortcuts', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });
    fireEvent.keyDown(screen.getByTestId('workspace-drag-ws-second'), { key: 'ArrowUp' });

    await waitFor(() => {
      expect(mocks.api.setWorkspaceOrder).toHaveBeenCalledWith(['ws-second', 'ws-added']);
    });
    await waitFor(() => {
      expect(getWorkspaceOrder()).toEqual(['workspace-second', 'workspace-added']);
    });
  });

  it('uses drag affordances instead of move arrow buttons', async () => {
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
    render(<App />);

    await screen.findByRole('button', { name: /workspace-added/i });

    expect(screen.getByTestId('workspace-drag-ws-added')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-drag-ws-second')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-drag-ws-added')).toHaveAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    expect(screen.queryByTestId('workspace-move-up-ws-added')).toBeNull();
    expect(screen.queryByTestId('workspace-move-down-ws-added')).toBeNull();
  });

  it('adds an ssh workspace from the add-project modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(screen.getByRole('tab', { name: 'ssh' }));
    const modal = screen.getByText('Add Project').closest('section');
    expect(
      screen.getByText('Paste an ssh command that authenticates with an SSH key. ATController does not store credentials.')
    ).toBeInTheDocument();
    expect(modal?.textContent).toContain('Unlock your key with macOS Keychain or ssh-agent');
    expect(modal?.textContent).toContain('Recommended ~/.ssh/config: AddKeysToAgent yes UseKeychain yes');
    await user.type(screen.getByLabelText('ssh command'), 'ssh dev@remote-host');
    await user.type(screen.getByLabelText('Display name (optional)'), 'remote-host');
    await user.type(screen.getByLabelText('Remote path (optional)'), '~/projects/example');
    await user.click(screen.getByRole('button', { name: 'Add SSH project' }));

    expect(mocks.api.addSshWorkspace).toHaveBeenCalledWith(
      'ssh dev@remote-host',
      'remote-host',
      '~/projects/example'
    );
    expect(await screen.findByRole('button', { name: /remote-host/i })).toBeInTheDocument();
  });

  it('adds an rdev workspace from the add-project modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(screen.getByRole('tab', { name: 'rdev' }));
    await user.type(screen.getByLabelText('rdev ssh command'), 'rdev ssh team/example-env');
    await user.type(screen.getByLabelText('Display name (optional)'), 'example-env');
    await user.click(screen.getByRole('button', { name: 'Add rdev project' }));

    expect(mocks.api.addRdevWorkspace).toHaveBeenCalledWith('rdev ssh team/example-env', 'example-env');
    expect(await screen.findByRole('button', { name: /example-env/i })).toBeInTheDocument();
  });

  it('copies terminal diagnostics through the native clipboard bridge for a selected local workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    const diagnosticsButton = await screen.findByRole('button', { name: 'Copy terminal env diagnostics' });
    expect(diagnosticsButton).toBeEnabled();

    await user.click(diagnosticsButton);

    await waitFor(() => {
      expect(mocks.api.copyTerminalEnvDiagnostics).toHaveBeenCalledWith('/tmp/workspace-added');
      expect(mocks.api.writeTextToClipboard).toHaveBeenCalledWith('diagnostics');
    });
  });

  it('closes settings on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));

    await screen.findByRole('button', { name: 'Copy terminal env diagnostics' });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Copy terminal env diagnostics' })).not.toBeInTheDocument();
    });
  });

  it('sends a test alert from Settings when task completion alerts are enabled', async () => {
    const user = userEvent.setup();
    mocks.api.getSettings.mockResolvedValueOnce({
      codexCliPath: '/usr/local/bin/codex',
      taskCompletionAlerts: true
    });

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const testAlertButton = await screen.findByRole('button', { name: 'Send test alert' });
    expect(testAlertButton).toBeEnabled();

    await user.click(testAlertButton);

    await waitFor(() => {
      expect(mocks.sendTaskCompletionAlertsTestNotification).toHaveBeenCalledTimes(1);
    });
  });

  it('imports a Codex session into a new thread from workspace menu', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });

    const createdThread = {
      id: 'thread-import',
      workspaceId: 'ws-added',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'New thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      codexSessionId: null,
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    const importedThread = {
      ...createdThread,
      codexSessionId: '123e4567-e89b-12d3-a456-426614174000'
    };

    mocks.api.importCodexSession.mockResolvedValueOnce(importedThread);

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Import Codex session…' }));
    await user.type(
      await screen.findByLabelText('Codex session ID'),
      '123e4567-e89b-12d3-a456-426614174000'
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(mocks.api.importCodexSession).toHaveBeenCalledWith(
        'ws-added',
        '123e4567-e89b-12d3-a456-426614174000',
        null,
        false
      );
    });

    await waitFor(() => {
      expect(mocks.api.terminalStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-import' })
      );
    });

    const importCallOrder = mocks.api.importCodexSession.mock.invocationCallOrder[0] ?? 0;
    const startCallOrder = mocks.api.terminalStartSession.mock.invocationCallOrder.find(
      (value: number) => value > 0
    ) ?? 0;
    expect(importCallOrder).toBeGreaterThan(0);
    expect(startCallOrder).toBeGreaterThan(0);
    expect(importCallOrder).toBeLessThan(startCallOrder);
  });

  it('opens a recent unimported Codex session directly from the workspace sidebar', async () => {
    const user = userEvent.setup();
    const sessionId = '33333333-3333-3333-3333-333333333333';
    const importedThread = {
      id: 'thread-recent',
      workspaceId: 'ws-added',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'Live Codex work',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      codexSessionId: sessionId,
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    let imported = false;
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne]);
    mocks.api.listThreads.mockImplementation(async () => (imported ? [importedThread] : []));
    mocks.api.listRecentCodexThreads.mockResolvedValue([
      {
        sessionId,
        workspaceId: 'ws-added',
        title: 'Live Codex work',
        createdAt: Math.floor(Date.now() / 1000) - 60,
        updatedAt: Math.floor(Date.now() / 1000),
        recencyAt: Math.floor(Date.now() / 1000)
      }
    ]);
    mocks.api.importCodexSession.mockImplementationOnce(async () => {
      imported = true;
      return importedThread;
    });

    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Live Codex work/i }));

    await waitFor(() => {
      expect(mocks.api.importCodexSession).toHaveBeenCalledWith(
        'ws-added',
        sessionId,
        'Live Codex work',
        false
      );
    });
    expect(screen.getAllByText('Live Codex work').length).toBeGreaterThan(0);
  });

  it('blocks importing a Codex session that belongs to a different local workspace', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    const input = await screen.findByLabelText('Manual path');
    await user.clear(input);
    await user.type(input, '/tmp/workspace-added');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const workspaceRow = await screen.findByRole('button', { name: /workspace-added/i });

    mocks.api.importCodexSession.mockRejectedValueOnce(
      new Error('This Codex session belongs to a different workspace.')
    );

    await user.pointer([{ target: workspaceRow, keys: '[MouseRight]' }]);
    await user.click(await screen.findByRole('button', { name: 'Import Codex session…' }));
    await user.type(
      await screen.findByLabelText('Codex session ID'),
      '123e4567-e89b-12d3-a456-426614174000'
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText(/this codex session belongs to a different workspace/i)
    ).toBeInTheDocument();
    expect(mocks.api.importCodexSession).toHaveBeenCalledWith(
      'ws-added',
      '123e4567-e89b-12d3-a456-426614174000',
      null,
      false
    );
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-import' })
    );
  });

  it('bulk imports selected Codex sessions from Add Project and adds missing projects first', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne]);
    mocks.api.discoverImportableCodexSessions.mockResolvedValueOnce([
      {
        path: '/tmp/workspace-added',
        name: 'workspace-added',
        pathExists: true,
        workspaceId: 'ws-added',
        workspaceName: 'workspace-added',
        sessions: [
          {
            sessionId: '11111111-1111-1111-1111-111111111111',
            summary: 'Existing project session',
            firstPrompt: 'resume existing work',
            messageCount: 6,
            createdAt: recentIsoTimestamp(2),
            modifiedAt: recentIsoTimestamp(1),
            gitBranch: 'feature/existing'
          }
        ]
      },
      {
        path: '/tmp/workspace-second',
        name: 'workspace-second',
        pathExists: true,
        workspaceId: null,
        workspaceName: null,
        sessions: [
          {
            sessionId: '22222222-2222-2222-2222-222222222222',
            summary: 'New project session',
            firstPrompt: 'resume new work',
            messageCount: 3,
            createdAt: recentIsoTimestamp(3),
            modifiedAt: recentIsoTimestamp(1),
            gitBranch: 'feature/new'
          }
        ]
      }
    ]);

    mocks.api.addWorkspace.mockImplementationOnce(async (path: string) => {
      expect(path).toBe('/tmp/workspace-second');
      mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne, mocks.sampleWorkspaces.workspaceTwo]);
      return mocks.sampleWorkspaces.workspaceTwo;
    });

    const importedExistingThread = {
      id: 'thread-bulk-existing',
      workspaceId: 'ws-added',
      fullAccess: false,
      enabledSkills: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: 'New thread',
      isArchived: false,
      lastRunStatus: 'Idle' as const,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      codexSessionId: '11111111-1111-1111-1111-111111111111',
      lastResumeAt: null,
      lastNewSessionAt: null
    };
    const importedNewProjectThread = {
      ...importedExistingThread,
      id: 'thread-bulk-new',
      workspaceId: 'ws-second',
      codexSessionId: '22222222-2222-2222-2222-222222222222'
    };

    mocks.api.importCodexSession
      .mockResolvedValueOnce(importedExistingThread)
      .mockResolvedValueOnce(importedNewProjectThread);

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(await screen.findByRole('button', { name: 'Import Codex sessions' }));

    await screen.findByRole('dialog', { name: 'Bulk Import Codex Sessions' });
    await user.click(screen.getByRole('checkbox', { name: /Existing project session/i }));
    await user.click(screen.getByRole('checkbox', { name: /New project session/i }));
    await user.click(screen.getByRole('button', { name: 'Import selected (2)' }));

    await waitFor(() => {
      expect(mocks.api.addWorkspace).toHaveBeenCalledWith('/tmp/workspace-second');
      expect(mocks.api.importCodexSession).toHaveBeenCalledWith(
        'ws-added',
        '11111111-1111-1111-1111-111111111111',
        'Existing project session',
        false
      );
      expect(mocks.api.importCodexSession).toHaveBeenCalledWith(
        'ws-second',
        '22222222-2222-2222-2222-222222222222',
        'New project session',
        false
      );
    });

    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-bulk-existing' })
    );
    expect(mocks.api.terminalStartSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-bulk-new' })
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Bulk Import Codex Sessions' })).not.toBeInTheDocument();
    });
  });
  it('reoffers an archived imported Codex session in bulk import so it can be recovered', async () => {
    const user = userEvent.setup();
    mocks.seedWorkspaces([mocks.sampleWorkspaces.workspaceOne]);
    mocks.api.listThreads.mockResolvedValueOnce([
      {
        id: 'thread-archived-import',
        workspaceId: 'ws-added',
        fullAccess: false,
        enabledSkills: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: 'Archived import',
        isArchived: true,
        lastRunStatus: 'Idle',
        lastRunStartedAt: null,
        lastRunEndedAt: null,
        codexSessionId: '11111111-1111-1111-1111-111111111111',
        lastResumeAt: null,
        lastNewSessionAt: null
      }
    ]);
    mocks.api.discoverImportableCodexSessions.mockResolvedValueOnce([
      {
        path: '/tmp/workspace-added',
        name: 'workspace-added',
        pathExists: true,
        workspaceId: 'ws-added',
        workspaceName: 'workspace-added',
        sessions: [
          {
            sessionId: '11111111-1111-1111-1111-111111111111',
            summary: 'Recovered session',
            firstPrompt: 'recover me please',
            messageCount: 6,
            createdAt: recentIsoTimestamp(2),
            modifiedAt: recentIsoTimestamp(1),
            gitBranch: 'feature/recover'
          }
        ]
      }
    ]);

    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Add new project' }));
    await user.click(await screen.findByRole('button', { name: 'Import Codex sessions' }));

    await screen.findByRole('dialog', { name: 'Bulk Import Codex Sessions' });
    expect(await screen.findByRole('checkbox', { name: /Recovered session/i })).toBeInTheDocument();
    expect(screen.queryByText(/already imported/i)).not.toBeInTheDocument();
  });

});
