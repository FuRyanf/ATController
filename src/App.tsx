import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { confirm, open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AppIcon } from './components/AppIcon';
import {
  CodexSidebar,
  type ProjectAddAction,
  type ProjectsMenuAction
} from './components/CodexSidebar';
import { CloneRepositoryDialog } from './components/CloneRepositoryDialog';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ControlCenterDialog } from './components/ControlCenterDialog';
import { ConversationTimeline } from './components/ConversationTimeline';
import { InspectorPanel } from './components/InspectorPanel';
import { ManageProjectsDialog } from './components/ManageProjectsDialog';
import {
  MessageComposer,
  type ComposerAttachment
} from './components/MessageComposer';
import {
  ProjectContextMenu,
  type ProjectMenuAction
} from './components/ProjectContextMenu';
import { ProjectIconDialog } from './components/ProjectIconDialog';
import { ProjectImportDialog } from './components/ProjectImportDialog';
import {
  ThreadContextMenu,
  type ThreadMenuAction
} from './components/ThreadContextMenu';
import { ThreadHeader } from './components/ThreadHeader';
import * as apiModule from './lib/api';
import {
  applyAppearanceMode,
  normalizeAppearanceMode,
  persistAppearanceMode
} from './lib/appearance';
import {
  bootstrapCodexRuntime,
  readStableRuntimeDiagnostics
} from './lib/runtimeBootstrap';
import { codexStore, useCodexStore } from './stores/codexStore';
import type {
  CodexApprovalRequest,
  CodexDiscoveredProject,
  CodexEvent,
  CodexRuntimeCatalog,
  CodexSkill,
  CodexThread,
  CodexThreadUiMetadata,
  ComposerInput,
  GitBranchEntry,
  GitInfo,
  GitWorkspaceStatus,
  PermissionMode,
  ProjectSortMode,
  ResumeCommandRequest,
  ServerRequestResponse,
  Settings,
  ThreadPreferences,
  Workspace
} from './types';

const api = apiModule.api;
const ProjectTerminalShelf = lazy(async () => ({
  default: (await import('./components/ProjectTerminalShelf')).ProjectTerminalShelf
}));
const SELECTED_WORKSPACE_KEY = 'atcontroller:selected-workspace-v2';
const SELECTED_THREAD_KEY = 'atcontroller:selected-codex-thread-v2';
const SIDEBAR_WIDTH_KEY = 'atcontroller:sidebar-width-v2';
const INSPECTOR_OPEN_KEY = 'atcontroller:inspector-open-v2';
const PROJECT_SORT_KEY = 'atcontroller:project-sort-v1';

interface Toast {
  id: string;
  message: string;
  tone: 'neutral' | 'success' | 'error';
}

interface ContextMenuState {
  threadId: string;
  x: number;
  y: number;
}

interface RenameState {
  threadId: string;
  value: string;
}

interface ProjectContextMenuState {
  workspaceId: string;
  x: number;
  y: number;
}

interface ProjectRenameState {
  workspaceId: string;
  value: string;
}

