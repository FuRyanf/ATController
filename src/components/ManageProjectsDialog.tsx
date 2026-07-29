import { useEffect } from 'react';

import type { CodexThread, GitInfo, Workspace } from '../types';
import { AppIcon } from './AppIcon';

interface ManageProjectsDialogProps {
  open: boolean;
  workspaces: Workspace[];
  threadsByWorkspace: Record<string, CodexThread[]>;
  gitInfoByWorkspace: Record<string, GitInfo | null>;
  focusedWorkspaceId?: string | null;
  onOpen: (workspaceId: string) => void;
  onReveal: (workspaceId: string) => void;
  onRename: (workspaceId: string) => void;
  onTogglePin: (workspaceId: string) => void;
  onMove: (workspaceId: string, direction: -1 | 1) => void;
  onImportThreads: (workspaceId: string) => void;
  onRemove: (workspaceId: string) => void;
  onClose: () => void;
}

function latestActivity(threads: CodexThread[]): number {
  return threads.reduce(
    (latest, thread) =>
      Math.max(latest, thread.recencyAt ?? thread.updatedAt ?? thread.createdAt),
    0
  );
}

function activityLabel(timestamp: number): string {
  if (!timestamp) return 'No thread activity';
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(milliseconds).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  });
}

export function ManageProjectsDialog({
  open,
  workspaces,
  threadsByWorkspace,
  gitInfoByWorkspace,
  focusedWorkspaceId,
  onOpen,
  onReveal,
  onRename,
  onTogglePin,
  onMove,
  onImportThreads,
  onRemove,
  onClose
}: ManageProjectsDialogProps) {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    requestAnimationFrame(() => {
      if (focusedWorkspaceId) {
        document
          .querySelector<HTMLElement>(`[data-manage-project="${focusedWorkspaceId}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => window.removeEventListener('keydown', close);
  }, [focusedWorkspaceId, onClose, open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <section
        className="manage-projects-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-projects-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="manage-projects-title">Manage Projects</h2>
            <p>Project entries organize local folders. Removing one never deletes its files or Codex threads.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <AppIcon name="close" />
          </button>
        </header>
        <div className="manage-projects-columns" aria-hidden="true">
          <span>Project</span>
          <span>Status</span>
          <span>Threads</span>
          <span>Last activity</span>
          <span>Actions</span>
        </div>
        <div className="manage-projects-list">
          {workspaces.map((workspace, index) => {
            const threads = threadsByWorkspace[workspace.id] ?? [];
            const git = gitInfoByWorkspace[workspace.id];
            return (
              <article
                key={workspace.id}
                data-manage-project={workspace.id}
                className={`${focusedWorkspaceId === workspace.id ? 'focused' : ''} ${workspace.isAvailable ? '' : 'unavailable'}`}
              >
                <div className="manage-project-identity">
                  <strong>
                    {workspace.isPinned ? <AppIcon name="pin" size={11} /> : null}
                    {workspace.name}
                  </strong>
                  <span title={workspace.path}>{workspace.path}</span>
                </div>
                <div className="manage-project-status">
                  {!workspace.isAvailable ? (
                    <span className="warning">Folder unavailable</span>
                  ) : git ? (
                    <>
                      <strong>{git.branch}</strong>
                      <span>{git.isDirty ? 'Uncommitted changes' : 'Clean working tree'}</span>
                    </>
                  ) : (
                    <span>Local folder</span>
                  )}
                </div>
                <div className="manage-project-count">
                  <strong>{threads.length}</strong>
                  <span>{threads.length === 1 ? 'thread' : 'threads'}</span>
                </div>
                <div className="manage-project-activity">
                  {activityLabel(latestActivity(threads))}
                </div>
                <div className="manage-project-actions">
                  <button type="button" className="icon-button" title="Open project" aria-label={`Open ${workspace.name}`} onClick={() => onOpen(workspace.id)}>
                    <AppIcon name="chevronRight" />
                  </button>
                  <button type="button" className="icon-button" title="Reveal in Finder" aria-label={`Reveal ${workspace.name} in Finder`} disabled={!workspace.isAvailable} onClick={() => onReveal(workspace.id)}>
                    <AppIcon name="folder" />
                  </button>
                  <button type="button" className="icon-button" title="Rename" aria-label={`Rename ${workspace.name}`} onClick={() => onRename(workspace.id)}>
                    <AppIcon name="code" />
                  </button>
                  <button type="button" className="icon-button" title={workspace.isPinned ? 'Unpin' : 'Pin'} aria-label={`${workspace.isPinned ? 'Unpin' : 'Pin'} ${workspace.name}`} onClick={() => onTogglePin(workspace.id)}>
                    <AppIcon name="pin" />
                  </button>
                  <button type="button" className="icon-button" title="Move up" aria-label={`Move ${workspace.name} up`} disabled={index === 0} onClick={() => onMove(workspace.id, -1)}>
                    <AppIcon name="arrowDown" className="rotate-180" />
                  </button>
                  <button type="button" className="icon-button" title="Move down" aria-label={`Move ${workspace.name} down`} disabled={index === workspaces.length - 1} onClick={() => onMove(workspace.id, 1)}>
                    <AppIcon name="arrowDown" />
                  </button>
                  <button type="button" className="icon-button" title="Import Codex threads" aria-label={`Import Codex threads for ${workspace.name}`} disabled={!workspace.isAvailable} onClick={() => onImportThreads(workspace.id)}>
                    <AppIcon name="refresh" />
                  </button>
                  <button type="button" className="icon-button danger" title="Remove from ATController" aria-label={`Remove ${workspace.name} from ATController`} onClick={() => onRemove(workspace.id)}>
                    <AppIcon name="trash" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <footer>
          <span>{workspaces.length} {workspaces.length === 1 ? 'project' : 'projects'}</span>
          <button type="button" className="primary-button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
