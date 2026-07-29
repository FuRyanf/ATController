import {
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
import { CodexSidebar } from './components/CodexSidebar';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ControlCenterDialog } from './components/ControlCenterDialog';
import { ConversationTimeline } from './components/ConversationTimeline';
import { InspectorPanel } from './components/InspectorPanel';
import {
  MessageComposer,
  type ComposerAttachment
} from './components/MessageComposer';
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
import { codexStore, useCodexStore } from './stores/codexStore';
import type {
  CodexApprovalRequest,
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
  ResumeCommandRequest,
  ServerRequestResponse,
  Settings,
  ThreadPreferences,
  Workspace
} from './types';

const api = apiModule.api;
const SELECTED_WORKSPACE_KEY = 'atcontroller:selected-workspace-v2';
const SELECTED_THREAD_KEY = 'atcontroller:selected-codex-thread-v2';
const SIDEBAR_WIDTH_KEY = 'atcontroller:sidebar-width-v2';
const INSPECTOR_OPEN_KEY = 'atcontroller:inspector-open-v2';

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
  const [visibleThreadIds, setVisibleThreadIds] = useState<string[]>([]);
  const [metadata, setMetadata] = useState<Record<string, CodexThreadUiMetadata>>({});
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [catalog, setCatalog] = useState<CodexRuntimeCatalog | null>(null);
  const [dataRoot, setDataRoot] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [recoveringThread, setRecoveringThread] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [attachmentsByThread, setAttachmentsByThread] = useState<Record<string, ComposerAttachment[]>>({});
  const [runtimeSkills, setRuntimeSkills] = useState<CodexSkill[]>([]);
  const [skillsByThread, setSkillsByThread] = useState<Record<string, CodexSkill[]>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
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
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitWorkspaceStatus | null>(null);
  const [gitBranches, setGitBranches] = useState<GitBranchEntry[]>([]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
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
  const visibleThreads = visibleThreadIds
    .map((threadId) => codex.threads[threadId])
    .filter((thread): thread is CodexThread => Boolean(thread));
  const connected = codex.diagnostics?.connectionState === 'ready';
  const currentAttachments = selectedThreadId ? attachmentsByThread[selectedThreadId] ?? [] : [];
  const currentSkills = selectedThreadId ? skillsByThread[selectedThreadId] ?? [] : [];

  const selectedWorkspaceRef = useRef<Workspace | undefined>(selectedWorkspace);
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const metadataRef = useRef(metadata);
  const settingsRef = useRef(settings);
  const connectionStateRef = useRef(codex.diagnostics?.connectionState ?? 'stopped');
  const gitRefreshTimer = useRef<number | null>(null);
  const threadRefreshSequence = useRef(0);
  const restoredWorkspace = useRef<string | null>(null);
  const runtimeThreadFilter = useRef('');

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);
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
      if (selectedWorkspaceRef.current?.id === target.id) {
        setGitInfo(info);
        setGitStatus(status);
        setGitBranches(branches);
      }
    } catch {
      if (selectedWorkspaceRef.current?.id === target.id) {
        setGitInfo(null);
        setGitStatus(null);
        setGitBranches([]);
      }
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
      const refreshSequence = ++threadRefreshSequence.current;
      setLoadingThreads(true);
      setThreadError(null);
      try {
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
        if (
          refreshSequence !== threadRefreshSequence.current ||
          selectedWorkspaceRef.current?.id !== workspace.id
        ) {
          return;
        }
        codexStore.replaceWorkspaceThreads(workspace.path, false, activePage);
        codexStore.replaceWorkspaceThreads(workspace.path, true, archivedPage);
        const uiMap = Object.fromEntries(uiMetadata.map((item) => [item.threadId, item]));
        metadataRef.current = { ...metadataRef.current, ...uiMap };
        setMetadata((current) => ({ ...current, ...uiMap }));
        setVisibleThreadIds([...activePage, ...archivedPage].map((thread) => thread.id));
      } catch (error) {
        if (refreshSequence === threadRefreshSequence.current) {
          setThreadError(String(error));
        }
      } finally {
        if (refreshSequence === threadRefreshSequence.current) {
          setLoadingThreads(false);
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
      if (existing) return existing;
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
    async (threadId: string) => {
      const workspace = selectedWorkspaceRef.current;
      if (!workspace) return;
      setSelectedThreadId(threadId);
      selectedThreadIdRef.current = threadId;
      codexStore.setActiveThread(threadId);
      window.localStorage.setItem(
        SELECTED_THREAD_KEY,
        JSON.stringify({ workspaceId: workspace.id, threadId })
      );
      setRecoveringThread(true);
      setThreadError(null);
      const existing = codexStore.getSnapshot().threads[threadId];
      const archived = existing?.archived === true;
      const preferences = preferencesFromMetadata(metadataRef.current[threadId], settings);
      try {
        const read = await api.readCodexThread(threadId, true);
        const hydrated = archived ? { ...read, archived: true } : read;
        codexStore.upsertThreads([hydrated]);
        const ui = await ensureMetadata(workspace, hydrated, preferences);
        if (ui.unread || !ui.lastViewedAt) {
          void persistMetadata({
            ...ui,
            unread: false,
            lastViewedAt: nowIso(),
            updatedAt: nowIso()
          });
        }
        if (!archived) {
          const session = await api.resumeCodexThread(workspace.path, threadId, preferences);
          codexStore.setSession(session);
        }
      } catch (error) {
        if (existing) codexStore.upsertThreads([existing]);
        setThreadError(`Unable to resume this Codex thread: ${String(error)}`);
      } finally {
        setRecoveringThread(false);
      }
    },
    [ensureMetadata, persistMetadata, settings]
  );

  const createThread = useCallback(async () => {
    const workspace = selectedWorkspaceRef.current;
    if (!workspace) {
      showToast('Add a local project first', 'error');
      return;
    }
    setThreadError(null);
    setRecoveringThread(true);
    try {
      const preferences = preferencesFromSettings(settings);
      const session = await api.startCodexThread(workspace.path, preferences, false);
      codexStore.setSession(session);
      setVisibleThreadIds((current) =>
        current.includes(session.thread.id) ? current : [session.thread.id, ...current]
      );
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
  }, [ensureMetadata, settings, showToast]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      api.getSettings(),
      api.listWorkspaces(),
      api.getCodexDiagnostics(),
      api.getAppStorageRoot(),
      api.getCodexCatalog()
    ]).then((results) => {
      if (cancelled) return;
      const [settingsResult, workspacesResult, diagnosticsResult, rootResult, catalogResult] = results;
      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value);
        const appearance = normalizeAppearanceMode(settingsResult.value.appearanceMode);
        applyAppearanceMode(appearance);
        persistAppearanceMode(appearance);
      }
      if (workspacesResult.status === 'fulfilled') {
        const locals = workspacesResult.value;
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
      if (diagnosticsResult.status === 'fulfilled') {
        codexStore.setDiagnostics(diagnosticsResult.value);
      }
      if (rootResult.status === 'fulfilled') setDataRoot(rootResult.value);
      if (catalogResult.status === 'fulfilled') {
        setCatalog(catalogResult.value);
      } else {
        setFatalError(`Codex app server is unavailable: ${String(catalogResult.reason)}`);
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
      codexStore.queueEvent(event);
      const workspace = selectedWorkspaceRef.current;
      if (event.thread && workspace && workspaceMatchesThread(workspace, event.thread, metadataRef.current[event.thread.id])) {
        setVisibleThreadIds((current) =>
          current.includes(event.thread!.id) ? current : [event.thread!.id, ...current]
        );
      }
      if (
        event.kind === 'turnCompleted' &&
        event.threadId &&
        (event.threadId !== selectedThreadIdRef.current || document.hidden)
      ) {
        const completedThread =
          event.thread ?? codexStore.getSnapshot().threads[event.threadId];
        const workspace = selectedWorkspaceRef.current;
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
        scheduleGitRefresh();
      }
      if (
        event.kind === 'accountUpdated' ||
        event.kind === 'rateLimitsUpdated' ||
        event.kind === 'accountLoginCompleted'
      ) {
        void api.getCodexCatalog().then(setCatalog).catch(() => undefined);
      }
    }).then((stop) => (disposed ? releaseTauriListener(stop) : unlisten.push(stop)));
    void apiModule.onCodexRuntimeState((diagnostics) => {
      const previous = connectionStateRef.current;
      connectionStateRef.current = diagnostics.connectionState;
      codexStore.setDiagnostics(diagnostics);
      if (diagnostics.connectionState === 'ready') {
        setFatalError(null);
        void api.getCodexCatalog().then(setCatalog).catch(() => undefined);
        if (
          ['degraded', 'restarting', 'failed'].includes(previous) &&
          selectedThreadIdRef.current
        ) {
          void openThread(selectedThreadIdRef.current);
        }
      }
    }).then((stop) => (disposed ? releaseTauriListener(stop) : unlisten.push(stop)));
    return () => {
      disposed = true;
      unlisten.forEach(releaseTauriListener);
    };
  }, [
    ensureMetadata,
    openThread,
    persistMetadata,
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
    if (!selectedWorkspace) return;
    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, selectedWorkspace.id);
    setSelectedThreadId(null);
    selectedThreadIdRef.current = null;
    codexStore.setActiveThread(null);
    setVisibleThreadIds([]);
    restoredWorkspace.current = null;
    void refreshThreads(selectedWorkspace);
    void refreshGit(selectedWorkspace);
    void api
      .listCodexRuntimeSkills(selectedWorkspace.path)
      .then((skills) => setRuntimeSkills(skills.filter((skill) => skill.enabled)))
      .catch(() => setRuntimeSkills([]));
  }, [refreshGit, refreshThreads, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const query = filter.trim();
    if (!query && !runtimeThreadFilter.current) return;
    const workspace = selectedWorkspace;
    const timer = window.setTimeout(() => {
      runtimeThreadFilter.current = query;
      void refreshThreads(workspace, query || undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter, refreshThreads, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace || loadingThreads || restoredWorkspace.current === selectedWorkspace.id) return;
    restoredWorkspace.current = selectedWorkspace.id;
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
    if (target) void openThread(target);
  }, [loadingThreads, openThread, selectedWorkspace, visibleThreadIds.join('|')]);

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
      setWorkspaces((current) => {
        const withoutDuplicate = current.filter((candidate) => candidate.id !== workspace.id);
        return [...withoutDuplicate, workspace];
      });
      setSelectedWorkspaceId(workspace.id);
    } catch (error) {
      showToast(`Could not add project: ${String(error)}`, 'error');
    }
  }, [showToast]);

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

  const pickAttachments = useCallback(async () => {
    if (!selectedWorkspace || !selectedThreadId) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: 'Attach files to this Codex turn'
    });
    const paths = typeof selected === 'string' ? [selected] : selected ?? [];
    if (!paths.length) return;
    const added = paths.map((path) => attachmentFromPath(path, selectedWorkspace.path));
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
      [selectedThreadId]: [...(current[selectedThreadId] ?? []), ...added]
    }));
  }, [selectedThreadId, selectedWorkspace]);

  const openProjectTerminal = useCallback(async () => {
    const workspace = selectedWorkspaceRef.current;
    if (!workspace) return;
    try {
      await api.openInTerminal(workspace.path);
    } catch (error) {
      showToast(`Could not open Project Terminal: ${String(error)}`, 'error');
    }
  }, [showToast]);

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
      const workspace = selectedWorkspaceRef.current;
      if (!workspace) return;
      const ui = metadataRef.current[thread.id];
      try {
        switch (action) {
          case 'open':
            await openThread(thread.id);
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
            await api.openInTerminal(workspace.path);
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
            await createThread();
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
            setVisibleThreadIds((current) =>
              current.includes(session.thread.id)
                ? current
                : [session.thread.id, ...current]
            );
            await ensureMetadata(workspace, session.thread, preferences);
            await openThread(session.thread.id);
            showToast('Forked Codex thread', 'success');
            break;
          }
          case 'archive':
            await api.archiveCodexThread(thread.id);
            codexStore.upsertThreads([{ ...thread, archived: true }]);
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
              await refreshThreads(workspace);
              if (reopening) {
                await openThread(thread.id);
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
            setVisibleThreadIds((current) => current.filter((threadId) => threadId !== thread.id));
            if (selectedThreadIdRef.current === thread.id) {
              setSelectedThreadId(null);
              codexStore.setActiveThread(null);
            }
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
      openThread,
      persistMetadata,
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
        label: 'Open Project Terminal',
        shortcut: '⌘J',
        icon: 'terminal',
        disabled: !selectedWorkspace,
        run: () => void openProjectTerminal()
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
    for (const thread of visibleThreads.slice(0, 12)) {
      actions.push({
        id: `thread-${thread.id}`,
        label: thread.title,
        description: `Switch thread · ${selectedWorkspace?.name ?? ''}`,
        icon: 'history',
        keywords: thread.preview,
        run: () => void openThread(thread.id)
      });
    }
    return actions;
  }, [
    createThread,
    catalog,
    openThread,
    pickProject,
    renameThread,
    restartRuntime,
    runThreadAction,
    selectedThread,
    selectedPreferences,
    selectedWorkspace,
    openProjectTerminal,
    updatePreferences,
    visibleThreads
  ]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        void createThread();
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
        void openProjectTerminal();
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
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.sidebar-search input')?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [
    createThread,
    pickProject,
    renameThread,
    runThreadAction,
    selectedRunningTurn,
    selectedThread,
    openProjectTerminal,
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
        threads={visibleThreads}
        metadata={metadata}
        approvals={codex.approvals as Record<string, CodexApprovalRequest>}
        filter={filter}
        connectionState={codex.diagnostics?.connectionState ?? 'stopped'}
        collapsed={sidebarCollapsed}
        onSelectWorkspace={setSelectedWorkspaceId}
        onAddWorkspace={() => void pickProject()}
        onNewThread={() => void createThread()}
        onSelectThread={(threadId) => void openThread(threadId)}
        onRenameThread={renameThread}
        onOpenThreadMenu={(threadId, x, y) => setContextMenu({ threadId, x, y })}
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
              onOpenMenu={(x, y) => setContextMenu({ threadId: selectedThread.id, x, y })}
              onToggleInspector={() => setInspectorOpen((value) => !value)}
              onOpenTerminal={() => void openProjectTerminal()}
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
                  onRespondToApproval={(approval, decision) => void respondToApproval(approval, decision)}
                  onRespondToUserInput={(approval, answers) => void respondToUserInput(approval, answers)}
                  onCopy={(value, label) => void copyText(value, label)}
                  onOpenFile={(path) => void api.openProjectFile(selectedWorkspace.path, path)}
                  onRevealPath={(path) => void api.revealProjectFile(selectedWorkspace.path, path)}
                  onRevertFile={(path) => void revertGitFile(path)}
                  onOpenTerminal={(path) => void api.openInTerminal(path)}
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
                  onOpenTerminal={(path) => void api.openInTerminal(path)}
                  onRestartRuntime={() => void restartRuntime()}
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      {contextMenu ? (() => {
        const thread = codex.threads[contextMenu.threadId];
        if (!thread || !selectedWorkspace) return null;
        return (
          <ThreadContextMenu
            thread={thread}
            workspace={selectedWorkspace}
            metadata={metadata[thread.id]}
            x={contextMenu.x}
            y={contextMenu.y}
            onAction={(action) => void runThreadAction(thread, action)}
            onClose={() => setContextMenu(null)}
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
