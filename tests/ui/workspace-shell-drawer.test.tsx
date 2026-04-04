import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/TerminalPanel', () => ({
  TerminalPanel: ({ sessionId, content }: { sessionId?: string | null; content: string }) => (
    <div data-testid="terminal-panel-mock">
      <span>{sessionId ?? 'pending'}</span>
      <span>{content}</span>
    </div>
  )
}));

import { WorkspaceShellDrawer } from '../../src/components/WorkspaceShellDrawer';

const workspace = {
  id: 'ws-1',
  name: 'Workspace One',
  path: '/tmp/workspace-one',
  kind: 'local' as const,
  sshCommand: null,
  gitPullOnMasterForNewThreads: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe('WorkspaceShellDrawer', () => {
  it('renders docked resize and popout controls', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onStartResize = vi.fn();
    const onOpenInTerminal = vi.fn();

    render(
      <WorkspaceShellDrawer
        open
        workspace={workspace}
        sessionId="shell-session-1"
        content="terminal content"
        height={320}
        onClose={onClose}
        onStartResize={onStartResize}
        onOpenInTerminal={onOpenInTerminal}
        onData={() => undefined}
        onResize={() => undefined}
      />
    );

    expect(screen.getByTestId('workspace-shell-drawer')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize terminal drawer' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId('workspace-shell-resize-handle'), { button: 0, clientY: 280 });
    expect(onStartResize).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open in Terminal' }));
    expect(onOpenInTerminal).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close terminal drawer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
