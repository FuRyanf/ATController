import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppUpdateInfo,
  ContextPack,
  ContextPreview,
  FinalizedNativeFork,
  GitBranchEntry,
  GitDiffSummary,
  GitInfo,
  GitPullForNewThreadResult,
  GitWorkspaceStatus,
  ImportableClaudeProject,
  ImportableClaudeSession,
  PreparedNativeFork,
  RunClaudeRequest,
  RunClaudeResponse,
  RunExitEvent,
  RunStreamEvent,
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
  TranscriptEntry,
  Workspace
} from '../types';

export const events = {
  runStream: 'claude://run-stream',
  runExit: 'claude://run-exit',
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
  getGitDiffSummary: (workspacePath: string) =>
    invoke<GitDiffSummary>('get_git_diff_summary', { workspacePath }),
  gitListBranches: (workspacePath: string) =>
    invoke<GitBranchEntry[]>('git_list_branches', { workspacePath }),
  gitWorkspaceStatus: (workspacePath: string) =>
    invoke<GitWorkspaceStatus>('git_workspace_status', { workspacePath }),
  gitCheckoutBranch: (workspacePath: string, branchName: string) =>
    invoke<boolean>('git_checkout_branch', { workspacePath, branchName }),
  gitCreateAndCheckoutBranch: (workspacePath: string, branchName: string) =>
    invoke<boolean>('git_create_and_checkout_branch', { workspacePath, branchName }),
  gitPullMasterForNewThread: (workspacePath: string) =>
    invoke<GitPullForNewThreadResult>('git_pull_master_for_new_thread', { workspacePath }),
  listThreads: (workspaceId: string) =>
    invoke<ThreadMetadata[]>('list_threads', { workspaceId }),
  createThread: (workspaceId: string, agentId?: string, fullAccess?: boolean) =>
    invoke<ThreadMetadata>('create_thread', {
      workspaceId,
      agentId,
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
  clearThreadClaudeSession: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('clear_thread_claude_session', { workspaceId, threadId }),
  clearThreadPendingFork: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('clear_thread_pending_fork', { workspaceId, threadId }),
  markThreadPendingForkConsumed: (workspaceId: string, threadId: string) =>
    invoke<ThreadMetadata>('mark_thread_pending_fork_consumed', { workspaceId, threadId }),
  commitPreparedThreadPendingFork: (workspaceId: string, threadId: string, prepared: PreparedNativeFork) =>
    invoke<ThreadMetadata>('commit_prepared_thread_pending_fork', { workspaceId, threadId, prepared }),
  setThreadClaudeSessionId: (workspaceId: string, threadId: string, claudeSessionId: string) =>
    invoke<ThreadMetadata>('set_thread_claude_session_id', { workspaceId, threadId, claudeSessionId }),
  setThreadSkills: (workspaceId: string, threadId: string, enabledSkills: string[]) =>
    invoke<ThreadMetadata>('set_thread_skills', { workspaceId, threadId, enabledSkills }),
  setThreadAgent: (workspaceId: string, threadId: string, agentId: string) =>
    invoke<ThreadMetadata>('set_thread_agent', { workspaceId, threadId, agentId }),
  appendUserMessage: (workspaceId: string, threadId: string, content: string) =>
    invoke<TranscriptEntry>('append_user_message', { workspaceId, threadId, content }),
  loadTranscript: (workspaceId: string, threadId: string) =>
    invoke<TranscriptEntry[]>('load_transcript', { workspaceId, threadId }),
  listSkills: (workspacePath: string) => invoke<SkillInfo[]>('list_skills', { workspacePath }),
  buildContextPreview: (workspacePath: string, contextPack: ContextPack) =>
    invoke<ContextPreview>('build_context_preview', { workspacePath, contextPack }),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  detectClaudeCliPath: () => invoke<string | null>('detect_claude_cli_path'),
  checkForUpdate: () => invoke<AppUpdateInfo>('check_for_update'),
  installLatestUpdate: () => invoke<boolean>('install_latest_update'),
  runClaude: (request: RunClaudeRequest) =>
    invoke<RunClaudeResponse>('run_claude', { request }),
  cancelRun: (runId: string) => invoke<boolean>('cancel_run', { runId }),
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
    sourceClaudeSessionId: string,
    knownChildSessionIds: string[],
    requestedAfter?: string | null
  ) =>
    invoke<string | null>('resolve_thread_fork_candidate', {
      sourceClaudeSessionId,
      knownChildSessionIds,
      requestedAfter
    }),
  finalizeThreadNativeFork: (workspaceId: string, threadId: string, childClaudeSessionId: string) =>
    invoke<FinalizedNativeFork>('finalize_thread_native_fork', {
      workspaceId,
      threadId,
      childClaudeSessionId
    }),
  workspaceShellStartSession: (params: {
    workspacePath: string;
    initialCwd?: string | null;
    envVars?: Record<string, string> | null;
  }) =>
    invoke<WorkspaceShellStartResponse>('workspace_shell_start_session', params),
  terminalWrite: (sessionId: string, data: string) =>
    invoke<boolean>('terminal_write', { sessionId, data }),
  terminalRebindClaudeSession: (sessionId: string, claudeSessionId: string) =>
    invoke<boolean>('terminal_rebind_claude_session', { sessionId, claudeSessionId }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<boolean>('terminal_resize', { sessionId, cols, rows }),
  terminalKill: (sessionId: string) =>
    invoke<boolean>('terminal_kill', { sessionId }),
  terminalSendSignal: (sessionId: string, signal: string) =>
    invoke<boolean>('terminal_send_signal', { sessionId, signal }),
  terminalGetLastLog: (workspaceId: string, threadId: string) =>
    invoke<TerminalOutputSnapshot>('terminal_get_last_log', { workspaceId, threadId }),
  latestClaudeSessionCwd: (workspacePath: string, claudeSessionId: string) =>
    invoke<string | null>('latest_claude_session_cwd', { workspacePath, claudeSessionId }),
  terminalReadOutput: (sessionId: string) =>
    invoke<TerminalOutputSnapshot>('terminal_read_output', { sessionId }),
  generateCommitMessage: (workspacePath: string, fullAccess: boolean) =>
    invoke<string>('generate_commit_message', { workspacePath, fullAccess }),
  openInFinder: (path: string) => invoke<void>('open_in_finder', { path }),
  openInTerminal: (path: string) => invoke<void>('open_in_terminal', { path }),
  openExternalUrl: (url: string) => invoke<void>('open_external_url', { url }),
  openTerminalCommand: (command: string) => invoke<void>('open_terminal_command', { command }),
  setAppBadgeCount: (count: number | null) => invoke<boolean>('set_app_badge_count', { count }),
  copyTerminalEnvDiagnostics: (workspacePath: string) =>
    invoke<string>('copy_terminal_env_diagnostics', { workspacePath }),
  validateImportableClaudeSession: (workspacePath: string, claudeSessionId: string) =>
    invoke<boolean>('validate_importable_claude_session', { workspacePath, claudeSessionId }),
  discoverImportableClaudeSessions: () =>
    invoke<ImportableClaudeProject[]>('discover_importable_claude_sessions'),
  getImportableClaudeSession: (workspacePath: string, claudeSessionId: string) =>
    invoke<ImportableClaudeSession | null>('get_importable_claude_session', { workspacePath, claudeSessionId }),
  writeTextToClipboard: (text: string) =>
    invoke<void>('write_text_to_clipboard', { text }),
  writeImageToClipboard: (path: string) =>
    invoke<void>('write_image_to_clipboard', { path })
};

export const onRunStream = async (
  handler: (event: RunStreamEvent) => void
): Promise<UnlistenFn> =>
  listen<RunStreamEvent>(events.runStream, (event) => {
    handler(event.payload);
  });

export const onRunExit = async (
  handler: (event: RunExitEvent) => void
): Promise<UnlistenFn> =>
  listen<RunExitEvent>(events.runExit, (event) => {
    handler(event.payload);
  });

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
