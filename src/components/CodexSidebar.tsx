import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';

import type {
  CodexApprovalRequest,
  CodexConnectionState,
  CodexThread,
  CodexThreadUiMetadata,
  GitInfo,
  ProjectSortMode,
  Workspace
} from '../types';
import { AppIcon } from './AppIcon';

const SIDEBAR_SCROLL_KEY = 'atcontroller:project-shelf-scroll-v1';
const RECENT_THREAD_LIMIT = 7;

export type ProjectAddAction = 'openFolder' | 'importProjects' | 'cloneRepository';
export type ProjectsMenuAction =
  | 'expandAll'
  | 'collapseAll'
  | 'manageProjects'
  | 'sortCustom'
  | 'sortName'
  | 'sortRecent'
  | 'sortRunning';

interface CodexSidebarProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  threadsByWorkspace: Record<string, CodexThread[]>;
  metadata: Record<string, CodexThreadUiMetadata>;
  approvals: Record<string, CodexApprovalRequest>;
  gitInfoByWorkspace: Record<string, GitInfo | null>;
  loadingWorkspaceIds?: ReadonlySet<string>;
  filter: string;
  sortMode: ProjectSortMode;
  connectionState: CodexConnectionState;
  collapsed: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleWorkspace: (workspaceId: string, expanded: boolean) => void;
  onAddAction: (action: ProjectAddAction) => void;
  onProjectsMenuAction: (action: ProjectsMenuAction) => void;
  onNewThread: (workspaceId?: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (threadId: string) => void;
  onOpenThreadMenu: (threadId: string, x: number, y: number) => void;
  onOpenProjectMenu: (workspaceId: string, x: number, y: number) => void;
  onReorderWorkspaces: (workspaceIds: string[]) => void;
  onLocateWorkspace: (workspaceId: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onCopyWorkspacePath: (workspaceId: string) => void;
  onFilterChange: (value: string) => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onToggleCollapsed: () => void;
}

interface ProjectAggregate {
  waiting: boolean;
  running: number;
  unread: boolean;
  failed: boolean;
  mostRecent: number;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 604_800)}w`;
  return new Date(milliseconds).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

function lastTurn(thread: CodexThread) {
  return thread.turns.length ? thread.turns[thread.turns.length - 1] : undefined;
}

function isRunning(thread: CodexThread): boolean {
  return lastTurn(thread)?.status === 'inProgress' || thread.status === 'active';
}

function isFailed(thread: CodexThread): boolean {
  return lastTurn(thread)?.status === 'failed' || thread.status === 'error';
}

function normalizedSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function threadMatchesSearch(thread: CodexThread, search: string): boolean {
  if (!search) return true;
  return `${thread.title} ${thread.preview} ${thread.id} ${thread.cwd}`
    .toLocaleLowerCase()
    .includes(search);
}

function projectMatchesSearch(workspace: Workspace, search: string): boolean {
  if (!search) return true;
  return `${workspace.name} ${workspace.path} ${workspace.id}`
    .toLocaleLowerCase()
    .includes(search);
}

function monogram(workspace: Workspace): string {
  const pieces = workspace.name.trim().split(/\s+/).filter(Boolean);
  if (pieces.length === 0) return '•';
  if (pieces.length === 1) return pieces[0].slice(0, 2).toLocaleUpperCase();
  return `${pieces[0][0] ?? ''}${pieces[pieces.length - 1][0] ?? ''}`.toLocaleUpperCase();
}

function projectAggregate(
  threads: CodexThread[],
  metadata: Record<string, CodexThreadUiMetadata>,
  waitingThreadIds: ReadonlySet<string>
): ProjectAggregate {
  return threads.reduce<ProjectAggregate>(
    (aggregate, thread) => ({
      waiting: aggregate.waiting || waitingThreadIds.has(thread.id),
      running: aggregate.running + Number(!thread.archived && isRunning(thread)),
      unread: aggregate.unread || Boolean(metadata[thread.id]?.unread),
      failed: aggregate.failed || isFailed(thread),
      mostRecent: Math.max(
        aggregate.mostRecent,
        thread.recencyAt ?? thread.updatedAt ?? thread.createdAt
      )
    }),
    { waiting: false, running: 0, unread: false, failed: false, mostRecent: 0 }
  );
}

function focusAdjacentRow(current: HTMLElement, direction: -1 | 1): void {
  const rows = [
    ...document.querySelectorAll<HTMLElement>('.project-shelf-scroll [data-sidebar-row]')
  ].filter((row) => row.offsetParent !== null || row === current);
  const index = rows.indexOf(current);
  rows[index + direction]?.focus();
}

interface ThreadRowProps {
  workspaceId: string;
  thread: CodexThread;
  ui?: CodexThreadUiMetadata;
  selected: boolean;
  waiting: boolean;
  onSelect: (workspaceId: string, threadId: string) => void;
  onRename: (threadId: string) => void;
  onMenu: (threadId: string, x: number, y: number) => void;
}

const ThreadRow = memo(function ThreadRow({
  workspaceId,
  thread,
  ui,
  selected,
  waiting,
  onSelect,
  onRename,
  onMenu
}: ThreadRowProps) {
  const status = waiting
    ? { className: 'waiting', label: 'Waiting for approval' }
    : isRunning(thread)
      ? { className: 'running', label: 'Running' }
      : isFailed(thread)
        ? { className: 'failed', label: 'Failed' }
        : { className: 'idle', label: 'Idle' };
  const title = thread.title || ui?.fallbackTitle || 'New thread';

  const openMenu = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    onMenu(thread.id, bounds.left + 24, bounds.bottom - 4);
  };

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      aria-label={`${title}, ${status.label}`}
      data-sidebar-row
      data-thread-id={thread.id}
      className={`project-thread-row ${selected ? 'selected' : ''}`}
      title={thread.preview || title}
      onClick={() => onSelect(workspaceId, thread.id)}
      onDoubleClick={() => onRename(thread.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(thread.id, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusAdjacentRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          document
            .querySelector<HTMLElement>(`[data-project-row="${workspaceId}"]`)
            ?.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (event.metaKey) onRename(thread.id);
          else onSelect(workspaceId, thread.id);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          openMenu(event.currentTarget);
        }
      }}
    >
      <span className={`thread-status-dot ${status.className}`} title={status.label} />
      <span className="project-thread-copy">
        <span className="project-thread-title">
          {ui?.pinned ? <AppIcon name="pin" size={11} /> : null}
          <span>{title}</span>
        </span>
        <span className="project-thread-preview">{thread.preview || 'No messages yet'}</span>
      </span>
      <span className="project-thread-meta">
        <span>{relativeTime(thread.recencyAt ?? thread.updatedAt)}</span>
        {ui?.unread ? <i className="thread-unread-dot" aria-label="Unread output" /> : null}
      </span>
    </button>
  );
});

interface ThreadGroupProps {
  label: string;
  workspaceId: string;
  threads: CodexThread[];
  selectedThreadId: string | null;
  metadata: Record<string, CodexThreadUiMetadata>;
  waitingThreadIds: ReadonlySet<string>;
  onSelect: ThreadRowProps['onSelect'];
  onRename: ThreadRowProps['onRename'];
  onMenu: ThreadRowProps['onMenu'];
}

function ThreadGroup({
  label,
  workspaceId,
  threads,
  selectedThreadId,
  metadata,
  waitingThreadIds,
  onSelect,
  onRename,
  onMenu
}: ThreadGroupProps) {
  if (threads.length === 0) return null;
  return (
    <section
      className="project-thread-group"
      aria-label={label ? `${label} threads` : 'Recent threads'}
    >
      {label ? <h3>{label}</h3> : null}
      {threads.map((thread) => (
        <ThreadRow
          key={thread.id}
          workspaceId={workspaceId}
          thread={thread}
          ui={metadata[thread.id]}
          selected={selectedThreadId === thread.id}
          waiting={waitingThreadIds.has(thread.id)}
          onSelect={onSelect}
          onRename={onRename}
          onMenu={onMenu}
        />
      ))}
    </section>
  );
}

interface ProjectShelfProps {
  workspace: Workspace;
  threads: CodexThread[];
  metadata: Record<string, CodexThreadUiMetadata>;
  waitingThreadIds: ReadonlySet<string>;
  gitInfo: GitInfo | null;
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  search: string;
  loading: boolean;
  runtimeFailed: boolean;
  dragPlacement: { workspaceId: string; edge: 'before' | 'after' } | null;
  draggable: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onToggleWorkspace: (workspaceId: string, expanded: boolean) => void;
  onNewThread: (workspaceId?: string) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (threadId: string) => void;
  onOpenThreadMenu: (threadId: string, x: number, y: number) => void;
  onOpenProjectMenu: (workspaceId: string, x: number, y: number) => void;
  onLocateWorkspace: (workspaceId: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onCopyWorkspacePath: (workspaceId: string) => void;
  onDragStart: (workspaceId: string) => void;
  onDragOver: (workspaceId: string, edge: 'before' | 'after') => void;
  onDrop: (workspaceId: string, edge: 'before' | 'after') => void;
  onDragEnd: () => void;
}

function equalThreadReferences(left: CodexThread[], right: CodexThread[]): boolean {
  return (
    left.length === right.length &&
    left.every((thread, index) => thread === right[index])
  );
}

function areProjectShelfPropsEqual(
  previous: ProjectShelfProps,
  next: ProjectShelfProps
): boolean {
  if (
    previous.workspace !== next.workspace ||
    previous.gitInfo !== next.gitInfo ||
    previous.search !== next.search ||
    previous.loading !== next.loading ||
    previous.runtimeFailed !== next.runtimeFailed ||
    previous.draggable !== next.draggable ||
    !equalThreadReferences(previous.threads, next.threads)
  ) {
    return false;
  }
  const wasSelected = previous.selectedWorkspaceId === previous.workspace.id;
  const isSelected = next.selectedWorkspaceId === next.workspace.id;
  if (wasSelected !== isSelected) return false;
  const containsPreviousThread = previous.threads.some(
    (thread) => thread.id === previous.selectedThreadId
  );
  const containsNextThread = next.threads.some(
    (thread) => thread.id === next.selectedThreadId
  );
  if (
    (containsPreviousThread || containsNextThread) &&
    previous.selectedThreadId !== next.selectedThreadId
  ) {
    return false;
  }
  const previousDrop =
    previous.dragPlacement?.workspaceId === previous.workspace.id
      ? previous.dragPlacement.edge
      : null;
  const nextDrop =
    next.dragPlacement?.workspaceId === next.workspace.id
      ? next.dragPlacement.edge
      : null;
  if (previousDrop !== nextDrop) return false;
  return previous.threads.every(
    (thread) =>
      previous.metadata[thread.id] === next.metadata[thread.id] &&
      previous.waitingThreadIds.has(thread.id) === next.waitingThreadIds.has(thread.id)
  );
}

const ProjectShelf = memo(function ProjectShelf({
  workspace,
  threads,
  metadata,
  waitingThreadIds,
  gitInfo,
  selectedWorkspaceId,
  selectedThreadId,
  search,
  loading,
  runtimeFailed,
  dragPlacement,
  draggable,
  onSelectWorkspace,
  onToggleWorkspace,
  onNewThread,
  onSelectThread,
  onRenameThread,
  onOpenThreadMenu,
  onOpenProjectMenu,
  onLocateWorkspace,
  onRemoveWorkspace,
  onCopyWorkspacePath,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: ProjectShelfProps) {
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const aggregate = useMemo(
    () => projectAggregate(threads, metadata, waitingThreadIds),
    [metadata, threads, waitingThreadIds]
  );
  const matchingThreads = useMemo(
    () => threads.filter((thread) => threadMatchesSearch(thread, search)),
    [search, threads]
  );
  const expanded = workspace.isExpanded || Boolean(search && matchingThreads.length);
  const sorted = useMemo(
    () =>
      [...matchingThreads].sort(
        (left, right) =>
          Number(Boolean(metadata[right.id]?.pinned)) -
            Number(Boolean(metadata[left.id]?.pinned)) ||
          (right.recencyAt ?? right.updatedAt) - (left.recencyAt ?? left.updatedAt)
      ),
    [matchingThreads, metadata]
  );
  const running = sorted.filter(
    (thread) => !thread.archived && (waitingThreadIds.has(thread.id) || isRunning(thread))
  );
  const recentAll = sorted.filter(
    (thread) =>
      !thread.archived &&
      !running.some((runningThread) => runningThread.id === thread.id)
  );
  const visibleSlots = Math.max(0, RECENT_THREAD_LIMIT - running.length);
  const recent = search || showAll ? recentAll : recentAll.slice(0, visibleSlots);
  const hiddenRecentCount = Math.max(0, recentAll.length - recent.length);
  const archived = sorted.filter((thread) => thread.archived);
  const selected = selectedWorkspaceId === workspace.id;
  const openProjectMenu = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    onOpenProjectMenu(workspace.id, bounds.left + 24, bounds.bottom + 3);
  };

  const handleProjectKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusAdjacentRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (!expanded) onToggleWorkspace(workspace.id, true);
      else {
        document
          .querySelector<HTMLElement>(
            `[data-project-shelf="${workspace.id}"] .project-thread-row`
          )
          ?.focus();
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (expanded) onToggleWorkspace(workspace.id, false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onSelectWorkspace(workspace.id);
      if (!workspace.isExpanded) onToggleWorkspace(workspace.id, true);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openProjectMenu(event.currentTarget);
    }
  };

  return (
    <section
      className={[
        'project-shelf',
        selected ? 'selected' : '',
        workspace.isAvailable ? '' : 'unavailable',
        dragPlacement?.workspaceId === workspace.id
          ? `drop-${dragPlacement.edge}`
          : ''
      ].join(' ')}
      data-project-shelf={workspace.id}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOver(workspace.id, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
      }}
      onDrop={(event) => {
        if (!draggable) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onDrop(workspace.id, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
      }}
    >
      <div
        className="project-shelf-header"
        draggable={draggable}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/x-atcontroller-project', workspace.id);
          onDragStart(workspace.id);
        }}
        onDragEnd={onDragEnd}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenProjectMenu(workspace.id, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          className="project-disclosure"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${workspace.name}`}
          aria-expanded={expanded}
          onClick={() => onToggleWorkspace(workspace.id, !workspace.isExpanded)}
        >
          <AppIcon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
        <button
          type="button"
          role="treeitem"
          aria-level={1}
          aria-expanded={expanded}
          aria-selected={selected}
          data-sidebar-row
          data-project-row={workspace.id}
          className="project-shelf-main"
          title={workspace.path}
          onClick={() => {
            onSelectWorkspace(workspace.id);
            if (!workspace.isExpanded) onToggleWorkspace(workspace.id, true);
          }}
          onKeyDown={handleProjectKey}
        >
          <span
            className={`project-monogram ${
              workspace.iconPreference ? `tone-${workspace.iconPreference}` : ''
            }`}
            aria-hidden="true"
          >
            {monogram(workspace)}
          </span>
          <span className="project-shelf-copy">
            <span className="project-shelf-name">
              {workspace.isPinned ? <AppIcon name="pin" size={10} /> : null}
              <span>{workspace.name}</span>
            </span>
            <span className="project-shelf-detail">
              {!workspace.isAvailable
                ? 'Folder unavailable'
                : gitInfo?.branch
                  ? gitInfo.branch
                  : workspace.workspaceType === 'local'
                    ? 'Local folder'
                    : workspace.workspaceType}
            </span>
          </span>
          <span className="project-shelf-state">
            {aggregate.waiting ? (
              <i className="project-attention waiting" title="Waiting for approval" />
            ) : runtimeFailed || aggregate.failed ? (
              <i
                className="project-attention failed"
                title={runtimeFailed ? 'Codex runtime unavailable' : 'A thread failed'}
              />
            ) : aggregate.running > 0 ? (
              <span className="project-running-count" title={`${aggregate.running} running`}>
                <i />
                {aggregate.running}
              </span>
            ) : aggregate.unread ? (
              <i className="project-attention unread" title="Unread output" />
            ) : null}
          </span>
        </button>
        <button
          type="button"
          className="icon-button subtle project-menu-button"
          aria-label={`Actions for ${workspace.name}`}
          onClick={(event) => openProjectMenu(event.currentTarget)}
        >
          <AppIcon name="ellipsis" size={15} />
        </button>
      </div>

      {expanded ? (
        <div className="project-shelf-threads" role="group" aria-label={`${workspace.name} threads`}>
          {!workspace.isAvailable ? (
            <div className="missing-project-actions">
              <p>The saved folder can’t be found.</p>
              <div>
                <button type="button" onClick={() => onLocateWorkspace(workspace.id)}>
                  Locate Folder
                </button>
                <button type="button" onClick={() => onCopyWorkspacePath(workspace.id)}>
                  Copy Original Path
                </button>
                <button type="button" className="danger-text" onClick={() => onRemoveWorkspace(workspace.id)}>
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="project-new-thread"
                onClick={() => onNewThread(workspace.id)}
              >
                <AppIcon name="add" size={14} />
                <span>New thread</span>
              </button>
              {loading && threads.length === 0 ? (
                <div className="project-threads-loading">
                  <span />
                  Loading threads…
                </div>
              ) : threads.length === 0 ? (
                <div className="project-no-threads">
                  <span>No threads yet</span>
                  <small>Start a Codex session in this project.</small>
                </div>
              ) : (
                <>
                  <ThreadGroup
                    label="Running"
                    workspaceId={workspace.id}
                    threads={running}
                    selectedThreadId={selectedThreadId}
                    metadata={metadata}
                    waitingThreadIds={waitingThreadIds}
                    onSelect={onSelectThread}
                    onRename={onRenameThread}
                    onMenu={onOpenThreadMenu}
                  />
                  <ThreadGroup
                    label={running.length ? 'Recent' : ''}
                    workspaceId={workspace.id}
                    threads={recent}
                    selectedThreadId={selectedThreadId}
                    metadata={metadata}
                    waitingThreadIds={waitingThreadIds}
                    onSelect={onSelectThread}
                    onRename={onRenameThread}
                    onMenu={onOpenThreadMenu}
                  />
                  {hiddenRecentCount > 0 ? (
                    <button type="button" className="project-show-more" onClick={() => setShowAll(true)}>
                      Show all threads
                      <span>{hiddenRecentCount} more</span>
                    </button>
                  ) : showAll && !search && recentAll.length > visibleSlots ? (
                    <button type="button" className="project-show-more" onClick={() => setShowAll(false)}>
                      Show fewer threads
                    </button>
                  ) : null}
                  {archived.length > 0 && !search ? (
                    <button
                      type="button"
                      className="project-show-more archived"
                      aria-expanded={showArchived}
                      onClick={() => setShowArchived((visible) => !visible)}
                    >
                      {showArchived ? 'Hide archived' : 'Show archived'}
                      <span>{showArchived ? null : archived.length}</span>
                    </button>
                  ) : null}
                  {showArchived || search ? (
                    <ThreadGroup
                      label="Archived"
                      workspaceId={workspace.id}
                      threads={archived}
                      selectedThreadId={selectedThreadId}
                      metadata={metadata}
                      waitingThreadIds={waitingThreadIds}
                      onSelect={onSelectThread}
                      onRename={onRenameThread}
                      onMenu={onOpenThreadMenu}
                    />
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}, areProjectShelfPropsEqual);

function SectionPopover({
  kind,
  sortMode,
  onAddAction,
  onProjectsMenuAction,
  onClose
}: {
  kind: 'add' | 'projects';
  sortMode: ProjectSortMode;
  onAddAction: (action: ProjectAddAction) => void;
  onProjectsMenuAction: (action: ProjectsMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  const activate = (callback: () => void) => {
    callback();
    onClose();
  };
  return (
    <div
      ref={ref}
      className="sidebar-section-popover"
      role="menu"
      aria-label={kind === 'add' ? 'Add project' : 'Project organization'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          buttons[(Math.max(index, -1) + 1) % buttons.length]?.focus();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          buttons[(index <= 0 ? buttons.length : index) - 1]?.focus();
        }
      }}
    >
      {kind === 'add' ? (
        <>
          <button type="button" role="menuitem" onClick={() => activate(() => onAddAction('openFolder'))}>
            <AppIcon name="folder" />
            <span>Open Folder…</span>
            <kbd>⌘O</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => activate(() => onAddAction('importProjects'))}>
            <AppIcon name="history" />
            <span>Import Existing Projects…</span>
            <kbd>⇧⌘O</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => activate(() => onAddAction('cloneRepository'))}>
            <AppIcon name="code" />
            <span>Clone Repository…</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => activate(() => onProjectsMenuAction('expandAll'))}>
            <AppIcon name="chevronDown" />
            <span>Expand All</span>
          </button>
          <button type="button" role="menuitem" onClick={() => activate(() => onProjectsMenuAction('collapseAll'))}>
            <AppIcon name="chevronRight" />
            <span>Collapse All</span>
          </button>
          <div className="menu-label">Sort projects</div>
          {([
            ['sortCustom', 'Custom Order', 'custom'],
            ['sortName', 'Name', 'name'],
            ['sortRecent', 'Recent Activity', 'recent'],
            ['sortRunning', 'Running Threads', 'running']
          ] as const).map(([action, label, mode]) => (
            <button
              key={action}
              type="button"
              role="menuitemradio"
              aria-checked={sortMode === mode}
              onClick={() => activate(() => onProjectsMenuAction(action))}
            >
              <span className="menu-check">{sortMode === mode ? '✓' : ''}</span>
              <span>{label}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="separator"
            onClick={() => activate(() => onProjectsMenuAction('manageProjects'))}
          >
            <AppIcon name="gear" />
            <span>Manage Projects…</span>
          </button>
        </>
      )}
    </div>
  );
}

export function CodexSidebar({
  workspaces,
  selectedWorkspaceId,
  selectedThreadId,
  threadsByWorkspace,
  metadata,
  approvals,
  gitInfoByWorkspace,
  loadingWorkspaceIds = new Set<string>(),
  filter,
  sortMode,
  connectionState,
  collapsed,
  onSelectWorkspace,
  onToggleWorkspace,
  onAddAction,
  onProjectsMenuAction,
  onNewThread,
  onSelectThread,
  onRenameThread,
  onOpenThreadMenu,
  onOpenProjectMenu,
  onReorderWorkspaces,
  onLocateWorkspace,
  onRemoveWorkspace,
  onCopyWorkspacePath,
  onFilterChange,
  onOpenSettings,
  onOpenDiagnostics,
  onToggleCollapsed
}: CodexSidebarProps) {
  const [headerMenu, setHeaderMenu] = useState<'add' | 'projects' | null>(null);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dragPlacement, setDragPlacement] = useState<{
    workspaceId: string;
    edge: 'before' | 'after';
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const search = normalizedSearchText(filter);
  const waitingThreadIds = useMemo(
    () =>
      new Set(
        Object.values(approvals)
          .map((approval) => approval.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      ),
    [approvals]
  );
  const aggregates = useMemo(
    () =>
      Object.fromEntries(
        workspaces.map((workspace) => [
          workspace.id,
          projectAggregate(threadsByWorkspace[workspace.id] ?? [], metadata, waitingThreadIds)
        ])
      ) as Record<string, ProjectAggregate>,
    [metadata, threadsByWorkspace, waitingThreadIds, workspaces]
  );
  const orderedWorkspaces = useMemo(() => {
    const sorted = [...workspaces];
    sorted.sort((left, right) => {
      const pinned = Number(right.isPinned) - Number(left.isPinned);
      if (pinned) return pinned;
      if (sortMode === 'name') return left.name.localeCompare(right.name);
      if (sortMode === 'recent') {
        return aggregates[right.id].mostRecent - aggregates[left.id].mostRecent;
      }
      if (sortMode === 'running') {
        return (
          aggregates[right.id].running - aggregates[left.id].running ||
          aggregates[right.id].mostRecent - aggregates[left.id].mostRecent
        );
      }
      return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name);
    });
    return sorted;
  }, [aggregates, sortMode, workspaces]);
  const visibleWorkspaces = useMemo(
    () =>
      orderedWorkspaces.filter((workspace) => {
        if (!search) return true;
        return (
          projectMatchesSearch(workspace, search) ||
          (threadsByWorkspace[workspace.id] ?? []).some((thread) =>
            threadMatchesSearch(thread, search)
          )
        );
      }),
    [orderedWorkspaces, search, threadsByWorkspace]
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const stored = Number(window.localStorage.getItem(SIDEBAR_SCROLL_KEY));
    if (Number.isFinite(stored)) scroll.scrollTop = stored;
  }, []);

  const dropProject = (targetId: string, edge: 'before' | 'after') => {
    const sourceId = draggedWorkspaceId;
    setDragPlacement(null);
    setDraggedWorkspaceId(null);
    if (!sourceId || sourceId === targetId || sortMode !== 'custom') return;
    const source = workspaces.find((workspace) => workspace.id === sourceId);
    const target = workspaces.find((workspace) => workspace.id === targetId);
    if (!source || !target || source.isPinned !== target.isPinned) return;
    const order = orderedWorkspaces.map((workspace) => workspace.id);
    const withoutSource = order.filter((id) => id !== sourceId);
    const targetIndex = withoutSource.indexOf(targetId);
    withoutSource.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, sourceId);
    onReorderWorkspaces(withoutSource);
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
        <button
          type="button"
          className="icon-button"
          aria-label="New thread"
          onClick={() => onNewThread(selectedWorkspaceId ?? undefined)}
        >
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

      <div
        className="projects-section-header"
        onContextMenu={(event) => {
          event.preventDefault();
          setHeaderMenu('projects');
        }}
      >
        <span>Projects</span>
        <div>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="Project organization"
            title="Project organization"
            onClick={() => setHeaderMenu((current) => current === 'projects' ? null : 'projects')}
          >
            <AppIcon name="ellipsis" size={15} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="Add project"
            title="Add project"
            onClick={() => setHeaderMenu((current) => current === 'add' ? null : 'add')}
          >
            <AppIcon name="add" size={15} />
          </button>
        </div>
        {headerMenu ? (
          <SectionPopover
            kind={headerMenu}
            sortMode={sortMode}
            onAddAction={onAddAction}
            onProjectsMenuAction={onProjectsMenuAction}
            onClose={() => setHeaderMenu(null)}
          />
        ) : null}
      </div>

      <label className="sidebar-search">
        <AppIcon name="search" />
        <input
          ref={searchRef}
          type="search"
          value={filter}
          placeholder="Search projects and threads"
          aria-label="Search projects and threads"
          onChange={(event) => onFilterChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter) {
              event.preventDefault();
              onFilterChange('');
            }
          }}
        />
        {!filter ? <kbd>⌘⇧F</kbd> : null}
      </label>

      <div
        ref={scrollRef}
        className="project-shelf-scroll"
        role="tree"
        aria-label="Projects and Codex threads"
        onScroll={(event) =>
          window.localStorage.setItem(
            SIDEBAR_SCROLL_KEY,
            String(event.currentTarget.scrollTop)
          )
        }
      >
        {workspaces.length === 0 ? (
          <div className="sidebar-empty project-empty">
            <AppIcon name="folder" size={20} />
            <strong>No projects yet</strong>
            <span>Open a folder or import existing Codex projects to begin.</span>
            <button type="button" className="primary-button compact" onClick={() => onAddAction('openFolder')}>
              Open Folder
            </button>
            <button type="button" className="text-button" onClick={() => onAddAction('importProjects')}>
              Import Existing Projects
            </button>
          </div>
        ) : visibleWorkspaces.length === 0 ? (
          <div className="sidebar-empty">
            <strong>No matches</strong>
            <span>Try a project name, path, thread title, preview, or identifier.</span>
          </div>
        ) : (
          visibleWorkspaces.map((workspace) => (
            <ProjectShelf
              key={workspace.id}
              workspace={workspace}
              threads={threadsByWorkspace[workspace.id] ?? []}
              metadata={metadata}
              waitingThreadIds={waitingThreadIds}
              gitInfo={gitInfoByWorkspace[workspace.id] ?? null}
              selectedWorkspaceId={selectedWorkspaceId}
              selectedThreadId={selectedThreadId}
              search={search}
              loading={loadingWorkspaceIds.has(workspace.id)}
              runtimeFailed={
                connectionState === 'failed' || connectionState === 'degraded'
              }
              dragPlacement={dragPlacement}
              draggable={sortMode === 'custom'}
              onSelectWorkspace={onSelectWorkspace}
              onToggleWorkspace={onToggleWorkspace}
              onNewThread={onNewThread}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onOpenThreadMenu={onOpenThreadMenu}
              onOpenProjectMenu={onOpenProjectMenu}
              onLocateWorkspace={onLocateWorkspace}
              onRemoveWorkspace={onRemoveWorkspace}
              onCopyWorkspacePath={onCopyWorkspacePath}
              onDragStart={setDraggedWorkspaceId}
              onDragOver={(workspaceId, edge) => setDragPlacement({ workspaceId, edge })}
              onDrop={dropProject}
              onDragEnd={() => {
                setDraggedWorkspaceId(null);
                setDragPlacement(null);
              }}
            />
          ))
        )}
      </div>

      <div className="sidebar-global-actions">
        <button
          type="button"
          disabled={!selectedWorkspaceId}
          onClick={() => onNewThread(selectedWorkspaceId ?? undefined)}
        >
          <AppIcon name="add" />
          <span>New thread</span>
          <kbd>⌘N</kbd>
        </button>
        <button type="button" onClick={() => onAddAction('openFolder')}>
          <AppIcon name="folder" />
          <span>Open folder</span>
          <kbd>⌘O</kbd>
        </button>
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
