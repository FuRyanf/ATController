import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CloneRepositoryDialog } from '../../src/components/CloneRepositoryDialog';
import { ManageProjectsDialog } from '../../src/components/ManageProjectsDialog';
import { ProjectContextMenu } from '../../src/components/ProjectContextMenu';
import { ProjectImportDialog } from '../../src/components/ProjectImportDialog';
import type {
  CodexDiscoveredProject,
  CodexThread,
  Workspace
} from '../../src/types';

const workspace: Workspace = {
  id: 'workspace-1',
  name: 'ATController',
  path: '/tmp/ATController',
  workspaceType: 'local',
  isPinned: false,
  sortOrder: 0,
  isExpanded: true,
  isAvailable: true,
  gitPullOnMasterForNewThreads: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

const discovered: CodexDiscoveredProject[] = [
  {
    name: 'new-project',
    workspacePath: '/tmp/new-project',
    threadCount: 3,
    activeThreadCount: 2,
    archivedThreadCount: 1,
    mostRecentActivity: 2,
    alreadyAdded: false,
    available: true,
    threadIds: ['one', 'two', 'three']
  },
  {
    name: 'existing',
    workspacePath: '/tmp/existing',
    threadCount: 1,
    activeThreadCount: 1,
    archivedThreadCount: 0,
    mostRecentActivity: 1,
    alreadyAdded: true,
    available: true,
    threadIds: ['existing-thread']
  },
  {
    name: 'missing',
    workspacePath: '/tmp/missing',
    threadCount: 2,
    activeThreadCount: 2,
    archivedThreadCount: 0,
    mostRecentActivity: 1,
    alreadyAdded: false,
    available: false,
    threadIds: ['missing-one', 'missing-two']
  }
];

describe('project management surfaces', () => {
  it('exposes the complete project context menu and separates non-destructive removal', async () => {
    const onAction = vi.fn();
    render(
      <ProjectContextMenu
        workspace={workspace}
        hasGit
        x={40}
        y={40}
        onAction={onAction}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('menuitem', { name: 'New Thread' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy Project Path' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy Shell Command' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Import Codex Threads' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Refresh Git Status' })).toBeInTheDocument();
    const remove = screen.getByRole('menuitem', {
      name: 'Remove from ATController…'
    });
    expect(remove).toHaveClass('danger');
    await userEvent.click(remove);
    expect(onAction).toHaveBeenCalledWith('remove');
  });

  it('offers locate and original-path recovery for a missing project', () => {
    render(
      <ProjectContextMenu
        workspace={{ ...workspace, isAvailable: false }}
        hasGit={false}
        x={40}
        y={40}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('menuitem', { name: 'Locate Folder…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy Original Path' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open in Terminal' })).not.toBeInTheDocument();
  });

  it('imports only selected available, not-yet-added Codex projects', async () => {
    const onImport = vi.fn();
    render(
      <ProjectImportDialog
        open
        projects={discovered}
        loading={false}
        busy={false}
        onRefresh={vi.fn()}
        onImport={onImport}
        onClose={vi.fn()}
      />
    );
    const available = screen.getByRole('checkbox', { name: /new-project/ });
    const existing = screen.getByRole('checkbox', { name: /existing/ });
    const missing = screen.getByRole('checkbox', { name: /missing/ });
    expect(available).toBeChecked();
    expect(existing).toBeDisabled();
    expect(missing).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Import Projects' }));
    expect(onImport).toHaveBeenCalledWith(['/tmp/new-project']);
  });

  it('provides a lightweight management list with reorder, rename, import, and remove actions', async () => {
    const onMove = vi.fn();
    const onRename = vi.fn();
    const onImportThreads = vi.fn();
    const onRemove = vi.fn();
    render(
      <ManageProjectsDialog
        open
        workspaces={[workspace]}
        threadsByWorkspace={{ [workspace.id]: [] as CodexThread[] }}
        gitInfoByWorkspace={{}}
        onOpen={vi.fn()}
        onReveal={vi.fn()}
        onRename={onRename}
        onTogglePin={vi.fn()}
        onMove={onMove}
        onImportThreads={onImportThreads}
        onRemove={onRemove}
        onClose={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rename ATController' }));
    expect(onRename).toHaveBeenCalledWith(workspace.id);
    await userEvent.click(
      screen.getByRole('button', { name: 'Import Codex threads for ATController' })
    );
    expect(onImportThreads).toHaveBeenCalledWith(workspace.id);
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove ATController from ATController' })
    );
    expect(onRemove).toHaveBeenCalledWith(workspace.id);
  });

  it('clones only after an explicit destination and repository are provided', async () => {
    const onClone = vi.fn();
    render(
      <CloneRepositoryDialog
        open
        destinationParent="/tmp"
        busy={false}
        onChooseDestination={vi.fn()}
        onClone={onClone}
        onClose={vi.fn()}
      />
    );
    await userEvent.type(
      screen.getByPlaceholderText('https://github.com/owner/repository.git'),
      'https://github.com/openai/codex.git'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clone and Add' }));
    expect(onClone).toHaveBeenCalledWith('https://github.com/openai/codex.git');
  });
});
