import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectTerminalExit,
  ProjectTerminalOutput,
  Workspace
} from '../../src/types';

const terminalState = vi.hoisted(() => ({
  dataHandler: null as ((data: string) => void) | null,
  options: {} as Record<string, unknown>,
  writes: [] as Array<string | Uint8Array>,
  reset: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  start: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  stop: vi.fn(),
  openExternalUrl: vi.fn(),
  outputHandler: null as ((output: ProjectTerminalOutput) => void) | null,
  exitHandler: null as ((exit: ProjectTerminalExit) => void) | null
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 24;
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminalState.options = options;
    }

    loadAddon() {}
    open() {}
    dispose() {}

    onData(handler: (data: string) => void) {
      terminalState.dataHandler = handler;
      return { dispose: vi.fn() };
    }

    write(data: string | Uint8Array) {
      terminalState.writes.push(data);
    }

    writeln(data: string) {
      terminalState.writes.push(data);
    }

    reset() {
      terminalState.reset();
    }

    clear() {
      terminalState.clear();
    }

    focus() {
      terminalState.focus();
    }
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  }
}));

vi.mock('../../src/lib/api', () => ({
  api: {
    startProjectTerminal: apiMocks.start,
    writeProjectTerminal: apiMocks.write,
    resizeProjectTerminal: apiMocks.resize,
    stopProjectTerminal: apiMocks.stop,
    openExternalUrl: apiMocks.openExternalUrl
  },
  onProjectTerminalOutput: vi.fn(
    async (handler: (output: ProjectTerminalOutput) => void) => {
      apiMocks.outputHandler = handler;
      return vi.fn();
    }
  ),
  onProjectTerminalExit: vi.fn(
    async (handler: (exit: ProjectTerminalExit) => void) => {
      apiMocks.exitHandler = handler;
      return vi.fn();
    }
  )
}));

import {
  normalizeTerminalExternalLink,
  ProjectTerminalShelf
} from '../../src/components/ProjectTerminalShelf';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Project',
  path: '/tmp/project',
  workspaceType: 'local',
  isPinned: false,
  sortOrder: 0,
  isExpanded: true,
  isAvailable: true,
  gitPullOnMasterForNewThreads: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

describe('Project Terminal shelf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalState.dataHandler = null;
    terminalState.options = {};
    terminalState.writes = [];
    apiMocks.outputHandler = null;
    apiMocks.exitHandler = null;
    apiMocks.start.mockResolvedValue({
      id: 'terminal-1',
      workspaceId: workspace.id,
      cwd: workspace.path,
      shell: '/bin/zsh',
      processId: 123
    });
    apiMocks.write.mockResolvedValue(undefined);
    apiMocks.resize.mockResolvedValue(undefined);
    apiMocks.stop.mockResolvedValue(undefined);
    apiMocks.openExternalUrl.mockResolvedValue(undefined);
  });

  it('routes safe OSC hyperlinks to the native browser instead of a bare webview', async () => {
    render(
      <ProjectTerminalShelf
        open
        workspace={workspace}
        requestedCwd={workspace.path}
        onClose={vi.fn()}
        onError={vi.fn()}
      />
    );
    await waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));

    const linkHandler = terminalState.options.linkHandler as {
      activate: (event: MouseEvent, value: string) => void;
    };
    act(() => {
      linkHandler.activate(new MouseEvent('click'), 'https://github.com/login?from=terminal');
      linkHandler.activate(new MouseEvent('click'), 'javascript:alert(1)');
    });

    await waitFor(() =>
      expect(apiMocks.openExternalUrl).toHaveBeenCalledWith(
        'https://github.com/login?from=terminal'
      )
    );
    expect(apiMocks.openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it('accepts only HTTP(S) terminal links', () => {
    expect(normalizeTerminalExternalLink('https://github.com/login')).toBe(
      'https://github.com/login'
    );
    expect(normalizeTerminalExternalLink('file:///tmp/private')).toBeNull();
    expect(normalizeTerminalExternalLink('javascript:alert(1)')).toBeNull();
    expect(normalizeTerminalExternalLink('not a URL')).toBeNull();
  });

  it('waits for event listeners, starts in the project, and carries binary output and input', async () => {
    render(
      <ProjectTerminalShelf
        open
        workspace={workspace}
        requestedCwd={workspace.path}
        onClose={vi.fn()}
        onError={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(apiMocks.start).toHaveBeenCalledWith(
        workspace.id,
        workspace.path,
        100,
        24
      )
    );
    expect(apiMocks.outputHandler).not.toBeNull();
    expect(apiMocks.exitHandler).not.toBeNull();

    act(() => {
      apiMocks.outputHandler?.({
        sessionId: 'terminal-1',
        workspaceId: workspace.id,
        dataBase64: window.btoa('terminal output'),
        byteLength: 15
      });
      terminalState.dataHandler?.('pwd\r');
    });

    expect(
      terminalState.writes.some(
        (value) =>
          value instanceof Uint8Array &&
          new TextDecoder().decode(value) === 'terminal output'
      )
    ).toBe(true);
    await waitFor(() =>
      expect(apiMocks.write).toHaveBeenCalledWith('terminal-1', 'pwd\r')
    );
  });

  it('buffers startup output and discards trailing bytes from an older session', async () => {
    let resolveStart!: (session: {
      id: string;
      workspaceId: string;
      cwd: string;
      shell: string;
      processId: number;
    }) => void;
    apiMocks.start.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );
    render(
      <ProjectTerminalShelf
        open
        workspace={workspace}
        requestedCwd={workspace.path}
        onClose={vi.fn()}
        onError={vi.fn()}
      />
    );
    await waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));

    act(() => {
      apiMocks.outputHandler?.({
        sessionId: 'terminal-old',
        workspaceId: workspace.id,
        dataBase64: window.btoa('stale output'),
        byteLength: 12
      });
      apiMocks.outputHandler?.({
        sessionId: 'terminal-2',
        workspaceId: workspace.id,
        dataBase64: window.btoa('new prompt'),
        byteLength: 10
      });
    });

    const decodedWrites = () =>
      terminalState.writes
        .filter((value): value is Uint8Array => value instanceof Uint8Array)
        .map((value) => new TextDecoder().decode(value));
    expect(decodedWrites()).toEqual([]);

    await act(async () => {
      resolveStart({
        id: 'terminal-2',
        workspaceId: workspace.id,
        cwd: workspace.path,
        shell: '/bin/zsh',
        processId: 456
      });
    });

    await waitFor(() => expect(decodedWrites()).toContain('new prompt'));
    expect(decodedWrites()).not.toContain('stale output');
  });

  it('hides without stopping and exposes explicit restart and stop controls', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ProjectTerminalShelf
        open
        workspace={workspace}
        requestedCwd={workspace.path}
        onClose={onClose}
        onError={vi.fn()}
      />
    );
    await waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Hide Project Terminal' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiMocks.stop).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Restart Project Terminal' }));
    await waitFor(() => expect(apiMocks.stop).toHaveBeenCalledWith('terminal-1'));
    await waitFor(() => expect(apiMocks.start).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: 'Stop Project Terminal' }));
    await waitFor(() => expect(apiMocks.stop).toHaveBeenCalledTimes(2));
  });
});