interface ProjectTerminalTarget {
  workspaceId: string;
  cwd: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function releaseTauriListener(stop: () => void): void {
  try {
    const result = (stop as unknown as () => void | Promise<void>)();
    if (result && typeof result === 'object' && 'catch' in result) {
      void result.catch(() => undefined);
    }
  } catch {
    // Development hot reload can invalidate Tauri's listener registry first.
  }
}

function defaultSettings(): Settings {
  return {
    appearanceMode: 'system',
    defaultNewThreadFullAccess: true,
    defaultPermissionMode: 'fullAccess',
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultServiceTier: null,
    resumeTerminalBehavior: 'insertForReview',
    commandEnterToSend: true,
    taskCompletionAlerts: true
  };
}

function preferencesFromSettings(settings: Settings): ThreadPreferences {
  return {
    permissionMode:
      settings.defaultPermissionMode ??
      (settings.defaultNewThreadFullAccess === false ? 'workspaceAccess' : 'fullAccess'),
    model: settings.defaultModel ?? null,
    reasoningEffort: settings.defaultReasoningEffort ?? null,
    serviceTier: settings.defaultServiceTier ?? null
  };
}

function preferencesFromMetadata(
  metadata: CodexThreadUiMetadata | undefined,
  settings: Settings
): ThreadPreferences {
  if (!metadata) return preferencesFromSettings(settings);
  return {
    permissionMode: metadata.permissionMode,
    model: metadata.requestedModel ?? null,
    reasoningEffort: metadata.requestedReasoningEffort ?? null,
    serviceTier: metadata.requestedServiceTier ?? null
  };
}

function createUiMetadata(
  workspace: Workspace,
  thread: CodexThread,
  preferences: ThreadPreferences
): CodexThreadUiMetadata {
  const timestamp = nowIso();
  return {
    threadId: thread.id,
    workspaceId: workspace.id,
    fallbackTitle: thread.title || 'New thread',
    pinned: false,
    unread: false,
    archived: thread.archived,
    draft: '',
    promptHistory: [],
    permissionMode: preferences.permissionMode,
    requestedModel: preferences.model ?? null,
    requestedReasoningEffort: preferences.reasoningEffort ?? null,
    requestedServiceTier: preferences.serviceTier ?? null,
    lastViewedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function workspaceMatchesThread(
  workspace: Workspace,
  thread: CodexThread,
  metadata?: CodexThreadUiMetadata
): boolean {
  if (metadata?.workspaceId === workspace.id) return true;
  const clean = (value: string) => value.replace(/\/+$/, '');
  return Boolean(thread.cwd) && clean(thread.cwd) === clean(workspace.path);
}

function lastRunningTurn(thread?: CodexThread) {
  if (!thread) return undefined;
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    if (thread.turns[index].status === 'inProgress') return thread.turns[index];
  }
  return undefined;
}

function attachmentFromPath(path: string, workspacePath: string): ComposerAttachment {
  const extension = path.split('.').pop()?.toLocaleLowerCase() ?? '';
  const kind = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'].includes(extension)
    ? 'image'
    : 'file';
  const root = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return {
    id: crypto.randomUUID(),
    name: path.split('/').pop() || path,
    kind,
    path,
    outsideWorkspace: path !== workspacePath && !path.startsWith(root)
  };
}

function EmptyWorkspace({
  kind,
  detail,
  action,
  onAction
}: {
  kind: 'folder' | 'warning' | 'history' | 'info';
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <main className="application-empty-state">
      <div className="empty-state-icon"><AppIcon name={kind} size={24} /></div>
      <h1>{detail}</h1>
      <p>ATController uses the locally installed official Codex runtime through its structured app server.</p>
      <button type="button" className="primary-button" onClick={onAction}>{action}</button>
    </main>
  );
}

export default function App() {
  const codex = useCodexStore((snapshot) => snapshot);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => window.localStorage.getItem(SELECTED_WORKSPACE_KEY)
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadIdsByWorkspace, setThreadIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [loadingWorkspaceIds, setLoadingWorkspaceIds] = useState<Set<string>>(new Set());
  const [metadata, setMetadata] = useState<Record<string, CodexThreadUiMetadata>>({});
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [catalog, setCatalog] = useState<CodexRuntimeCatalog | null>(null);
  const [dataRoot, setDataRoot] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [recoveringThread, setRecoveringThread] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [attachmentsByThread, setAttachmentsByThread] = useState<Record<string, ComposerAttachment[]>>({});
  const [runtimeSkills, setRuntimeSkills] = useState<CodexSkill[]>([]);
  const [skillsByThread, setSkillsByThread] = useState<Record<string, CodexSkill[]>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] =
    useState<ProjectContextMenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [projectRename, setProjectRename] = useState<ProjectRenameState | null>(null);
  const [projectIconWorkspaceId, setProjectIconWorkspaceId] = useState<string | null>(null);
  const [projectImportOpen, setProjectImportOpen] = useState(false);
  const [discoveredProjects, setDiscoveredProjects] = useState<CodexDiscoveredProject[]>([]);
  const [projectImportLoading, setProjectImportLoading] = useState(false);
  const [projectImportBusy, setProjectImportBusy] = useState(false);
  const [projectImportError, setProjectImportError] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneDestinationParent, setCloneDestinationParent] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [manageProjectsOpen, setManageProjectsOpen] = useState(false);
  const [managedWorkspaceId, setManagedWorkspaceId] = useState<string | null>(null);
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>(() => {
    const stored = window.localStorage.getItem(PROJECT_SORT_KEY);
    return stored === 'name' || stored === 'recent' || stored === 'running'
      ? stored
      : 'custom';
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [controlCenter, setControlCenter] = useState<'settings' | 'diagnostics' | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<Record<string, unknown> | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) ? Math.min(420, Math.max(236, stored)) : 292;
  });
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.localStorage.getItem(INSPECTOR_OPEN_KEY) !== 'false'
  );
  const [projectTerminalOpen, setProjectTerminalOpen] = useState(false);
  const [projectTerminalTarget, setProjectTerminalTarget] =
    useState<ProjectTerminalTarget | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitInfoByWorkspace, setGitInfoByWorkspace] = useState<Record<string, GitInfo | null>>({});
  const [gitStatus, setGitStatus] = useState<GitWorkspaceStatus | null>(null);
  const [gitBranches, setGitBranches] = useState<GitBranchEntry[]>([]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const projectTerminalWorkspace = projectTerminalTarget
    ? workspaces.find((workspace) => workspace.id === projectTerminalTarget.workspaceId) ?? null
    : null;
  const selectedThread = selectedThreadId ? codex.threads[selectedThreadId] : undefined;
  const selectedSession =
    selectedThreadId && !selectedThread?.archived
      ? codex.sessions[selectedThreadId]
      : undefined;
  const selectedMetadata = selectedThreadId ? metadata[selectedThreadId] : undefined;
  const selectedPreferences = preferencesFromMetadata(selectedMetadata, settings);
  const selectedApprovals = Object.values(codex.approvals).filter(
    (approval) => approval.threadId === selectedThreadId
  );
  const selectedRunningTurn = lastRunningTurn(selectedThread);
  const threadsByWorkspace = useMemo(() => {
    const result: Record<string, CodexThread[]> = Object.fromEntries(
      workspaces.map((workspace) => [workspace.id, []])
    );
    const assigned = new Set<string>();
    for (const workspace of workspaces) {
      const ids = threadIdsByWorkspace[workspace.id] ?? [];
      for (const threadId of ids) {
        const thread = codex.threads[threadId];
        if (thread && !assigned.has(thread.id)) {
          result[workspace.id].push(thread);
          assigned.add(thread.id);
        }
      }
    }
    for (const thread of Object.values(codex.threads)) {
      if (assigned.has(thread.id)) continue;
      const workspace = workspaces.find((candidate) =>
        workspaceMatchesThread(candidate, thread, metadata[thread.id])
      );
      if (!workspace) continue;
      result[workspace.id].push(thread);
      assigned.add(thread.id);
    }
    for (const threads of Object.values(result)) {
      threads.sort(
        (left, right) =>
          (right.recencyAt ?? right.updatedAt) - (left.recencyAt ?? left.updatedAt)
      );
    }
    return result;
  }, [codex.threads, metadata, threadIdsByWorkspace, workspaces]);
  const visibleThreads = selectedWorkspaceId
    ? threadsByWorkspace[selectedWorkspaceId] ?? []
    : [];
  const allSidebarThreads = useMemo(
    () => Object.values(threadsByWorkspace).flat(),
    [threadsByWorkspace]
  );
  const loadingThreads = selectedWorkspaceId
    ? loadingWorkspaceIds.has(selectedWorkspaceId)
    : false;
  const connected = codex.diagnostics?.connectionState === 'ready';
  const currentAttachments = selectedThreadId ? attachmentsByThread[selectedThreadId] ?? [] : [];
  const currentSkills = selectedThreadId ? skillsByThread[selectedThreadId] ?? [] : [];

  const selectedWorkspaceRef = useRef<Workspace | undefined>(selectedWorkspace);
  const workspacesRef = useRef<Workspace[]>(workspaces);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const metadataRef = useRef(metadata);
  const settingsRef = useRef(settings);
  const connectionStateRef = useRef(codex.diagnostics?.connectionState ?? 'stopped');
  const runtimeEventRevision = useRef(0);
  const gitRefreshTimer = useRef<number | null>(null);
  const threadRefreshSequence = useRef<Record<string, number>>({});
  const restoredWorkspace = useRef<string | null>(null);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);
  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);
  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);
  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    const mode = normalizeAppearanceMode(settings.appearanceMode);
    applyAppearanceMode(mode);
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyAppearanceMode('system');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [settings.appearanceMode]);
  useEffect(() => {
    const unreadCount = Object.values(metadata).filter((item) => item.unread).length;
    void api.setAppBadgeCount(unreadCount > 0 ? unreadCount : null).catch(() => undefined);
  }, [metadata]);

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, tone }].slice(-4));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3_500);
  }, []);

  const removeThreadFromUi = useCallback((threadId: string) => {
    codexStore.removeThread(threadId);
    setThreadIdsByWorkspace((current) =>
      Object.fromEntries(
        Object.entries(current).map(([workspaceId, threadIds]) => [
          workspaceId,
          threadIds.filter((candidate) => candidate !== threadId)
        ])
      )
    );
    const nextMetadata = { ...metadataRef.current };
    delete nextMetadata[threadId];
    metadataRef.current = nextMetadata;
    setMetadata(nextMetadata);
    setAttachmentsByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setSkillsByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (selectedThreadIdRef.current === threadId) {
      selectedThreadIdRef.current = null;
      setSelectedThreadId(null);
      setThreadError(null);
      window.localStorage.removeItem(SELECTED_THREAD_KEY);
    }
  }, []);

  const copyText = useCallback(
    async (value: string, label: string) => {
      if (!value) return;
      try {
        await api.writeTextToClipboard(value);
        showToast(`${label} copied`, 'success');
      } catch {
        await navigator.clipboard.writeText(value);
        showToast(`${label} copied`, 'success');
      }
    },
    [showToast]
  );

  const applyWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaces((current) => {
      const next = current.some((candidate) => candidate.id === workspace.id)
        ? current.map((candidate) => candidate.id === workspace.id ? workspace : candidate)
        : [...current, workspace];
      workspacesRef.current = next;
      return next;
    });
  }, []);

  const findWorkspaceForThread = useCallback((threadId: string, thread?: CodexThread) => {
    const ui = metadataRef.current[threadId];
    if (ui) {
      const byMetadata = workspacesRef.current.find(
        (workspace) => workspace.id === ui.workspaceId
      );
      if (byMetadata) return byMetadata;
    }
    const known = thread ?? codexStore.getSnapshot().threads[threadId];
    return known
      ? workspacesRef.current.find((workspace) => workspaceMatchesThread(workspace, known, ui))
      : undefined;
  }, []);

  const refreshGit = useCallback(async (workspace?: Workspace) => {
    const target = workspace ?? selectedWorkspaceRef.current;
    if (!target) {
      setGitInfo(null);
      setGitStatus(null);
      setGitBranches([]);
      return;
    }
    try {
      const [info, status, branches] = await Promise.all([
        api.getGitInfo(target.path),
        api.gitWorkspaceStatus(target.path),
        api.gitListBranches(target.path)
      ]);
      setGitInfoByWorkspace((current) => ({ ...current, [target.id]: info }));
      if (selectedWorkspaceRef.current?.id === target.id) {
        setGitInfo(info);
        setGitStatus(status);
        setGitBranches(branches);
      }
    } catch {
      setGitInfoByWorkspace((current) => ({ ...current, [target.id]: null }));
      if (selectedWorkspaceRef.current?.id === target.id) {
        setGitInfo(null);
        setGitStatus(null);
        setGitBranches([]);
      }
    }
  }, []);

  const refreshProjectGit = useCallback(async (workspace: Workspace) => {
    if (!workspace.isAvailable) {
      setGitInfoByWorkspace((current) => ({ ...current, [workspace.id]: null }));
      return;
    }
    try {
      const info = await api.getGitInfo(workspace.path);
      setGitInfoByWorkspace((current) => ({ ...current, [workspace.id]: info }));
    } catch {
      setGitInfoByWorkspace((current) => ({ ...current, [workspace.id]: null }));
    }
  }, []);

  const scheduleGitRefresh = useCallback(() => {
    if (gitRefreshTimer.current != null) window.clearTimeout(gitRefreshTimer.current);
    gitRefreshTimer.current = window.setTimeout(() => {
      void refreshGit();
      gitRefreshTimer.current = null;
    }, 250);
  }, [refreshGit]);

  const persistMetadata = useCallback(
    async (next: CodexThreadUiMetadata) => {
      setMetadata((current) => ({ ...current, [next.threadId]: next }));
      try {
        const saved = await api.saveCodexThreadUiMetadata(next);
        setMetadata((current) => ({ ...current, [saved.threadId]: saved }));
      } catch (error) {
        showToast(`Could not save thread UI state: ${String(error)}`, 'error');
      }
    },
    [showToast]
  );

  const updateMetadata = useCallback(
    (
      threadId: string,
      update: (current: CodexThreadUiMetadata) => CodexThreadUiMetadata
    ) => {
      const current = metadataRef.current[threadId];
      if (!current) return;
      const next = update(current);
      metadataRef.current = { ...metadataRef.current, [threadId]: next };
      void persistMetadata(next);
    },
    [persistMetadata]
  );

  const refreshThreads = useCallback(
    async (workspace: Workspace, searchTerm?: string) => {
      const refreshSequence = (threadRefreshSequence.current[workspace.id] ?? 0) + 1;
      threadRefreshSequence.current[workspace.id] = refreshSequence;
      setLoadingWorkspaceIds((current) => {
        const next = new Set(current);
        next.add(workspace.id);
        return next;
      });
      if (selectedWorkspaceRef.current?.id === workspace.id) {
        setThreadError(null);
      }
      try {
        if (!workspace.isAvailable) {
          setThreadIdsByWorkspace((current) => ({ ...current, [workspace.id]: [] }));
          return;
        }
        const listAll = async (archived: boolean) => {
          const data: CodexThread[] = [];
          let cursor: string | null = null;
          for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
            const page = await api.listCodexThreads({
              workspacePath: workspace.path,
              archived,
              searchTerm: searchTerm || null,
              cursor,
              limit: 100
            });
            data.push(...page.data);
            cursor = page.nextCursor ?? null;
            if (!cursor) break;
          }
          return data;
        };
        const [activePage, archivedPage, uiMetadata] = await Promise.all([
          listAll(false),
          listAll(true),
          api.listCodexThreadUiMetadata(workspace.id)
        ]);
        if (refreshSequence !== threadRefreshSequence.current[workspace.id]) {
          return;
        }
        codexStore.replaceWorkspaceThreads(workspace.path, false, activePage);
        codexStore.replaceWorkspaceThreads(workspace.path, true, archivedPage);
        const archivedIds = new Set(archivedPage.map((thread) => thread.id));
        const uiMap = Object.fromEntries(
          uiMetadata.map((item) => [
            item.threadId,
            {
              ...item,
              archived: archivedIds.has(item.threadId)
            }
          ])
        );
        metadataRef.current = { ...metadataRef.current, ...uiMap };
        setMetadata((current) => ({ ...current, ...uiMap }));
        setThreadIdsByWorkspace((current) => ({
          ...current,
          [workspace.id]: [...new Set([...activePage, ...archivedPage].map((thread) => thread.id))]
        }));
      } catch (error) {
        if (
          refreshSequence === threadRefreshSequence.current[workspace.id] &&
          selectedWorkspaceRef.current?.id === workspace.id
        ) {
          setThreadError(String(error));
        }
      } finally {
        if (refreshSequence === threadRefreshSequence.current[workspace.id]) {
          setLoadingWorkspaceIds((current) => {
            const next = new Set(current);
            next.delete(workspace.id);
            return next;
          });
        }
      }
    },
    []
  );

  const ensureMetadata = useCallback(
    async (
      workspace: Workspace,
      thread: CodexThread,
      preferences: ThreadPreferences
    ): Promise<CodexThreadUiMetadata> => {
      const existing = metadataRef.current[thread.id];
      if (existing?.workspaceId === workspace.id) {
        if (existing.archived === thread.archived) return existing;
        const synchronized = {
          ...existing,
          archived: thread.archived,
          updatedAt: nowIso()
        };
        metadataRef.current = {
          ...metadataRef.current,
          [thread.id]: synchronized
        };
        setMetadata((current) => ({ ...current, [thread.id]: synchronized }));
        try {
          return await api.saveCodexThreadUiMetadata(synchronized);
        } catch {
          return synchronized;
        }
      }
      if (existing) {
        const reassociated = {
          ...existing,
          workspaceId: workspace.id,
          updatedAt: nowIso()
        };
        metadataRef.current = {
          ...metadataRef.current,
          [thread.id]: reassociated
        };
        setMetadata((current) => ({ ...current, [thread.id]: reassociated }));
        try {
          const saved = await api.saveCodexThreadUiMetadata(reassociated);
          metadataRef.current = { ...metadataRef.current, [thread.id]: saved };
          setMetadata((current) => ({ ...current, [thread.id]: saved }));
          return saved;
        } catch {
          return reassociated;
        }
      }
      const created = createUiMetadata(workspace, thread, preferences);
      metadataRef.current = { ...metadataRef.current, [thread.id]: created };
      setMetadata((current) => ({ ...current, [thread.id]: created }));
      try {
        const saved = await api.saveCodexThreadUiMetadata(created);
        metadataRef.current = { ...metadataRef.current, [thread.id]: saved };
        setMetadata((current) => ({ ...current, [thread.id]: saved }));
        return saved;
      } catch {
        return created;
      }
    },
    []
  );

  const openThread = useCallback(
    async (threadId: string, workspaceOverride?: Workspace) => {
      const existing = codexStore.getSnapshot().threads[threadId];
      const workspace =
        workspaceOverride ?? findWorkspaceForThread(threadId, existing);
      if (!workspace) {
        setThreadError('ATController could not associate this Codex thread with a project.');
        return;
      }
      if (!workspace.isAvailable) {
        setThreadError(`The project folder for ${workspace.name} is unavailable.`);
        return;
      }
      if (selectedWorkspaceRef.current?.id !== workspace.id) {
        selectedWorkspaceRef.current = workspace;
        setSelectedWorkspaceId(workspace.id);
        window.localStorage.setItem(SELECTED_WORKSPACE_KEY, workspace.id);
      }
      if (!workspace.isExpanded) {
        const expanded = { ...workspace, isExpanded: true };
        selectedWorkspaceRef.current = expanded;
        applyWorkspace(expanded);
        void api
          .updateWorkspace(workspace.id, { isExpanded: true, markOpened: true })
          .then(applyWorkspace)
          .catch(() => undefined);
      }
      setSelectedThreadId(threadId);
      selectedThreadIdRef.current = threadId;
      codexStore.setActiveThread(threadId);
      window.localStorage.setItem(
        SELECTED_THREAD_KEY,
        JSON.stringify({ workspaceId: workspace.id, threadId })
      );
      setRecoveringThread(true);
      setThreadError(null);
      const archived = existing?.archived === true;
      const preferences = preferencesFromMetadata(
        metadataRef.current[threadId],
        settingsRef.current
      );
      try {
        const snapshot = codexStore.getSnapshot();
        let hydrated = snapshot.threads[threadId] ?? existing;
        if (archived) {
          hydrated = {
            ...(await api.readCodexThread(threadId, true)),
            archived: true
          };
          codexStore.upsertThreads([hydrated]);
        } else if (!snapshot.sessions[threadId]) {
          // `thread/resume` includes full turns. Reading the thread first would
          // transfer and normalize the complete history twice, which is
          // especially expensive for long-running Codex sessions.
          const session = await api.resumeCodexThread(
            workspace.path,
            threadId,
            preferences
          );
          hydrated = session.thread;
          codexStore.setSession(session);
        }
        if (!hydrated) {
          throw new Error('Codex returned no thread history');
        }
        const ui = await ensureMetadata(workspace, hydrated, preferences);
        if (ui.unread || !ui.lastViewedAt) {
          void persistMetadata({
            ...ui,
            unread: false,
            lastViewedAt: nowIso(),
            updatedAt: nowIso()
          });
        }
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`)
            ?.scrollIntoView({ block: 'nearest' })
        );
      } catch (error) {
        if (existing) codexStore.upsertThreads([existing]);
        setThreadError(`Unable to resume this Codex thread: ${String(error)}`);
      } finally {
        setRecoveringThread(false);
      }
    },
    [applyWorkspace, ensureMetadata, findWorkspaceForThread, persistMetadata]
  );

  const createThread = useCallback(async (workspaceOverride?: Workspace) => {
    const workspace = workspaceOverride ?? selectedWorkspaceRef.current;
    if (!workspace) {
      showToast('Add a local project first', 'error');
      return;
    }
    if (!workspace.isAvailable) {
      showToast(`Locate the folder for ${workspace.name} before starting a thread`, 'error');
      return;
    }
    if (selectedWorkspaceRef.current?.id !== workspace.id) {
      selectedWorkspaceRef.current = workspace;
      setSelectedWorkspaceId(workspace.id);
      window.localStorage.setItem(SELECTED_WORKSPACE_KEY, workspace.id);
    }
    if (!workspace.isExpanded) {
      void api
        .updateWorkspace(workspace.id, { isExpanded: true, markOpened: true })
        .then(applyWorkspace)
        .catch(() => undefined);
    }
    setThreadError(null);
    setRecoveringThread(true);
    try {
      const preferences = preferencesFromSettings(settingsRef.current);
      const session = await api.startCodexThread(workspace.path, preferences, false);
      codexStore.setSession(session);
      setThreadIdsByWorkspace((current) => ({
        ...current,
        [workspace.id]: current[workspace.id]?.includes(session.thread.id)
          ? current[workspace.id]
          : [session.thread.id, ...(current[workspace.id] ?? [])]
      }));
      await ensureMetadata(workspace, session.thread, preferences);
      setSelectedThreadId(session.thread.id);
      selectedThreadIdRef.current = session.thread.id;
      codexStore.setActiveThread(session.thread.id);
      window.localStorage.setItem(
        SELECTED_THREAD_KEY,
        JSON.stringify({ workspaceId: workspace.id, threadId: session.thread.id })
      );
      window.dispatchEvent(new Event('atcontroller:focus-composer'));
    } catch (error) {
      setThreadError(`Could not create a Codex thread: ${String(error)}`);
    } finally {
      setRecoveringThread(false);
    }
  }, [applyWorkspace, ensureMetadata, showToast]);

  const selectProject = useCallback(
    (workspaceId: string) => {
      const workspace = workspacesRef.current.find(
        (candidate) => candidate.id === workspaceId
      );
      if (!workspace) return;
      const currentThreadId = selectedThreadIdRef.current;
      const currentThread = currentThreadId
        ? codexStore.getSnapshot().threads[currentThreadId]
        : undefined;
      if (
        currentThreadId &&
        (!currentThread ||
          !workspaceMatchesThread(
            workspace,
            currentThread,
            metadataRef.current[currentThreadId]
          ))
      ) {
        selectedThreadIdRef.current = null;
        setSelectedThreadId(null);
        codexStore.setActiveThread(null);
      }
      selectedWorkspaceRef.current = workspace;
      setSelectedWorkspaceId(workspace.id);
      window.localStorage.setItem(SELECTED_WORKSPACE_KEY, workspace.id);
      void api
        .updateWorkspace(workspace.id, {
          isExpanded: workspace.isExpanded ? undefined : true,
          markOpened: true
        })
        .then(applyWorkspace)
        .catch(() => undefined);
    },
    [applyWorkspace]
  );

  const applyRuntimeDiagnostics = useCallback(
    (diagnostics: Parameters<typeof codexStore.setDiagnostics>[0], refreshCatalog = true) => {
      const previous = connectionStateRef.current;
      connectionStateRef.current = diagnostics.connectionState;
      codexStore.setDiagnostics(diagnostics);
      if (diagnostics.connectionState !== 'ready') return;

      setFatalError(null);
      if (refreshCatalog) {
        void api.getCodexCatalog().then(setCatalog).catch(() => undefined);
      }
      if (
        ['degraded', 'restarting', 'failed'].includes(previous) &&
        selectedThreadIdRef.current
      ) {
        void openThread(selectedThreadIdRef.current);
      }
    },
    [openThread]
  );

  const reconcileRuntimeDiagnostics = useCallback(async () => {
    const diagnostics = await readStableRuntimeDiagnostics(
      api.getCodexDiagnostics,
      () => runtimeEventRevision.current
    );
    applyRuntimeDiagnostics(diagnostics);
  }, [applyRuntimeDiagnostics]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.getSettings(),
      api.listWorkspaces(),
      api.getAppStorageRoot(),
      bootstrapCodexRuntime({
        getCatalog: api.getCodexCatalog,
        getDiagnostics: api.getCodexDiagnostics
      })
    ]).then((results) => {
      if (cancelled) return;
      const [settingsResult, workspacesResult, rootResult, runtimeResult] = results;
      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
        const appearance = normalizeAppearanceMode(settingsResult.value.appearanceMode);
        applyAppearanceMode(appearance);
        persistAppearanceMode(appearance);
      }
      if (workspacesResult.status === 'fulfilled') {
        const locals = workspacesResult.value;
        workspacesRef.current = locals;
        setWorkspaces(locals);
        setSelectedWorkspaceId((current) => {
          const next = locals.some((workspace) => workspace.id === current)
            ? current
            : locals[0]?.id ?? null;
          if (next) window.localStorage.setItem(SELECTED_WORKSPACE_KEY, next);
          return next;
        });
      } else {
        setFatalError(`Could not read ATController projects: ${String(workspacesResult.reason)}`);
      }
      if (rootResult.status === 'fulfilled') setDataRoot(rootResult.value);
      if (runtimeResult.status === 'fulfilled') {
        setCatalog(runtimeResult.value.catalog);
        applyRuntimeDiagnostics(runtimeResult.value.diagnostics, false);
      } else {
        setFatalError(`Codex app server is unavailable: ${String(runtimeResult.reason)}`);
        void reconcileRuntimeDiagnostics().catch(() => undefined);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void apiModule.onCodexEvent((event: CodexEvent) => {
      const threadWasDeleted = event.kind === 'threadDeleted' && Boolean(event.threadId);
      if (threadWasDeleted) {
        removeThreadFromUi(event.threadId!);
      }
      codexStore.queueEvent(event);
      const eventThread =
        event.thread ??
        (event.threadId ? codexStore.getSnapshot().threads[event.threadId] : undefined);
      const eventWorkspace =
        event.threadId || eventThread
          ? findWorkspaceForThread(event.threadId ?? eventThread!.id, eventThread)
          : undefined;
      if (!threadWasDeleted && eventThread && eventWorkspace) {
        setThreadIdsByWorkspace((current) => ({
          ...current,
          [eventWorkspace.id]: current[eventWorkspace.id]?.includes(eventThread.id)
            ? current[eventWorkspace.id]
            : [eventThread.id, ...(current[eventWorkspace.id] ?? [])]
        }));
      }
      if (
        event.kind === 'turnCompleted' &&
        event.threadId &&
        (event.threadId !== selectedThreadIdRef.current || document.hidden)
      ) {
        const completedThread =
          event.thread ?? codexStore.getSnapshot().threads[event.threadId];
        const workspace = findWorkspaceForThread(event.threadId, completedThread);
        const markUnread = async () => {
          const existing = metadataRef.current[event.threadId!];
          if (existing) {
            updateMetadata(event.threadId!, (current) => ({
              ...current,
              unread: true,
              updatedAt: nowIso()
            }));
          } else if (
            workspace &&
            completedThread &&
            workspaceMatchesThread(workspace, completedThread)
          ) {
            const created = await ensureMetadata(
              workspace,
              completedThread,
              preferencesFromSettings(settingsRef.current)
            );
            await persistMetadata({ ...created, unread: true, updatedAt: nowIso() });
          }
        };
        void markUnread();
        if (settingsRef.current.taskCompletionAlerts !== false) {
          const title = completedThread?.title || 'Codex thread';
          const location = workspace?.name ? ` in ${workspace.name}` : '';
          void api
            .sendDesktopNotification('Codex finished', `${title} completed${location}.`)
            .catch(() => undefined);
        }
      }
      if (
        event.kind === 'fileChangeUpdated' ||
        event.kind === 'turnDiffUpdated' ||
        event.item?.kind === 'fileChange'
      ) {
        if (eventWorkspace?.id === selectedWorkspaceRef.current?.id) scheduleGitRefresh();
        else if (eventWorkspace) void refreshProjectGit(eventWorkspace);
      }
      if (
        event.kind === 'accountUpdated' ||
        event.kind === 'rateLimitsUpdated' ||
        event.kind === 'accountLoginCompleted'
      ) {
        void api.getCodexCatalog().then(setCatalog).catch(() => undefined);
      }
    }).then((stop) => (disposed ? releaseTauriListener(stop) : unlisten.push(stop)));
    void apiModule
      .onCodexRuntimeState((diagnostics) => {
        runtimeEventRevision.current += 1;
        applyRuntimeDiagnostics(diagnostics);
      })
      .then((stop) => {
        if (disposed) {
          releaseTauriListener(stop);
          return;
        }
        unlisten.push(stop);
        void reconcileRuntimeDiagnostics().catch(() => undefined);
      });
    return () => {
      disposed = true;
      unlisten.forEach(releaseTauriListener);
    };
  }, [
    ensureMetadata,
    applyRuntimeDiagnostics,
    findWorkspaceForThread,
    persistMetadata,
    reconcileRuntimeDiagnostics,
    removeThreadFromUi,
    refreshProjectGit,
    scheduleGitRefresh,
    updateMetadata
  ]);

  useEffect(() => {
    const refreshVisibleProject = () => {
      const workspace = selectedWorkspaceRef.current;
      if (!workspace) return;
      void refreshThreads(workspace);
      void refreshGit(workspace);
    };
    window.addEventListener('focus', refreshVisibleProject);
    return () => window.removeEventListener('focus', refreshVisibleProject);
  }, [refreshGit, refreshThreads]);

  useEffect(() => {
    if (!connected) return;
    for (const workspace of workspaces) {
      if (!workspace.isAvailable) continue;
      void refreshThreads(workspace);
      void refreshProjectGit(workspace);
    }
  }, [
    connected,
    refreshProjectGit,
    refreshThreads,
    workspaces
      .map((workspace) => `${workspace.id}:${workspace.path}:${workspace.isAvailable}`)
      .join('|')
  ]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, selectedWorkspace.id);
    restoredWorkspace.current = null;
    void refreshGit(selectedWorkspace);
    void api
      .listCodexRuntimeSkills(selectedWorkspace.path)
      .then((skills) => setRuntimeSkills(skills.filter((skill) => skill.enabled)))
      .catch(() => setRuntimeSkills([]));
  }, [refreshGit, refreshThreads, selectedWorkspace?.id]);

  useEffect(() => {
    if (
      !selectedWorkspace ||
      loadingThreads ||
      !Object.prototype.hasOwnProperty.call(threadIdsByWorkspace, selectedWorkspace.id) ||
      restoredWorkspace.current === selectedWorkspace.id
    ) return;
    restoredWorkspace.current = selectedWorkspace.id;
    const visibleThreadIds = threadIdsByWorkspace[selectedWorkspace.id] ?? [];
    let restoredId: string | null = null;
    try {
      const stored = JSON.parse(window.localStorage.getItem(SELECTED_THREAD_KEY) ?? 'null') as {
        workspaceId?: string;
        threadId?: string;
      } | null;
      if (stored?.workspaceId === selectedWorkspace.id && stored.threadId && visibleThreadIds.includes(stored.threadId)) {
        restoredId = stored.threadId;
      }
    } catch {
      // Invalid local UI state is non-fatal.
    }
    const firstActive = visibleThreads.find((thread) => !thread.archived)?.id;
    const target = restoredId ?? firstActive ?? null;
    if (target) void openThread(target, selectedWorkspace);
  }, [
    loadingThreads,
    openThread,
    selectedWorkspace,
    (selectedWorkspace ? threadIdsByWorkspace[selectedWorkspace.id] ?? [] : []).join('|')
  ]);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_OPEN_KEY, String(inspectorOpen));
  }, [inspectorOpen]);

  const updateDraft = useCallback(
    (value: string) => {
      if (!selectedThread || !selectedWorkspace) return;
      const current =
        metadataRef.current[selectedThread.id] ??
        createUiMetadata(selectedWorkspace, selectedThread, selectedPreferences);
      const next = { ...current, draft: value, updatedAt: nowIso() };
      metadataRef.current = { ...metadataRef.current, [selectedThread.id]: next };
      setMetadata((all) => ({ ...all, [selectedThread.id]: next }));
    },
    [selectedPreferences, selectedThread, selectedWorkspace]
  );

  useEffect(() => {
    if (!selectedMetadata) return;
    const timer = window.setTimeout(() => {
      void api.saveCodexThreadUiMetadata(selectedMetadata).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [selectedMetadata?.draft]);

  const updatePreferences = useCallback(
    (preferences: ThreadPreferences) => {
      if (!selectedThread || !selectedWorkspace) return;
      const current =
        metadataRef.current[selectedThread.id] ??
        createUiMetadata(selectedWorkspace, selectedThread, preferences);
      void persistMetadata({
        ...current,
        permissionMode: preferences.permissionMode,
        requestedModel: preferences.model ?? null,
        requestedReasoningEffort: preferences.reasoningEffort ?? null,
        requestedServiceTier: preferences.serviceTier ?? null,
        updatedAt: nowIso()
      });
    },
    [persistMetadata, selectedThread, selectedWorkspace]
  );

  const submitInputs = useCallback(
    async (inputs: ComposerInput[]) => {
      if (!selectedThread || !selectedWorkspace) return;
      setSubmitting(true);
      setThreadError(null);
      const text = inputs.find((input): input is Extract<ComposerInput, { type: 'text' }> => input.type === 'text')?.text;
      try {
        if (selectedRunningTurn) {
          await api.steerCodexTurn(
            selectedWorkspace.path,
            selectedThread.id,
            selectedRunningTurn.id,
            inputs
          );
        } else {
          await api.startCodexTurn(
            selectedWorkspace.path,
            selectedThread.id,
            inputs,
            selectedPreferences
          );
        }
        const current =
          metadataRef.current[selectedThread.id] ??
          createUiMetadata(selectedWorkspace, selectedThread, selectedPreferences);
        const history = text?.trim()
          ? [...current.promptHistory.filter((prompt) => prompt !== text.trim()), text.trim()].slice(-50)
          : current.promptHistory;
        await persistMetadata({
          ...current,
          draft: '',
          promptHistory: history,
          unread: false,
          updatedAt: nowIso()
        });
        setAttachmentsByThread((all) => ({ ...all, [selectedThread.id]: [] }));
        setSkillsByThread((all) => ({ ...all, [selectedThread.id]: [] }));
      } catch (error) {
        setThreadError(`Codex could not start this turn: ${String(error)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [
      persistMetadata,
      selectedPreferences,
      selectedRunningTurn,
      selectedThread,
      selectedWorkspace
    ]
  );

  const stopTurn = useCallback(async () => {
    if (!selectedThread || !selectedRunningTurn) return;
    try {
      await api.interruptCodexTurn(selectedThread.id, selectedRunningTurn.id);
    } catch (error) {
      showToast(`Could not interrupt the turn: ${String(error)}`, 'error');
    }
  }, [selectedRunningTurn, selectedThread, showToast]);

  const revertGitFile = useCallback(
    async (path: string) => {
      const workspace = selectedWorkspaceRef.current;
      if (!workspace) return;
      const approved = await confirm(
        `Revert all staged and unstaged changes to ${path}? This restores the file from HEAD.`,
        { title: 'Revert file', kind: 'warning', okLabel: 'Revert' }
      );
      if (!approved) return;
      try {
        await api.gitRevertFile(workspace.path, path);
        await refreshGit(workspace);
        showToast('File restored from HEAD', 'success');
      } catch (error) {
        showToast(`Could not revert file: ${String(error)}`, 'error');
      }
    },
    [refreshGit, showToast]
  );

  const switchGitBranch = useCallback(
    async (branchName: string) => {
      const workspace = selectedWorkspaceRef.current;
      if (!workspace || branchName === gitInfo?.branch) return;
      if (selectedRunningTurn) {
        showToast('Stop the active Codex turn before switching branches', 'error');
        return;
      }
      const approved = await confirm(
        `Switch ${workspace.name} to branch ${branchName}?`,
        { title: 'Switch branch', kind: 'warning', okLabel: 'Switch' }
      );
      if (!approved) return;
      try {
        await api.gitCheckoutBranch(workspace.path, branchName);
        await refreshGit(workspace);
        showToast(`Switched to ${branchName}`, 'success');
      } catch (error) {
        showToast(`Could not switch branch: ${String(error)}`, 'error');
      }
    },
    [gitInfo?.branch, refreshGit, selectedRunningTurn, showToast]
  );

  const createGitBranch = useCallback(
    async (branchName: string) => {
      const workspace = selectedWorkspaceRef.current;
      const name = branchName.trim();
      if (!workspace || !name) return;
      if (selectedRunningTurn) {
        showToast('Stop the active Codex turn before creating a branch', 'error');
        return;
      }
      try {
        await api.gitCreateBranch(workspace.path, name);
        await refreshGit(workspace);
        showToast(`Created and switched to ${name}`, 'success');
      } catch (error) {
        showToast(`Could not create branch: ${String(error)}`, 'error');
      }
    },
    [refreshGit, selectedRunningTurn, showToast]
  );

  const copyWorkingTreePatch = useCallback(async () => {
    const workspace = selectedWorkspaceRef.current;
    if (!workspace) return;
    try {
      const patch = await api.gitWorkspaceDiff(workspace.path);
      if (!patch) {
        showToast('There is no textual patch to copy', 'neutral');
        return;
      }
      await copyText(patch, 'Working tree patch');
    } catch (error) {
      showToast(`Could not copy patch: ${String(error)}`, 'error');
    }
  }, [copyText, showToast]);

  const respondToApproval = useCallback(
    async (
      approval: CodexApprovalRequest,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
    ) => {
      let response: ServerRequestResponse;
      if (approval.approvalType === 'commandExecution') {
        response = { type: 'command', requestId: approval.requestId, decision };
      } else if (approval.approvalType === 'fileChange') {
        response = { type: 'fileChange', requestId: approval.requestId, decision };
      } else if (approval.approvalType === 'permissions') {
        response = {
          type: 'permissions',
          requestId: approval.requestId,
          grant: decision === 'accept' || decision === 'acceptForSession',
          scope: decision === 'acceptForSession' ? 'session' : 'turn'
        };
      } else if (approval.approvalType === 'mcpElicitation') {
        response = {
          type: 'mcpElicitation',
          requestId: approval.requestId,
          action: decision === 'acceptForSession' ? 'accept' : decision
        };
      } else if (approval.approvalType === 'userInput' && decision === 'cancel') {
        response = { type: 'userInput', requestId: approval.requestId, answers: {} };
      } else {
        showToast('This approval type needs a newer ATController interaction surface.', 'error');
        return;
      }
      try {
        await api.respondToCodexRequest(response);
        codexStore.dismissApproval(approval.requestId);
      } catch (error) {
        showToast(`Approval response failed: ${String(error)}`, 'error');
      }
    },
    [showToast]
  );

  const respondToUserInput = useCallback(
    async (approval: CodexApprovalRequest, answers: Record<string, string[]>) => {
      try {
        await api.respondToCodexRequest({
          type: 'userInput',
          requestId: approval.requestId,
          answers
        });
        codexStore.dismissApproval(approval.requestId);
      } catch (error) {
        showToast(`Could not send the requested input: ${String(error)}`, 'error');
      }
    },
    [showToast]
  );

  const pickProject = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Open a project in ATController' });
    if (typeof selected !== 'string') return;
    try {
      const workspace = await api.addWorkspace(selected);
      applyWorkspace(workspace);
      selectedWorkspaceRef.current = workspace;
      setSelectedWorkspaceId(workspace.id);
      window.localStorage.setItem(SELECTED_WORKSPACE_KEY, workspace.id);
      if (connected) {
        void refreshThreads(workspace);
        void refreshProjectGit(workspace);
      }
    } catch (error) {
      showToast(`Could not add project: ${String(error)}`, 'error');
    }
  }, [applyWorkspace, connected, refreshProjectGit, refreshThreads, showToast]);

  const updateProject = useCallback(
    async (
      workspaceId: string,
      update: Parameters<typeof api.updateWorkspace>[1],
      optimistic?: Partial<Workspace>
    ) => {
      const current = workspacesRef.current.find(
        (workspace) => workspace.id === workspaceId
      );
      if (!current) return null;
      if (optimistic) applyWorkspace({ ...current, ...optimistic });
      try {
        const saved = await api.updateWorkspace(workspaceId, update);
        applyWorkspace(saved);
        if (selectedWorkspaceRef.current?.id === saved.id) {
          selectedWorkspaceRef.current = saved;
        }
        return saved;
      } catch (error) {
        if (optimistic) applyWorkspace(current);
        showToast(`Could not update ${current.name}: ${String(error)}`, 'error');
        return null;
      }
    },
    [applyWorkspace, showToast]
  );

  const toggleProject = useCallback(
    (workspaceId: string, expanded: boolean) => {
      void updateProject(
        workspaceId,
        { isExpanded: expanded },
        { isExpanded: expanded }
      );
    },
    [updateProject]
  );

  const reorderProjects = useCallback(
    async (workspaceIds: string[]) => {
      const byId = new Map(workspacesRef.current.map((workspace) => [workspace.id, workspace]));
      const optimistic = workspaceIds
        .map((id, index) => {
          const workspace = byId.get(id);
          return workspace ? { ...workspace, sortOrder: index } : null;
        })
        .filter((workspace): workspace is Workspace => Boolean(workspace));
      for (const workspace of workspacesRef.current) {
        if (!workspaceIds.includes(workspace.id)) optimistic.push(workspace);
      }
      workspacesRef.current = optimistic;
      setWorkspaces(optimistic);
      try {
        const saved = await api.setWorkspaceOrder(workspaceIds);
        workspacesRef.current = saved;
        setWorkspaces(saved);
      } catch (error) {
        const restored = await api.listWorkspaces().catch(() => workspacesRef.current);
        workspacesRef.current = restored;
        setWorkspaces(restored);
        showToast(`Could not reorder projects: ${String(error)}`, 'error');
      }
    },
    [showToast]
  );

  const copyProjectPath = useCallback(
    async (workspaceId: string) => {
      const workspace = workspacesRef.current.find(
        (candidate) => candidate.id === workspaceId
      );
      if (workspace) await copyText(workspace.path, 'Project path');
    },
    [copyText]
  );

  const openProjectTerminal = useCallback(
    (cwd?: string, workspaceOverride?: Workspace) => {
      const workspace =
        workspaceOverride ??
        (cwd
          ? [...workspacesRef.current]
              .sort((left, right) => right.path.length - left.path.length)
              .find(
                (candidate) =>
                  cwd === candidate.path || cwd.startsWith(`${candidate.path}/`)
              )
          : undefined) ??
        selectedWorkspaceRef.current;
      if (!workspace) {
        showToast('Select a project before opening Project Terminal', 'error');
        return;
      }
      if (!workspace.isAvailable) {
        showToast(`Locate the folder for ${workspace.name} before opening Project Terminal`, 'error');
        return;
      }
      setProjectTerminalTarget({
        workspaceId: workspace.id,
        cwd: cwd ?? workspace.path
      });
      setProjectTerminalOpen(true);
    },
    [showToast]
  );

  const toggleProjectTerminal = useCallback(() => {
    if (projectTerminalOpen) {
      setProjectTerminalOpen(false);
      return;
    }
    openProjectTerminal();
  }, [openProjectTerminal, projectTerminalOpen]);

  const removeProject = useCallback(
    async (workspaceId: string) => {
      const workspace = workspacesRef.current.find(
        (candidate) => candidate.id === workspaceId
      );
      if (!workspace) return;
      const approved = await confirm(
        `Remove “${workspace.name}” from ATController?\n\nThe folder, Git repository, files, and Codex threads will remain untouched and can be imported again later.`,
        {
          title: 'Remove project from ATController',
          kind: 'warning',
          okLabel: 'Remove Project'
        }
      );
      if (!approved) return;
      try {
        await api.removeWorkspace(workspace.id);
        const next = workspacesRef.current.filter(
          (candidate) => candidate.id !== workspace.id
        );
        workspacesRef.current = next;
        setWorkspaces(next);
        setThreadIdsByWorkspace((current) => {
          const copy = { ...current };
          delete copy[workspace.id];
          return copy;
        });
        if (selectedWorkspaceRef.current?.id === workspace.id) {
          const replacement = next[0];
          selectedWorkspaceRef.current = replacement;
          setSelectedWorkspaceId(replacement?.id ?? null);
          selectedThreadIdRef.current = null;
          setSelectedThreadId(null);
          codexStore.setActiveThread(null);
          if (replacement) {
            window.localStorage.setItem(SELECTED_WORKSPACE_KEY, replacement.id);
          } else {
            window.localStorage.removeItem(SELECTED_WORKSPACE_KEY);
          }
        }
        showToast(
          `${workspace.name} was removed from ATController. Its files and Codex threads were not deleted.`,
          'success'
        );
      } catch (error) {
        showToast(`Could not remove project: ${String(error)}`, 'error');
      }
    },
    [showToast]
  );

  const locateProject = useCallback(
    async (workspaceId: string) => {
      const workspace = workspacesRef.current.find(
        (candidate) => candidate.id === workspaceId
      );
      if (!workspace) return;
      const selected = await open({
        directory: true,
        multiple: false,
        title: `Locate ${workspace.name}`
      });
      if (typeof selected !== 'string') return;
      try {
        const relocated = await api.relocateWorkspace(workspace.id, selected);
        applyWorkspace(relocated);
        if (selectedWorkspaceRef.current?.id === workspace.id) {
          selectedWorkspaceRef.current = relocated;
        }
        if (connected) {
          void refreshThreads(relocated);
          void refreshProjectGit(relocated);
        }
        showToast(`${workspace.name} is available again`, 'success');
      } catch (error) {
        showToast(`Could not locate project: ${String(error)}`, 'error');
      }
    },
    [applyWorkspace, connected, refreshProjectGit, refreshThreads, showToast]
  );

  const scanCodexProjects = useCallback(async () => {
    setProjectImportLoading(true);
    setProjectImportError(null);
    try {
      setDiscoveredProjects(await api.discoverCodexProjects());
    } catch (error) {
      setProjectImportError(String(error));
    } finally {
      setProjectImportLoading(false);
    }
  }, []);

  const openProjectImport = useCallback(() => {
    setProjectImportOpen(true);
    void scanCodexProjects();
  }, [scanCodexProjects]);

  const importCodexProjects = useCallback(
    async (workspacePaths: string[]) => {
      setProjectImportBusy(true);
      const imported: Workspace[] = [];
      const skipped: string[] = [];
      for (const path of workspacePaths) {
        try {
          const workspace = await api.addWorkspace(path);
          imported.push(workspace);
        } catch (error) {
          skipped.push(`${path}: ${String(error)}`);
        }
      }
      try {
        const all = await api.listWorkspaces();
        workspacesRef.current = all;
        setWorkspaces(all);
        const selected = imported[imported.length - 1];
        if (selected) {
          selectedWorkspaceRef.current = selected;
          setSelectedWorkspaceId(selected.id);
          window.localStorage.setItem(SELECTED_WORKSPACE_KEY, selected.id);
        }
        for (const workspace of imported) {
          if (connected) {
            void refreshThreads(workspace);
            void refreshProjectGit(workspace);
          }
        }
        if (skipped.length) {
          showToast(
            `Imported ${imported.length} project${imported.length === 1 ? '' : 's'}. Skipped: ${skipped.slice(0, 2).join(' · ')}${skipped.length > 2 ? ` · and ${skipped.length - 2} more` : ''}`,
            imported.length ? 'neutral' : 'error'
          );
        } else {
          showToast(
            `Imported ${imported.length} Codex project${imported.length === 1 ? '' : 's'}`,
            'success'
          );
        }
        setProjectImportOpen(false);
      } finally {
        setProjectImportBusy(false);
      }
    },
    [connected, refreshProjectGit, refreshThreads, showToast]
  );

  const openCloneDialog = useCallback(() => {
    const selectedPath = selectedWorkspaceRef.current?.path ?? '';
    const parent = selectedPath.includes('/')
      ? selectedPath.slice(0, selectedPath.lastIndexOf('/')) || '/'
      : '';
    setCloneDestinationParent(parent);
    setCloneError(null);
    setCloneOpen(true);
  }, []);

  const chooseCloneDestination = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose where to clone the repository'
    });
    if (typeof selected === 'string') setCloneDestinationParent(selected);
  }, []);

  const cloneRepository = useCallback(
    async (repository: string) => {
      setCloneBusy(true);
      setCloneError(null);
      try {
        const workspace = await api.cloneRepository(
          repository,
          cloneDestinationParent
        );
        applyWorkspace(workspace);
        selectedWorkspaceRef.current = workspace;
        setSelectedWorkspaceId(workspace.id);
        window.localStorage.setItem(SELECTED_WORKSPACE_KEY, workspace.id);
        setCloneOpen(false);
        if (connected) {
          void refreshThreads(workspace);
          void refreshProjectGit(workspace);
        }
        showToast(`${workspace.name} cloned and added`, 'success');
      } catch (error) {
        setCloneError(String(error));
      } finally {
        setCloneBusy(false);
      }
    },
    [
      applyWorkspace,
      cloneDestinationParent,
      connected,
      refreshProjectGit,
      refreshThreads,
      showToast
    ]
  );

  const renameProject = useCallback((workspaceId: string) => {
    const workspace = workspacesRef.current.find(
      (candidate) => candidate.id === workspaceId
    );
    if (workspace) setProjectRename({ workspaceId, value: workspace.name });
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRename?.value.trim()) return;
    const saved = await updateProject(
      projectRename.workspaceId,
      { displayName: projectRename.value.trim() },
      { name: projectRename.value.trim() }
    );
    if (saved) setProjectRename(null);
  }, [projectRename, updateProject]);

  const setProjectIcon = useCallback(
    async (preference: string | null) => {
      if (!projectIconWorkspaceId) return;
      const saved = await updateProject(
        projectIconWorkspaceId,
        preference
          ? { iconPreference: preference }
          : { clearIconPreference: true },
        { iconPreference: preference }
      );
      if (saved) setProjectIconWorkspaceId(null);
    },
    [projectIconWorkspaceId, updateProject]
  );

  const moveManagedProject = useCallback(
    (workspaceId: string, direction: -1 | 1) => {
      const order = [...workspacesRef.current]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((workspace) => workspace.id);
      const index = order.indexOf(workspaceId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      setProjectSortMode('custom');
      window.localStorage.setItem(PROJECT_SORT_KEY, 'custom');
      void reorderProjects(order);
    },
    [reorderProjects]
  );

  const handleProjectsMenuAction = useCallback(
    (action: ProjectsMenuAction) => {
      if (action.startsWith('sort')) {
        const mode: ProjectSortMode =
          action === 'sortName'
            ? 'name'
            : action === 'sortRecent'
              ? 'recent'
              : action === 'sortRunning'
                ? 'running'
                : 'custom';
        setProjectSortMode(mode);
        window.localStorage.setItem(PROJECT_SORT_KEY, mode);
        return;
      }
      if (action === 'manageProjects') {
        setManagedWorkspaceId(null);
        setManageProjectsOpen(true);
        return;
      }
      const expanded = action === 'expandAll';
      const current = workspacesRef.current;
      const optimistic = current.map((workspace) => ({ ...workspace, isExpanded: expanded }));
      workspacesRef.current = optimistic;
      setWorkspaces(optimistic);
      void Promise.all(
        current.map((workspace) =>
          api.updateWorkspace(workspace.id, { isExpanded: expanded })
        )
      )
        .then((saved) => {
          const byId = new Map(saved.map((workspace) => [workspace.id, workspace]));
          const next = workspacesRef.current.map(
            (workspace) => byId.get(workspace.id) ?? workspace
          );
          workspacesRef.current = next;
          setWorkspaces(next);
        })
        .catch((error) =>
          showToast(`Could not update project shelves: ${String(error)}`, 'error')
        );
    },
    [showToast]
  );

  const handleProjectAddAction = useCallback(
    (action: ProjectAddAction) => {
      if (action === 'openFolder') void pickProject();
      else if (action === 'importProjects') openProjectImport();
      else openCloneDialog();
    },
    [openCloneDialog, openProjectImport, pickProject]
  );

  const runProjectAction = useCallback(
    async (workspace: Workspace, action: ProjectMenuAction) => {
      try {
        switch (action) {
          case 'newThread':
            await createThread(workspace);
            break;
          case 'openProject':
            selectProject(workspace.id);
            break;
          case 'openTerminal':
            selectProject(workspace.id);
            openProjectTerminal(workspace.path, workspace);
            break;
          case 'revealFinder':
            await api.openInFinder(workspace.path);
            break;
          case 'copyPath':
            await copyProjectPath(workspace.id);
            break;
          case 'copyShellCommand': {
            const command = await api.buildProjectShellCommand(workspace.id);
            await copyText(command, 'Project shell command');
            break;
          }
          case 'refreshGit':
            await refreshProjectGit(workspace);
            if (selectedWorkspaceRef.current?.id === workspace.id) {
              await refreshGit(workspace);
            }
            showToast('Git status refreshed', 'success');
            break;
          case 'importThreads':
            await refreshThreads(workspace);
            showToast(`Codex threads refreshed for ${workspace.name}`, 'success');
            break;
          case 'rename':
            renameProject(workspace.id);
            break;
          case 'changeIcon':
            setProjectIconWorkspaceId(workspace.id);
            break;
          case 'pin':
            await updateProject(
              workspace.id,
              { isPinned: !workspace.isPinned },
              { isPinned: !workspace.isPinned }
            );
            break;
          case 'collapseOthers': {
            selectProject(workspace.id);
            const next = workspacesRef.current.map((candidate) => ({
              ...candidate,
              isExpanded: candidate.id === workspace.id
            }));
            workspacesRef.current = next;
            setWorkspaces(next);
            await Promise.all(
              next.map((candidate) =>
                api.updateWorkspace(candidate.id, {
                  isExpanded: candidate.id === workspace.id
                })
              )
            );
            break;
          }
          case 'projectSettings':
            setManagedWorkspaceId(workspace.id);
            setManageProjectsOpen(true);
            break;
          case 'locateFolder':
            await locateProject(workspace.id);
            break;
          case 'remove':
            await removeProject(workspace.id);
            break;
        }
      } catch (error) {
        showToast(`${String(error)}`, 'error');
      }
    },
    [
      copyProjectPath,
      copyText,
      createThread,
      locateProject,
      openProjectTerminal,
      refreshGit,
      refreshProjectGit,
      refreshThreads,
      removeProject,
      renameProject,
      selectProject,
      showToast,
      updateProject
    ]
  );

  const startChatgptLogin = useCallback(async () => {
    setLoginBusy(true);
    try {
      const login = await api.startCodexChatgptLogin();
      await api.openExternalUrl(login.authorizationUrl);
      showToast('Finish signing in in your browser. ATController will reconnect automatically.');
    } catch (error) {
      showToast(`Could not start Codex sign-in: ${String(error)}`, 'error');
    } finally {
      setLoginBusy(false);
    }
  }, [showToast]);

  const attachPaths = useCallback(async (paths: string[]) => {
    if (!selectedWorkspace || !selectedThreadId) return;
    const uniquePaths = Array.from(
      new Set(paths.filter((path) => typeof path === 'string' && path.startsWith('/')))
    );
    if (!uniquePaths.length) return;
    const added = uniquePaths.map((path) =>
      attachmentFromPath(path, selectedWorkspace.path)
    );
    const outsideCount = added.filter((attachment) => attachment.outsideWorkspace).length;
    if (outsideCount) {
      const approved = await confirm(
        `${outsideCount === 1 ? 'This file is' : 'Some files are'} outside ${selectedWorkspace.name}. Share with Codex for this turn?`,
        { title: 'Share external attachment', kind: 'warning' }
      );
      if (!approved) return;
    }
    setAttachmentsByThread((current) => ({
      ...current,
      [selectedThreadId]: [
        ...(current[selectedThreadId] ?? []),
        ...added.filter(
          (attachment) =>
            !current[selectedThreadId]?.some(
              (existing) => existing.path === attachment.path
            )
        )
      ]
    }));
  }, [selectedThreadId, selectedWorkspace]);

  const pickAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: 'Attach files to this Codex turn'
    });
    const paths = typeof selected === 'string' ? [selected] : selected ?? [];
    await attachPaths(paths);
  }, [attachPaths]);

  const renameThread = useCallback(
    (threadId: string) => {
      const thread = codexStore.getSnapshot().threads[threadId];
      if (thread) setRename({ threadId, value: thread.title });
    },
    []
  );

  const submitRename = useCallback(async () => {
    if (!rename || !rename.value.trim()) return;
    try {
      await api.renameCodexThread(rename.threadId, rename.value.trim());
      const thread = codexStore.getSnapshot().threads[rename.threadId];
      if (thread) codexStore.upsertThreads([{ ...thread, title: rename.value.trim() }]);
      updateMetadata(rename.threadId, (current) => ({
        ...current,
        fallbackTitle: rename.value.trim(),
        updatedAt: nowIso()
      }));
      setRename(null);
    } catch (error) {
      showToast(`Could not rename thread: ${String(error)}`, 'error');
    }
  }, [rename, showToast, updateMetadata]);

  const resumeRequest = useCallback(
    (thread: CodexThread, fullAccess: boolean): ResumeCommandRequest => {
      const ui = metadataRef.current[thread.id];
      return {
        threadId: thread.id,
        workspacePath: thread.cwd || selectedWorkspaceRef.current?.path || '',
        model: ui?.requestedModel ?? null,
        reasoningEffort: ui?.requestedReasoningEffort ?? null,
        serviceTier: ui?.requestedServiceTier ?? null,
        fullAccess
      };
    },
    []
  );

  const runThreadAction = useCallback(
    async (thread: CodexThread, action: ThreadMenuAction) => {
      const workspace = findWorkspaceForThread(thread.id, thread);
      if (!workspace) return;
      const ui = metadataRef.current[thread.id];
      try {
        switch (action) {
          case 'open':
            await openThread(thread.id, workspace);
            break;
          case 'rename':
            renameThread(thread.id);
            break;
          case 'pin':
            if (ui) await persistMetadata({ ...ui, pinned: !ui.pinned, updatedAt: nowIso() });
            break;
          case 'markRead':
            if (ui) await persistMetadata({ ...ui, unread: !ui.unread, updatedAt: nowIso() });
            break;
          case 'copyId':
            await copyText(thread.id, 'Thread ID');
            break;
          case 'copyResume': {
            const command = await api.buildCodexResumeCommand(resumeRequest(thread, false));
            await copyText(command.command, 'Resume command');
            break;
          }
          case 'copyFullAccessResume': {
            const command = await api.buildCodexResumeCommand(resumeRequest(thread, true));
            await copyText(command.command, 'Full Access resume command');
            break;
          }
          case 'openResumeInTerminal':
            await api.openCodexResumeInTerminal(
              resumeRequest(thread, ui?.permissionMode === 'fullAccess'),
              settings.resumeTerminalBehavior === 'executeImmediately'
            );
            showToast(
              settings.resumeTerminalBehavior === 'executeImmediately'
                ? 'Resume command opened in Terminal'
                : 'Resume command inserted in Terminal for review',
              'success'
            );
            break;
          case 'openProjectInTerminal':
            openProjectTerminal(workspace.path, workspace);
            break;
          case 'revealProject':
            await api.openInFinder(workspace.path);
            break;
          case 'restartRuntime':
            setControlBusy(true);
            await api.restartCodexRuntime();
            setCatalog(await api.getCodexCatalog());
            await openThread(thread.id);
            showToast('Codex runtime restarted', 'success');
            setControlBusy(false);
            break;
          case 'startFresh':
            await createThread(workspace);
            break;
          case 'fork': {
            const lastTurnId =
              thread.turns.length > 0 ? thread.turns[thread.turns.length - 1].id : null;
            const preferences = preferencesFromMetadata(ui, settingsRef.current);
            const session = await api.forkCodexThread(
              workspace.path,
              thread.id,
              lastTurnId,
              preferences
            );
            codexStore.setSession(session);
            setThreadIdsByWorkspace((current) => ({
              ...current,
              [workspace.id]: current[workspace.id]?.includes(session.thread.id)
                ? current[workspace.id]
                : [session.thread.id, ...(current[workspace.id] ?? [])]
            }));
            await ensureMetadata(workspace, session.thread, preferences);
            await openThread(session.thread.id, workspace);
            showToast('Forked Codex thread', 'success');
            break;
          }
          case 'archive':
            await api.archiveCodexThread(thread.id);
            codexStore.upsertThreads([{ ...thread, archived: true }]);
            if (ui) {
              await persistMetadata({
                ...ui,
                archived: true,
                updatedAt: nowIso()
              });
            }
            if (selectedThreadIdRef.current === thread.id) {
              setSelectedThreadId(null);
              codexStore.setActiveThread(null);
            }
            await refreshThreads(workspace);
            break;
          case 'unarchive': {
            const reopening = selectedThreadIdRef.current === thread.id;
            if (reopening) setRecoveringThread(true);
            try {
              const restored = await api.unarchiveCodexThread(thread.id);
              codexStore.upsertThreads([restored]);
              if (ui) {
                await persistMetadata({
                  ...ui,
                  archived: false,
                  updatedAt: nowIso()
                });
              }
              await refreshThreads(workspace);
              if (reopening) {
                await openThread(thread.id, workspace);
              }
            } finally {
              if (reopening) setRecoveringThread(false);
            }
            break;
          }
          case 'delete': {
            const approved = await confirm(
              `Permanently delete “${thread.title}”? This removes the Codex thread and cannot be undone.`,
              { title: 'Delete Codex thread', kind: 'warning' }
            );
            if (!approved) break;
            await api.deleteCodexThread(thread.id);
            removeThreadFromUi(thread.id);
            showToast('Codex thread deleted', 'success');
            break;
          }
        }
      } catch (error) {
        setControlBusy(false);
        showToast(`${String(error)}`, 'error');
      }
    },
    [
      copyText,
      createThread,
      ensureMetadata,
      findWorkspaceForThread,
      openThread,
      openProjectTerminal,
      persistMetadata,
      removeThreadFromUi,
      refreshThreads,
      renameThread,
      resumeRequest,
      settings.resumeTerminalBehavior,
      showToast
    ]
  );

  const restartRuntime = useCallback(async () => {
    setControlBusy(true);
    try {
      const diagnostics = await api.restartCodexRuntime();
      codexStore.setDiagnostics(diagnostics);
      setCatalog(await api.getCodexCatalog());
      if (selectedThreadIdRef.current) await openThread(selectedThreadIdRef.current);
      showToast('Codex runtime restarted', 'success');
    } catch (error) {
      showToast(`Runtime restart failed: ${String(error)}`, 'error');
    } finally {
      setControlBusy(false);
    }
  }, [openThread, showToast]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      try {
        const saved = await api.saveSettings(next);
        setSettings(saved);
        const appearance = normalizeAppearanceMode(saved.appearanceMode);
        applyAppearanceMode(appearance);
        persistAppearanceMode(appearance);
        setControlCenter(null);
        showToast('Settings saved', 'success');
        if (saved.codexCliPath !== settings.codexCliPath) void restartRuntime();
      } catch (error) {
        showToast(`Could not save settings: ${String(error)}`, 'error');
      }
    },
    [restartRuntime, settings.codexCliPath, showToast]
  );

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [
      {
        id: 'open-project',
        label: 'Open Project',
        description: 'Add a local folder to ATController',
        shortcut: '⌘O',
        icon: 'folder',
        run: () => void pickProject()
      },
      {
        id: 'import-projects',
        label: 'Import Existing Codex Projects',
        description: 'Discover projects from local Codex thread history',
        shortcut: '⇧⌘O',
        icon: 'history',
        run: openProjectImport
      },
      {
        id: 'clone-repository',
        label: 'Clone Repository',
        description: 'Clone and add a local ATController project',
        icon: 'code',
        run: openCloneDialog
      },
      {
        id: 'manage-projects',
        label: 'Manage Projects',
        description: 'Rename, reorder, pin, import, or remove project entries',
        icon: 'folder',
        run: () => {
          setManagedWorkspaceId(selectedWorkspace?.id ?? null);
          setManageProjectsOpen(true);
        }
      },
      {
        id: 'expand-all-projects',
        label: 'Expand All Projects',
        icon: 'chevronDown',
        run: () => handleProjectsMenuAction('expandAll')
      },
      {
        id: 'collapse-all-projects',
        label: 'Collapse All Projects',
        icon: 'chevronRight',
        run: () => handleProjectsMenuAction('collapseAll')
      },
      {
        id: 'sort-projects-custom',
        label: 'Sort Projects: Custom Order',
        icon: 'folder',
        run: () => handleProjectsMenuAction('sortCustom')
      },
      {
        id: 'sort-projects-name',
        label: 'Sort Projects: Name',
        icon: 'folder',
        run: () => handleProjectsMenuAction('sortName')
      },
      {
        id: 'sort-projects-recent',
        label: 'Sort Projects: Recent Activity',
        icon: 'history',
        run: () => handleProjectsMenuAction('sortRecent')
      },
      {
        id: 'sort-projects-running',
        label: 'Sort Projects: Running Threads',
        icon: 'refresh',
        run: () => handleProjectsMenuAction('sortRunning')
      },
      {
        id: 'new-thread',
        label: 'New Codex Thread',
        description: selectedWorkspace?.name,
        shortcut: '⌘N',
        icon: 'add',
        disabled: !selectedWorkspace,
        run: () => void createThread()
      },
      {
        id: 'focus-composer',
        label: 'Focus Composer',
        shortcut: '⌘L',
        icon: 'send',
        disabled: !selectedThread,
        run: () => window.dispatchEvent(new Event('atcontroller:focus-composer'))
      },
      {
        id: 'find-thread',
        label: 'Find in Thread',
        description: 'Search the open Codex conversation',
        shortcut: '⌘F',
        icon: 'search',
        disabled: !selectedThread,
        run: () => window.dispatchEvent(new Event('atcontroller:find-thread'))
      },
      {
        id: 'rename-thread',
        label: 'Rename Thread',
        shortcut: '⌘⇧R',
        icon: 'code',
        disabled: !selectedThread,
        run: () => selectedThread && renameThread(selectedThread.id)
      },
      {
        id: 'copy-resume',
        label: 'Copy Resume Command',
        shortcut: '⌘⇧C',
        icon: 'copy',
        disabled: !selectedThread,
        run: () => selectedThread && void runThreadAction(selectedThread, 'copyResume')
      },
      {
        id: 'open-resume-terminal',
        label: 'Open Resume Command in Terminal',
        icon: 'terminal',
        disabled: !selectedThread,
        run: () => selectedThread && void runThreadAction(selectedThread, 'openResumeInTerminal')
      },
      {
        id: 'toggle-full-access',
        label: selectedPreferences.permissionMode === 'fullAccess'
          ? 'Use Workspace Access'
          : 'Enable Full Access',
        description: 'Change the permission profile for subsequent turns',
        icon: 'warning',
        disabled: !selectedThread,
        run: () =>
          updatePreferences({
            ...selectedPreferences,
            permissionMode:
              selectedPreferences.permissionMode === 'fullAccess'
                ? 'workspaceAccess'
                : 'fullAccess'
          })
      },
      {
        id: 'toggle-inspector',
        label: 'Toggle Inspector',
        shortcut: '⌘⇧I',
        icon: 'panelRight',
        disabled: !selectedThread,
        run: () => setInspectorOpen((value) => !value)
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle Sidebar',
        shortcut: '⌘⇧S',
        icon: 'panelLeft',
        run: () => setSidebarCollapsed((value) => !value)
      },
      {
        id: 'open-terminal',
        label: projectTerminalOpen ? 'Hide Project Terminal' : 'Open Project Terminal',
        shortcut: '⌘J',
        icon: 'terminal',
        disabled: !selectedWorkspace,
        run: toggleProjectTerminal
      },
      {
        id: 'restart-runtime',
        label: 'Restart Codex Runtime',
        icon: 'refresh',
        run: () => void restartRuntime()
      },
      {
        id: 'diagnostics',
        label: 'Open Diagnostics',
        icon: 'info',
        run: () => setControlCenter('diagnostics')
      }
    ];
    if (selectedThread) {
      actions.push({
        id: 'fork-thread',
        label: 'Fork Thread From Latest Turn',
        icon: 'history',
        run: () => void runThreadAction(selectedThread, 'fork')
      });
      actions.push({
        id: 'archive-thread',
        label: selectedThread.archived ? 'Restore Thread' : 'Archive Thread',
        icon: 'archive',
        run: () =>
          void runThreadAction(selectedThread, selectedThread.archived ? 'unarchive' : 'archive')
      });
    }
    for (const model of catalog?.models ?? []) {
      actions.push({
        id: `model-${model.id}`,
        label: `Use Model: ${model.displayName || model.model}`,
        description: model.description,
        icon: 'code',
        disabled: !selectedThread,
        run: () =>
          updatePreferences({
            ...selectedPreferences,
            model: model.id,
            reasoningEffort: model.defaultReasoningEffort,
            serviceTier: model.defaultServiceTier ?? null
          })
      });
    }
    const activeModel =
      catalog?.models.find(
        (model) =>
          model.id === selectedPreferences.model || model.model === selectedPreferences.model
      ) ??
      catalog?.models.find((model) => model.isDefault) ??
      catalog?.models[0];
    for (const effort of activeModel?.reasoningEfforts ?? []) {
      actions.push({
        id: `effort-${effort.value}`,
        label: `Reasoning: ${effort.value === 'ultra' ? 'Ultra' : effort.value}`,
        description: effort.description,
        icon: 'info',
        disabled: !selectedThread,
        run: () =>
          updatePreferences({ ...selectedPreferences, reasoningEffort: effort.value })
      });
    }
    for (const tier of activeModel?.serviceTiers ?? []) {
      actions.push({
        id: `tier-${tier.id}`,
        label: `Service Tier: ${tier.name || tier.id}`,
        description: tier.description,
        icon: 'refresh',
        disabled: !selectedThread,
        run: () =>
          updatePreferences({ ...selectedPreferences, serviceTier: tier.id })
      });
    }
    for (const thread of allSidebarThreads.slice(0, 30)) {
      const workspace = workspaces.find((candidate) =>
        workspaceMatchesThread(candidate, thread, metadata[thread.id])
      );
      actions.push({
        id: `thread-${thread.id}`,
        label: thread.title,
        description: `Switch thread · ${workspace?.name ?? 'Project'}`,
        icon: 'history',
        keywords: thread.preview,
        run: () => void openThread(thread.id)
      });
    }
    return actions;
  }, [
    createThread,
    allSidebarThreads,
    catalog,
    handleProjectsMenuAction,
    metadata,
    openCloneDialog,
    openThread,
    openProjectImport,
    pickProject,
    renameThread,
    restartRuntime,
    runThreadAction,
    projectTerminalOpen,
    selectedThread,
    selectedPreferences,
    selectedWorkspace,
    toggleProjectTerminal,
    updatePreferences,
    workspaces
  ]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        void createThread();
      } else if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        openProjectImport();
      } else if (key === 'o') {
        event.preventDefault();
        void pickProject();
      } else if (key === 'k' || key === 'p') {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'l') {
        event.preventDefault();
        window.dispatchEvent(new Event('atcontroller:focus-composer'));
      } else if (key === 'j') {
        event.preventDefault();
        toggleProjectTerminal();
      } else if (key === 'i' && event.shiftKey) {
        event.preventDefault();
        setInspectorOpen((value) => !value);
      } else if (key === 's' && event.shiftKey) {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      } else if (key === '.' && selectedRunningTurn) {
        event.preventDefault();
        void stopTurn();
      } else if (key === 'r' && event.shiftKey && selectedThread) {
        event.preventDefault();
        renameThread(selectedThread.id);
      } else if (key === 'c' && event.shiftKey && selectedThread) {
        event.preventDefault();
        void runThreadAction(selectedThread, 'copyResume');
      } else if (key === 'f' && !event.shiftKey && selectedThread) {
        event.preventDefault();
        window.dispatchEvent(new Event('atcontroller:find-thread'));
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.sidebar-search input')?.focus();
      } else if (key === 'g' && selectedThread) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent('atcontroller:find-thread-step', {
            detail: { direction: event.shiftKey ? -1 : 1 }
          })
        );
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [
    createThread,
    openProjectImport,
    pickProject,
    renameThread,
    runThreadAction,
    selectedRunningTurn,
    selectedThread,
    toggleProjectTerminal,
    stopTurn,
  ]);

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => {
      setSidebarWidth(Math.min(420, Math.max(236, startWidth + moveEvent.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSidebarWidth((width) => {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
        return width;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (loading) {
    return (
      <div className="startup-screen">
        <span className="app-startup-mark">AT</span>
        <strong>ATController</strong>
        <span className="startup-progress" />
        <p>Connecting to the local Codex runtime…</p>
      </div>
    );
  }

  const rootStyle = {
    '--sidebar-width': sidebarCollapsed ? '52px' : `${sidebarWidth}px`
  } as CSSProperties;

  return (
    <div className="atcontroller-app" style={rootStyle}>
      <CodexSidebar
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedThreadId={selectedThreadId}
        threadsByWorkspace={threadsByWorkspace}
        metadata={metadata}
        approvals={codex.approvals as Record<string, CodexApprovalRequest>}
        gitInfoByWorkspace={gitInfoByWorkspace}
        loadingWorkspaceIds={loadingWorkspaceIds}
        filter={filter}
        sortMode={projectSortMode}
        connectionState={codex.diagnostics?.connectionState ?? 'stopped'}
        collapsed={sidebarCollapsed}
        onSelectWorkspace={selectProject}
        onToggleWorkspace={toggleProject}
        onAddAction={handleProjectAddAction}
        onNewThread={(workspaceId) => {
          const workspace = workspaceId
            ? workspacesRef.current.find((candidate) => candidate.id === workspaceId)
            : selectedWorkspaceRef.current;
          void createThread(workspace);
        }}
        onSelectThread={(workspaceId, threadId) => {
          const workspace = workspacesRef.current.find(
            (candidate) => candidate.id === workspaceId
          );
          void openThread(threadId, workspace);
        }}
        onRenameThread={renameThread}
        onOpenThreadMenu={(threadId, x, y) => setContextMenu({ threadId, x, y })}
        onOpenProjectMenu={(workspaceId, x, y) =>
          setProjectContextMenu({ workspaceId, x, y })
        }
        onReorderWorkspaces={(workspaceIds) => void reorderProjects(workspaceIds)}
        onLocateWorkspace={(workspaceId) => void locateProject(workspaceId)}
        onRemoveWorkspace={(workspaceId) => void removeProject(workspaceId)}
        onCopyWorkspacePath={(workspaceId) => void copyProjectPath(workspaceId)}
        onFilterChange={setFilter}
        onOpenSettings={() => setControlCenter('settings')}
        onOpenDiagnostics={() => setControlCenter('diagnostics')}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />
      {!sidebarCollapsed ? (
        <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar" onPointerDown={beginSidebarResize} />
      ) : null}

      <div className="application-main">
        {catalog && !catalog.account.signedIn && catalog.account.requiresOpenaiAuth ? (
          <EmptyWorkspace
            kind="info"
            detail="Sign in to Codex"
            action={loginBusy ? 'Opening browser…' : 'Continue with ChatGPT'}
            onAction={() => void startChatgptLogin()}
          />
        ) : workspaces.length === 0 ? (
          <EmptyWorkspace kind="folder" detail="Open your first project" action="Open Project" onAction={() => void pickProject()} />
        ) : fatalError && !connected ? (
          <EmptyWorkspace
            kind="warning"
            detail="Codex runtime is unavailable"
            action="Open Diagnostics"
            onAction={() => setControlCenter('diagnostics')}
          />
        ) : !selectedWorkspace ? (
          <EmptyWorkspace kind="folder" detail="Select a project" action="Choose Project" onAction={() => void pickProject()} />
        ) : !selectedWorkspace.isAvailable ? (
          <EmptyWorkspace
            kind="warning"
            detail={`${selectedWorkspace.name} is unavailable`}
            action="Locate Folder"
            onAction={() => void locateProject(selectedWorkspace.id)}
          />
        ) : !selectedThread ? (
          <EmptyWorkspace
            kind="history"
            detail={loadingThreads ? 'Loading Codex threads…' : 'Start a Codex thread'}
            action="New Thread"
            onAction={() => void createThread()}
          />
        ) : (
          <>
            <ThreadHeader
              thread={selectedThread}
              workspace={selectedWorkspace}
              session={selectedSession}
              preferences={selectedPreferences}
              gitInfo={gitInfo}
              approvals={selectedApprovals}
              disconnected={!connected}
              inspectorOpen={inspectorOpen}
              onRename={() => renameThread(selectedThread.id)}
              onSelectProject={() => {
                selectProject(selectedWorkspace.id);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>(
                      `[data-project-shelf="${selectedWorkspace.id}"]`
                    )
                    ?.scrollIntoView({ block: 'nearest' })
                );
              }}
              onOpenMenu={(x, y) => setContextMenu({ threadId: selectedThread.id, x, y })}
              onToggleInspector={() => setInspectorOpen((value) => !value)}
              onOpenTerminal={toggleProjectTerminal}
            />
            {threadError ? (
              <div className="thread-error-banner">
                <AppIcon name="warning" />
                <span>{threadError}</span>
                <button type="button" className="error-action" onClick={() => void openThread(selectedThread.id)}>
                  Retry
                </button>
                <button type="button" className="error-action" onClick={() => void createThread()}>
                  Start fresh
                </button>
                <button type="button" onClick={() => setThreadError(null)} aria-label="Dismiss"><AppIcon name="close" /></button>
              </div>
            ) : null}
            <div className="session-workspace">
              <section className="conversation-region">
                <ConversationTimeline
                  thread={selectedThread}
                  approvals={selectedApprovals}
                  usage={codex.usage[selectedThread.id]}
                  recovering={recoveringThread}
                  onRespondToApproval={(approval, decision) => void respondToApproval(approval, decision)}
                  onRespondToUserInput={(approval, answers) => void respondToUserInput(approval, answers)}
                  onCopy={(value, label) => void copyText(value, label)}
                  onOpenFile={(path) => void api.openProjectFile(selectedWorkspace.path, path)}
                  onRevealPath={(path) => void api.revealProjectFile(selectedWorkspace.path, path)}
                  onRevertFile={(path) => void revertGitFile(path)}
                  onOpenTerminal={(path) => openProjectTerminal(path, selectedWorkspace)}
                />
                <MessageComposer
                  threadId={selectedThread.id}
                  workspacePath={selectedWorkspace.path}
                  value={selectedMetadata?.draft ?? ''}
                  promptHistory={selectedMetadata?.promptHistory ?? []}
                  attachments={currentAttachments}
                  skills={runtimeSkills}
                  selectedSkills={currentSkills}
                  preferences={selectedPreferences}
                  models={catalog?.models ?? []}
                  fiveHourLimit={catalog?.account.fiveHourLimit}
                  weeklyLimit={catalog?.account.weeklyLimit}
                  archived={selectedThread.archived}
                  running={Boolean(selectedRunningTurn)}
                  connected={connected}
                  recovering={recoveringThread}
                  submitting={submitting}
                  commandEnterToSend={settings.commandEnterToSend !== false}
                  onChange={updateDraft}
                  onAttachmentsChange={(attachments) =>
                    setAttachmentsByThread((current) => ({
                      ...current,
                      [selectedThread.id]: attachments
                    }))
                  }
                  onSelectedSkillsChange={(skills) =>
                    setSkillsByThread((current) => ({
                      ...current,
                      [selectedThread.id]: skills
                    }))
                  }
                  onPreferencesChange={updatePreferences}
                  onPickAttachments={() => void pickAttachments()}
                  onDropPaths={attachPaths}
                  onSubmit={(inputs) => void submitInputs(inputs)}
                  onStop={() => void stopTurn()}
                  onRestore={() => void runThreadAction(selectedThread, 'unarchive')}
                />
              </section>
              {inspectorOpen ? (
                <InspectorPanel
                  thread={selectedThread}
                  session={selectedSession}
                  metadata={selectedMetadata}
                  diagnostics={codex.diagnostics}
                  gitInfo={gitInfo}
                  gitStatus={gitStatus}
                  gitBranches={gitBranches}
                  onClose={() => setInspectorOpen(false)}
                  onCopy={(value, label) => void copyText(value, label)}
                  onOpenFile={(path) => void api.openProjectFile(selectedWorkspace.path, path)}
                  onRevealFile={(path) => void api.revealProjectFile(selectedWorkspace.path, path)}
                  onLoadDiff={(path) => api.gitWorkspaceDiff(selectedWorkspace.path, path)}
                  onRevertFile={(path) => void revertGitFile(path)}
                  onSwitchBranch={(branch) => void switchGitBranch(branch)}
                  onCreateBranch={(branch) => void createGitBranch(branch)}
                  onCopyPatch={() => void copyWorkingTreePatch()}
                  onCopyResume={(fullAccess) =>
                    void runThreadAction(
                      selectedThread,
                      fullAccess ? 'copyFullAccessResume' : 'copyResume'
                    )
                  }
                  onOpenResumeInTerminal={() =>
                    void runThreadAction(selectedThread, 'openResumeInTerminal')
                  }
                  onOpenTerminal={(path) => openProjectTerminal(path, selectedWorkspace)}
                  onRestartRuntime={() => void restartRuntime()}
                />
              ) : null}
            </div>
          </>
        )}
        {projectTerminalTarget ? (
          <Suspense fallback={null}>
            <ProjectTerminalShelf
              open={projectTerminalOpen}
              workspace={projectTerminalWorkspace}
              requestedCwd={projectTerminalTarget.cwd}
              onClose={() => setProjectTerminalOpen(false)}
              onError={(message) => showToast(message, 'error')}
            />
          </Suspense>
        ) : null}
      </div>

      {contextMenu ? (() => {
        const thread = codex.threads[contextMenu.threadId];
        const workspace = thread
          ? findWorkspaceForThread(thread.id, thread)
          : undefined;
        if (!thread || !workspace) return null;
        return (
          <ThreadContextMenu
            thread={thread}
            workspace={workspace}
            metadata={metadata[thread.id]}
            x={contextMenu.x}
            y={contextMenu.y}
            onAction={(action) => void runThreadAction(thread, action)}
            onClose={() => setContextMenu(null)}
          />
        );
      })() : null}

      {projectContextMenu ? (() => {
        const workspace = workspaces.find(
          (candidate) => candidate.id === projectContextMenu.workspaceId
        );
        if (!workspace) return null;
        return (
          <ProjectContextMenu
            workspace={workspace}
            hasGit={
              Boolean(gitInfoByWorkspace[workspace.id]) ||
              !Object.prototype.hasOwnProperty.call(gitInfoByWorkspace, workspace.id)
            }
            x={projectContextMenu.x}
            y={projectContextMenu.y}
            onAction={(action) => void runProjectAction(workspace, action)}
            onClose={() => setProjectContextMenu(null)}
          />
        );
      })() : null}

      {rename ? (
        <div className="modal-backdrop" onPointerDown={() => setRename(null)}>
          <form
            className="rename-dialog"
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <h2>Rename thread</h2>
            <input
              value={rename.value}
              maxLength={200}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRename({ ...rename, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setRename(null);
              }}
            />
            <footer>
              <button type="button" className="ghost-button" onClick={() => setRename(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!rename.value.trim()}>Rename</button>
            </footer>
          </form>
        </div>
      ) : null}

      {projectRename ? (
        <div className="modal-backdrop" onPointerDown={() => setProjectRename(null)}>
          <form
            className="rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-title"
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitProjectRename();
            }}
          >
            <h2 id="rename-project-title">Rename project</h2>
            <input
              value={projectRename.value}
              maxLength={120}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) =>
                setProjectRename({ ...projectRename, value: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape') setProjectRename(null);
              }}
            />
            <footer>
              <button type="button" className="ghost-button" onClick={() => setProjectRename(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!projectRename.value.trim()}>Rename</button>
            </footer>
          </form>
        </div>
      ) : null}

      <ProjectImportDialog
        open={projectImportOpen}
        projects={discoveredProjects}
        loading={projectImportLoading}
        busy={projectImportBusy}
        error={projectImportError}
        onRefresh={() => void scanCodexProjects()}
        onImport={(paths) => void importCodexProjects(paths)}
        onClose={() => {
          if (!projectImportBusy) setProjectImportOpen(false);
        }}
      />
      <CloneRepositoryDialog
        open={cloneOpen}
        destinationParent={cloneDestinationParent}
        busy={cloneBusy}
        error={cloneError}
        onChooseDestination={() => void chooseCloneDestination()}
        onClone={(repository) => void cloneRepository(repository)}
        onClose={() => {
          if (!cloneBusy) setCloneOpen(false);
        }}
      />
      <ManageProjectsDialog
        open={manageProjectsOpen}
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        gitInfoByWorkspace={gitInfoByWorkspace}
        focusedWorkspaceId={managedWorkspaceId}
        onOpen={(workspaceId) => {
          selectProject(workspaceId);
          setManageProjectsOpen(false);
        }}
        onReveal={(workspaceId) => {
          const workspace = workspacesRef.current.find(
            (candidate) => candidate.id === workspaceId
          );
          if (workspace) {
            void api
              .openInFinder(workspace.path)
              .catch((error) => showToast(`Could not reveal project: ${String(error)}`, 'error'));
          }
        }}
        onRename={(workspaceId) => {
          setManageProjectsOpen(false);
          renameProject(workspaceId);
        }}
        onTogglePin={(workspaceId) => {
          const workspace = workspacesRef.current.find(
            (candidate) => candidate.id === workspaceId
          );
          if (workspace) {
            void updateProject(
              workspace.id,
              { isPinned: !workspace.isPinned },
              { isPinned: !workspace.isPinned }
            );
          }
        }}
        onMove={moveManagedProject}
        onImportThreads={(workspaceId) => {
          const workspace = workspacesRef.current.find(
            (candidate) => candidate.id === workspaceId
          );
          if (workspace) void refreshThreads(workspace);
        }}
        onRemove={(workspaceId) => void removeProject(workspaceId)}
        onClose={() => setManageProjectsOpen(false)}
      />
      <ProjectIconDialog
        workspace={
          projectIconWorkspaceId
            ? workspaces.find((workspace) => workspace.id === projectIconWorkspaceId) ?? null
            : null
        }
        onSelect={(preference) => void setProjectIcon(preference)}
        onClose={() => setProjectIconWorkspaceId(null)}
      />

      <CommandPalette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      <ControlCenterDialog
        open={controlCenter != null}
        initialTab={controlCenter ?? 'settings'}
        settings={settings}
        catalog={catalog}
        diagnostics={codex.diagnostics}
        dataRoot={dataRoot}
        selfTestResult={selfTestResult}
        busy={controlBusy}
        onClose={() => setControlCenter(null)}
        onSaveSettings={(next) => void saveSettings(next)}
        onRestartRuntime={() => void restartRuntime()}
        onRunSelfTest={() => {
          setControlBusy(true);
          void api
            .runCodexSelfTest()
            .then(setSelfTestResult)
            .catch((error) => setSelfTestResult({ ok: false, error: String(error) }))
            .finally(() => setControlBusy(false));
        }}
        onRegenerateProtocol={() => {
          setControlBusy(true);
          void api
            .regenerateCodexProtocolSnapshot()
            .then((path) => {
              setSelfTestResult({ ok: true, generatedProtocolSnapshot: path });
              showToast('Protocol bindings regenerated', 'success');
            })
            .catch((error) => setSelfTestResult({ ok: false, error: String(error) }))
            .finally(() => setControlBusy(false));
        }}
        onCopyDiagnostics={() => void copyText(JSON.stringify(codex.diagnostics, null, 2), 'Diagnostics')}
        onOpenDataRoot={() => void api.openInFinder(dataRoot)}
        onOpenCodexConfiguration={() =>
          void api
            .openCodexConfiguration()
            .catch((error) => showToast(`Could not open Codex configuration: ${String(error)}`, 'error'))
        }
      />

      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.tone === 'success' ? <AppIcon name="check" /> : toast.tone === 'error' ? <AppIcon name="warning" /> : <AppIcon name="info" />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
