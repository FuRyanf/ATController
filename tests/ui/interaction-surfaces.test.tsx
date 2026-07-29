import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  CommandPalette,
  type PaletteAction
} from '../../src/components/CommandPalette';
import { ThreadContextMenu } from '../../src/components/ThreadContextMenu';
import type {
  CodexThread,
  CodexThreadUiMetadata,
  Workspace
} from '../../src/types';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'Project',
  path: '/tmp/project',
  gitPullOnMasterForNewThreads: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

const thread: CodexThread = {
  id: 'thread-1',
  sessionId: 'thread-1',
  title: 'Session recovery',
  preview: '',
  cwd: workspace.path,
  modelProvider: 'openai',
  createdAt: 1,
  updatedAt: 2,
  status: 'idle',
  source: 'appServer',
  cliVersion: '0.144.0',
  archived: false,
  turns: []
};

const metadata: CodexThreadUiMetadata = {
  threadId: thread.id,
  workspaceId: workspace.id,
  fallbackTitle: thread.title,
  pinned: false,
  unread: true,
  archived: false,
  draft: '',
  promptHistory: [],
  permissionMode: 'fullAccess',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

describe('keyboard-first command surfaces', () => {
  it('exposes resume, recovery, archive, and separated destructive thread actions', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ThreadContextMenu
        thread={thread}
        workspace={workspace}
        metadata={metadata}
        x={80}
        y={80}
        onAction={onAction}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('menuitem', { name: 'Copy Resume Command' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Copy Full Access Resume Command' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Open Resume Command in Terminal' })
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveClass('danger');

    const open = screen.getByRole('menuitem', { name: 'Open' });
    open.focus();
    fireEvent.keyDown(open, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toHaveFocus();
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onAction).toHaveBeenCalledWith('archive');
  });

  it('fuzzy searches the command palette and runs the keyboard selection', async () => {
    const runResume = vi.fn();
    const actions: PaletteAction[] = [
      {
        id: 'resume',
        label: 'Copy Resume Command',
        description: 'Continue in Terminal',
        icon: 'copy',
        run: runResume
      },
      {
        id: 'runtime',
        label: 'Restart Codex Runtime',
        icon: 'refresh',
        run: vi.fn()
      }
    ];
    render(
      <CommandPalette open actions={actions} onClose={vi.fn()} />
    );
    const search = screen.getByRole('textbox', { name: 'Search commands' });
    await userEvent.type(search, 'cpy rsm');
    expect(screen.getByRole('option', { name: /Copy Resume Command/ })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(runResume).toHaveBeenCalledOnce();
  });
});
