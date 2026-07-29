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
  outputHandler: null as ((output: ProjectTerminalOutput) => void) | null,
  exitHandler: null as ((exit: ProjectTerminalExit) => void) | null
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 24;
    options: Record<string, unknown> = {};

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
    stopProjectTerminal: apiMocks.stop
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

import { ProjectTerminalShelf } from '../../src/components/ProjectTerminalShelf';

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
