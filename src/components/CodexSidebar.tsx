import { useMemo, useRef } from 'react';

import type {
  CodexApprovalRequest,
  CodexConnectionState,
  CodexThread,
  CodexThreadUiMetadata,
  Workspace
} from '../types';
import { AppIcon } from './AppIcon';

interface CodexSidebarProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  threads: CodexThread[];
  metadata: Record<string, CodexThreadUiMetadata>;
  approvals: Record<string, CodexApprovalRequest>;
  filter: string;
  connectionState: CodexConnectionState;
  collapsed: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onAddWorkspace: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string) => void;
  onOpenThreadMenu: (threadId: string, x: number, y: number) => void;
  onFilterChange: (value: string) => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onToggleCollapsed: () => void;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) {
    return '';
  }
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w`;
  return new Date(milliseconds).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function threadActivity(thread: CodexThread, waiting: boolean) {
  if (waiting) {
    return { label: 'Waiting for approval', className: 'waiting' };
  }
  const lastTurn = thread.turns.length ? thread.turns[thread.turns.length - 1] : undefined;
  if (lastTurn?.status === 'inProgress') {
    return { label: 'Running', className: 'running' };
  }
  if (lastTurn?.status === 'failed' || thread.status === 'error') {
    return { label: 'Failed', className: 'failed' };
  }
  return { label: 'Idle', className: 'idle' };
}

interface ThreadSectionProps {
  title: string;
  threads: CodexThread[];
  selectedThreadId: string | null;
  metadata: Record<string, CodexThreadUiMetadata>;
  waitingThreadIds: Set<string>;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string) => void;
  onOpenThreadMenu: (threadId: string, x: number, y: number) => void;
  onKeyboardMove: (threadId: string, direction: -1 | 1) => void;
}

function ThreadSection({
  title,
  threads,
  selectedThreadId,
  metadata,
  waitingThreadIds,
  onSelectThread,
  onRenameThread,
  onOpenThreadMenu,
  onKeyboardMove
}: ThreadSectionProps) {
  if (threads.length === 0) {
    return null;
  }
  return (
    <section className="thread-section" aria-labelledby={`thread-section-${title}`}>
      <h2 id={`thread-section-${title}`}>{title}</h2>
      <div role="listbox" aria-label={`${title} Codex threads`}>
        {threads.map((thread) => {
          const ui = metadata[thread.id];
          const activity = threadActivity(thread, waitingThreadIds.has(thread.id));
          const selected = selectedThreadId === thread.id;
          return (
            <button
              key={thread.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={`thread-row ${selected ? 'selected' : ''}`}
              onClick={() => onSelectThread(thread.id)}
              onDoubleClick={() => onRenameThread(thread.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                onOpenThreadMenu(thread.id, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  onKeyboardMove(thread.id, event.key === 'ArrowDown' ? 1 : -1);
                } else if (event.key === 'Enter' && event.metaKey) {
                  event.preventDefault();
                  onRenameThread(thread.id);
                } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onOpenThreadMenu(thread.id, bounds.left + 24, bounds.bottom - 4);
                }
              }}
            >
              <span className={`thread-status-dot ${activity.className}`} title={activity.label} />
              <span className="thread-row-copy">
                <span className="thread-row-title">
                  {ui?.pinned ? <AppIcon name="pin" size={12} /> : null}
                  <span>{thread.title || ui?.fallbackTitle || 'New thread'}</span>
                </span>
                <span className="thread-row-preview">{thread.preview || 'No messages yet'}</span>
              </span>
              <span className="thread-row-meta">
                <span>{relativeTime(thread.recencyAt ?? thread.updatedAt)}</span>
                {ui?.unread ? <span className="thread-unread-dot" aria-label="Unread output" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function CodexSidebar({
  workspaces,
  selectedWorkspaceId,
  selectedThreadId,
  threads,
  metadata,
  approvals,
  filter,
  connectionState,
  collapsed,
  onSelectWorkspace,
  onAddWorkspace,
  onNewThread,
  onSelectThread,
  onRenameThread,
  onOpenThreadMenu,
  onFilterChange,
  onOpenSettings,
  onOpenDiagnostics,
  onToggleCollapsed
}: CodexSidebarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const waitingThreadIds = useMemo(
    () =>
      new Set(
        Object.values(approvals)
          .map((approval) => approval.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      ),
    [approvals]
  );
  const filtered = useMemo(() => {
    const normalized = filter.trim().toLocaleLowerCase();
    return threads
      .filter((thread) => {
        if (!normalized) return true;
        return `${thread.title} ${thread.preview} ${thread.id}`.toLocaleLowerCase().includes(normalized);
      })
      .sort(
        (left, right) =>
          Number(Boolean(metadata[right.id]?.pinned)) - Number(Boolean(metadata[left.id]?.pinned)) ||
          (right.recencyAt ?? right.updatedAt) - (left.recencyAt ?? left.updatedAt)
      );
  }, [filter, metadata, threads]);
  const pinned = filtered.filter((thread) => metadata[thread.id]?.pinned && !thread.archived);
  const active = filtered.filter(
    (thread) =>
      !metadata[thread.id]?.pinned &&
      !thread.archived &&
      (waitingThreadIds.has(thread.id) ||
        (thread.turns.length > 0 &&
          thread.turns[thread.turns.length - 1].status === 'inProgress'))
  );
  const recent = filtered.filter(
    (thread) =>
      !metadata[thread.id]?.pinned &&
      !thread.archived &&
      !active.some((candidate) => candidate.id === thread.id)
  );
  const archived = filtered.filter((thread) => thread.archived);
  const navigable = [...pinned, ...active, ...recent, ...archived];
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);

  const moveKeyboardFocus = (threadId: string, direction: -1 | 1) => {
    const index = navigable.findIndex((thread) => thread.id === threadId);
    const next = navigable[index + direction];
    if (!next) return;
    onSelectThread(next.id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`.thread-row[aria-selected="true"]`)
        ?.focus();
    });
  };

  if (collapsed) {
    return (
      <aside className="codex-sidebar codex-sidebar-collapsed">
        <button
          type="button"
          className="icon-button"
          aria-label="Show sidebar"
          title="Show sidebar (⌘⇧S)"
          onClick={onToggleCollapsed}
        >
          <AppIcon name="panelLeft" />
        </button>
        <button type="button" className="icon-button" aria-label="New thread" onClick={onNewThread}>
          <AppIcon name="add" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="codex-sidebar">
      <header className="sidebar-app-header">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">AT</span>
          <strong>ATController</strong>
        </div>
        <button
          type="button"
          className="icon-button subtle"
          aria-label="Hide sidebar"
          title="Hide sidebar (⌘⇧S)"
          onClick={onToggleCollapsed}
        >
          <AppIcon name="panelLeft" />
        </button>
      </header>

      <div className="sidebar-project-row">
        <label className="sr-only" htmlFor="project-switcher">Project</label>
        <select
          id="project-switcher"
          value={selectedWorkspaceId ?? ''}
          onChange={(event) => onSelectWorkspace(event.target.value)}
        >
          <option value="" disabled>{workspaces.length ? 'Select project' : 'No projects'}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <button type="button" className="icon-button" aria-label="Add project" title="Add project" onClick={onAddWorkspace}>
          <AppIcon name="add" />
        </button>
      </div>

      <button
        type="button"
        className="new-thread-button"
        onClick={onNewThread}
        disabled={!selectedWorkspace}
      >
        <AppIcon name="add" />
        <span>New thread</span>
        <kbd>⌘N</kbd>
      </button>

      <label className="sidebar-search">
        <AppIcon name="search" />
        <input
          ref={searchRef}
          type="search"
          value={filter}
          placeholder="Search threads"
          aria-label="Search threads"
          onChange={(event) => onFilterChange(event.target.value)}
        />
        <kbd>⌘⇧F</kbd>
      </label>

      <div className="thread-list-scroll">
        {workspaces.length === 0 ? (
          <div className="sidebar-empty">
            <AppIcon name="folder" size={20} />
            <strong>No projects yet</strong>
            <span>Add a local project to begin.</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty">
            <strong>{filter ? 'No matching threads' : 'No Codex threads'}</strong>
            <span>{filter ? 'Try another search.' : 'Start a thread in this project.'}</span>
          </div>
        ) : (
          <>
            <ThreadSection
              title="Pinned"
              threads={pinned}
              selectedThreadId={selectedThreadId}
              metadata={metadata}
              waitingThreadIds={waitingThreadIds}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onOpenThreadMenu={onOpenThreadMenu}
              onKeyboardMove={moveKeyboardFocus}
            />
            <ThreadSection
              title="Active"
              threads={active}
              selectedThreadId={selectedThreadId}
              metadata={metadata}
              waitingThreadIds={waitingThreadIds}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onOpenThreadMenu={onOpenThreadMenu}
              onKeyboardMove={moveKeyboardFocus}
            />
            <ThreadSection
              title="Recent"
              threads={recent}
              selectedThreadId={selectedThreadId}
              metadata={metadata}
              waitingThreadIds={waitingThreadIds}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onOpenThreadMenu={onOpenThreadMenu}
              onKeyboardMove={moveKeyboardFocus}
            />
            <ThreadSection
              title="Archived"
              threads={archived}
              selectedThreadId={selectedThreadId}
              metadata={metadata}
              waitingThreadIds={waitingThreadIds}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onOpenThreadMenu={onOpenThreadMenu}
              onKeyboardMove={moveKeyboardFocus}
            />
          </>
        )}
      </div>

      <footer className="sidebar-footer">
        <button type="button" onClick={onOpenSettings}>
          <AppIcon name="gear" />
          <span>Settings</span>
        </button>
        <button type="button" onClick={onOpenDiagnostics}>
          <span className={`runtime-dot ${connectionState}`} />
          <span>Runtime</span>
          <span className="sidebar-runtime-label">{connectionState}</span>
        </button>
      </footer>
    </aside>
  );
}
