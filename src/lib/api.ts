import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppUpdateInfo,
  CodexRuntimeOverview,
  CodexRuntimePreferences,
  CodexTurnCompletionSummary,
  GitBranchEntry,
  GitInfo,
  GitPullForNewThreadResult,
  GitWorkspaceStatus,
  ImportableCodexProject,
  ImportableCodexSession,
  PreparedNativeFork,
  RecentCodexThread,
  Settings,
  SkillInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOutputSnapshot,
  TerminalReadyEvent,
  TerminalSshAuthStatusEvent,
  TerminalStartResponse,
  TerminalTurnCompletedEvent,
  WorkspaceShellStartResponse,
  ThreadMetadata,
  Workspace
} from '../types';

export const events = {
  terminalData: 'terminal:data',
  terminalReady: 'terminal:ready',
  terminalSshAuthStatus: 'terminal:ssh-auth-status',
  terminalTurnCompleted: 'terminal:turn-completed',
  terminalExit: 'terminal:exit',
  threadUpdated: 'thread:updated'
} as const;

export const api = {
  getAppStorageRoot: () => invoke<string>('get_app_storage_root'),
  listWorkspaces: () => invoke<Workspace[]>('list_workspaces'),
  addWorkspace: (path: string) => invoke<Workspace>('add_workspace', { path }),
  addRdevWorkspace: (rdevSshCommand: string, displayName?: string | null) =>
    invoke<Workspace>('add_rdev_workspace', { rdevSshCommand, displayName }),
  addSshWorkspace: (sshCommand: string, displayName?: string | null, remotePath?: string | null) =>
    invoke<Workspace>('add_ssh_workspace', { sshCommand, displayName, remotePath }),
  removeWorkspace: (workspaceId: string) => invoke<boolean>('remove_workspace', { workspaceId }),
  setWorkspaceOrder: (workspaceIds: string[]) => invoke<Workspace[]>('set_workspace_order', { workspaceIds }),
  setWorkspaceGitPullOnMasterForNewThreads: (workspaceId: string, enabled: boolean) =>
    invoke<Workspace>('set_workspace_git_pull_on_master_for_new_threads', { workspaceId, enabled }),
  getGitInfo: (workspacePath: string) =>
    invoke<GitInfo | null>('get_git_info', { workspacePath }),
  gitListBranches: (workspacePath: string) =>
    invoke<GitBranchEntry[]>('git_list_branches', { workspacePath }),
  gitWorkspaceStatus: (workspacePath: string) =>
    invoke<GitWorkspaceStatus>('git_workspace_status', { workspacePath }),
  gitCheckoutBranch: (workspacePath: string, branchName: string) =>
    invoke<boolean>('git_checkout_branch', { workspacePath, branchName }),
  gitPullMasterForNewThread: (workspacePath: string) =>
    invoke<GitPullForNewThreadResult>('git_pull_master_for_new_thread', { workspacePath }),
  listThreads: (workspaceId: string) =>
    invoke<ThreadMetadata[]>('list_threads', { workspaceId }),
  createThread: (workspaceId: string, fullAccess?: boolean) =>
    invoke<ThreadMetadata>('create_thread', {
      workspaceId,
      ...(typeof fullAccess === 'boolean' ? { fullAccess } : {})
    }),
  renameThread: (workspaceId: string, threadId: string, title: string) =>
    invoke<ThreadMetadata>('rename_thread', { workspaceId, threadId, title }),
  archiveThread: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('archive_thread', { workspaceId, threadId }),
  deleteThread: (workspaceId: string, threadId: string) =>
    invoke<boolean>('delete_thread', { workspaceId, threadId }),
  setThreadFullAccess: (workspaceId: string, threadId: string, fullAccess: boolean) =>
    invoke<ThreadMetadata>('set_thread_full_access', { workspaceId, threadId, fullAccess }),
  clearThreadCodexSession: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('clear_thread_codex_session', { workspaceId, threadId }),
  clearThreadPendingFork: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('clear_thread_pending_fork', { workspaceId, threadId }),
  commitPreparedThreadPendingFork: (workspaceId: string, threadId: string, prepared: PreparedNativeFork) =>
    invoke<ThreadMetadata>('commit_prepared_thread_pending_fork', { workspaceId, threadId, prepared }),
  setThreadCodexSessionId: (workspaceId: string, threadId: string, codexSessionId: string) =>
    invoke<ThreadMetadata>('set_thread_codex_session_id', { workspaceId, threadId, codexSessionId }),
  setThreadSkills: (workspaceId: string, threadId: string, enabledSkills: string[]) =>
    invoke<ThreadMetadata>('set_thread_skills', { workspaceId, threadId, enabledSkills }),
  listSkills: (workspacePath: string) =>
    invoke<SkillInfo[]>('list_skills', { workspacePath }),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  detectCodexCliPath: () => invoke<string | null>('detect_codex_cli_path'),
  getCodexRuntimeOverview: () =>
    invoke<CodexRuntimeOverview>('get_codex_runtime_overview'),
  updateCodexRuntimePreferences: (preferences: CodexRuntimePreferences) =>
    invoke<CodexRuntimeOverview>('update_codex_runtime_preferences', { preferences }),
  listRecentCodexThreads: () =>
    invoke<RecentCodexThread[]>('list_recent_codex_threads'),
  checkForUpdate: () => invoke<AppUpdateInfo>('check_for_update'),
  installLatestUpdate: () => invoke<boolean>('install_latest_update'),
  terminalStartSession: (params: {
    workspacePath: string;
    initialCwd?: string | null;
    envVars?: Record<string, string> | null;
    fullAccessFlag: boolean;
    threadId: string;
  }) =>
    invoke<TerminalStartResponse>('terminal_start_session', params),
  prepareThreadNativeFork: (workspaceId: string, threadId: string, terminalSessionId: string) =>
    invoke<PreparedNativeFork>('prepare_thread_native_fork', {
      workspaceId,
      threadId,
      terminalSessionId
    }),
  resolveThreadForkCandidate: (
    sourceCodexSessionId: string,
    knownChildSessionIds: string[],
    requestedAfter?: string | null
  ) =>
    invoke<string | null>('resolve_thread_fork_candidate', {
      sourceCodexSessionId,
      knownChildSessionIds,
      requestedAfter
    }),
  workspaceShellStartSession: (params: {
    workspacePath: string;
    initialCwd?: string | null;
    envVars?: Record<string, string> | null;
  }) =>
    invoke<WorkspaceShellStartResponse>('workspace_shell_start_session', params),
  terminalWrite: (sessionId: string, data: string) =>
    invoke<boolean>('terminal_write', { sessionId, data }),
  terminalRebindCodexSession: (sessionId: string, codexSessionId: string) =>
    invoke<boolean>('terminal_rebind_codex_session', { sessionId, codexSessionId }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<boolean>('terminal_resize', { sessionId, cols, rows }),
  terminalKill: (sessionId: string) =>
    invoke<boolean>('terminal_kill', { sessionId }),
  terminalSendSignal: (sessionId: string, signal: string) =>
    invoke<boolean>('terminal_send_signal', { sessionId, signal }),
  terminalGetLastLog: (workspaceId: string, threadId: string) =>
    invoke<TerminalOutputSnapshot>('terminal_get_last_log', { workspaceId, threadId }),
  latestCodexSessionCwd: (workspacePath: string, codexSessionId: string) =>
    invoke<string | null>('latest_codex_session_cwd', { workspacePath, codexSessionId }),
  latestCodexTurnCompletion: (workspacePath: string, codexSessionId: string) =>
    invoke<CodexTurnCompletionSummary | null>('latest_codex_turn_completion', {
      workspacePath,
      codexSessionId
    }),
  terminalReadOutput: (sessionId: string) =>
    invoke<TerminalOutputSnapshot>('terminal_read_output', { sessionId }),
  openInFinder: (path: string) => invoke<void>('open_in_finder', { path }),
  openInTerminal: (path: string) => invoke<void>('open_in_terminal', { path }),
  openExternalUrl: (url: string) => invoke<void>('open_external_url', { url }),
  openTerminalCommand: (command: string) => invoke<void>('open_terminal_command', { command }),
  setAppBadgeCount: (count: number | null) => invoke<boolean>('set_app_badge_count', { count }),
  copyTerminalEnvDiagnostics: (workspacePath: string) =>
    invoke<string>('copy_terminal_env_diagnostics', { workspacePath }),
  discoverImportableCodexSessions: () =>
    invoke<ImportableCodexProject[]>('discover_importable_codex_sessions'),
  getImportableCodexSession: (workspacePath: string, codexSessionId: string) =>
    invoke<ImportableCodexSession | null>('get_importable_codex_session', { workspacePath, codexSessionId }),
  importCodexSession: (
    workspaceId: string,
    codexSessionId: string,
    title: string | null,
    fullAccess: boolean
  ) =>
    invoke<ThreadMetadata>('import_codex_session', {
      workspaceId,
      codexSessionId,
      title,
      fullAccess
    }),
  writeTextToClipboard: (text: string) =>
    invoke<void>('write_text_to_clipboard', { text }),
  authorizeAttachmentPreview: (path: string) =>
    invoke<string>('authorize_attachment_preview', { path }),
};

export const onTerminalData = async (
  handler: (event: TerminalDataEvent) => void
): Promise<UnlistenFn> =>
  listen<TerminalDataEvent>(events.terminalData, (event) => {
    handler(event.payload);
  });

export const onTerminalReady = async (
  handler: (event: TerminalReadyEvent) => void
): Promise<UnlistenFn> =>
  listen<TerminalReadyEvent>(events.terminalReady, (event) => {
    handler(event.payload);
  });

export const onTerminalSshAuthStatus = async (
  handler: (event: TerminalSshAuthStatusEvent) => void
): Promise<UnlistenFn> =>
  listen<TerminalSshAuthStatusEvent>(events.terminalSshAuthStatus, (event) => {
    handler(event.payload);
  });

export const onTerminalTurnCompleted = async (
  handler: (event: TerminalTurnCompletedEvent) => void
): Promise<UnlistenFn> =>
  listen<TerminalTurnCompletedEvent>(events.terminalTurnCompleted, (event) => {
    handler(event.payload);
  });

export const onTerminalExit = async (
  handler: (event: TerminalExitEvent) => void
): Promise<UnlistenFn> =>
  listen<TerminalExitEvent>(events.terminalExit, (event) => {
    handler(event.payload);
  });

export const onThreadUpdated = async (
  handler: (event: ThreadMetadata) => void
): Promise<UnlistenFn> =>
  listen<ThreadMetadata>(events.threadUpdated, (event) => {
    handler(event.payload);
  });
