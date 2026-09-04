import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  BrowserActionRequest,
  BrowserDiagnostics,
  BrowserScreenshot,
  BrowserSelfTestResult,
  BrowserSessionMetadata,
  BrowserSetupPlan,
  CodexDiscoveredProject,
  CodexDiagnostics,
  CodexEvent,
  CodexLoginSession,
  CodexPlugin,
  CodexRuntimeCatalog,
  CodexResumeCommand,
  CodexSkill,
  CodexThread,
  CodexThreadPage,
  CodexThreadSession,
  CodexThreadUiMetadata,
  CodexTurn,
  ComposerInput,
  GitBranchEntry,
  GitInfo,
  GitPullForNewThreadResult,
  GitWorkspaceStatus,
  ProjectTerminalExit,
  ProjectTerminalOutput,
  ProjectTerminalSession,
  ResumeCommandRequest,
  ServerRequestResponse,
  Settings,
  ThreadPreferences,
  Workspace,
  WorkspaceUpdate
} from '../types';

export const events = {
  browserState: 'browser:state',
  codexEvent: 'codex:event',
  codexEventBatch: 'codex:events',
  codexRuntimeState: 'codex:runtime-state',
  projectTerminalOutput: 'atcontroller://project-terminal-output',
  projectTerminalExit: 'atcontroller://project-terminal-exit'
} as const;

export const api = {
  getBrowserDiagnostics: (
    threadId?: string | null,
    probeRuntime = false
  ) =>
    invoke<BrowserDiagnostics>('browser_get_diagnostics', {
      threadId: threadId ?? null,
      probeRuntime
    }),
  getBrowserSetupPlan: () =>
    invoke<BrowserSetupPlan>('browser_get_setup_plan'),
  configureBrowser: () =>
    invoke<BrowserDiagnostics>('browser_configure'),
  getBrowserSession: (threadId: string) =>
    invoke<BrowserSessionMetadata>('browser_get_session', { threadId }),
  listBrowserSessions: () =>
    invoke<BrowserSessionMetadata[]>('browser_list_sessions'),
  performBrowserAction: (request: BrowserActionRequest) =>
    invoke<BrowserSessionMetadata>('browser_perform_action', { request }),
  runBrowserSelfTest: (threadId: string, workspacePath: string) =>
    invoke<BrowserSelfTestResult>('browser_run_self_test', {
      threadId,
      workspacePath
    }),
  readBrowserScreenshot: (threadId: string, reference: string) =>
    invoke<BrowserScreenshot>('browser_read_screenshot', { threadId, reference }),
  revealBrowserScreenshot: (threadId: string, reference: string) =>
    invoke<void>('browser_reveal_screenshot', { threadId, reference }),
  deleteBrowserScreenshot: (threadId: string, reference: string) =>
    invoke<void>('browser_delete_screenshot', { threadId, reference }),
  openBrowserCache: () => invoke<void>('browser_open_cache'),
  reportFrontendError: (message: string) =>
    invoke<void>('report_frontend_error', { message }),
  getAppStorageRoot: () => invoke<string>('get_app_storage_root'),
  getCodexDiagnostics: () => invoke<CodexDiagnostics>('codex_get_diagnostics'),
  restartCodexRuntime: () => invoke<CodexDiagnostics>('codex_restart_runtime'),
  runCodexSelfTest: () => invoke<Record<string, unknown>>('codex_run_self_test'),
  regenerateCodexProtocolSnapshot: () =>
    invoke<string>('codex_regenerate_protocol_snapshot'),
  getCodexCatalog: () => invoke<CodexRuntimeCatalog>('codex_get_runtime_catalog'),
  startCodexChatgptLogin: () =>
    invoke<CodexLoginSession>('codex_start_chatgpt_login'),
  listCodexThreads: (params: {
    workspacePath: string;
    archived?: boolean;
    searchTerm?: string | null;
    cursor?: string | null;
    limit?: number;
  }) =>
    invoke<CodexThreadPage>('codex_list_threads', {
      workspacePath: params.workspacePath,
      archived: params.archived ?? false,
      searchTerm: params.searchTerm ?? null,
      cursor: params.cursor ?? null,
      limit: params.limit ?? 100
    }),
  discoverCodexProjects: () =>
    invoke<CodexDiscoveredProject[]>('codex_discover_projects'),
  readCodexThread: (threadId: string, includeTurns = true) =>
    invoke<CodexThread>('codex_read_thread', { threadId, includeTurns }),
  startCodexThread: (
    workspacePath: string,
    preferences: ThreadPreferences,
    clearReplacement = false
  ) =>
    invoke<CodexThreadSession>('codex_start_thread', {
      workspacePath,
      preferences,
      clearReplacement
    }),
  resumeCodexThread: (
    workspacePath: string,
    threadId: string,
    preferences: ThreadPreferences
  ) =>
    invoke<CodexThreadSession>('codex_resume_thread', {
      workspacePath,
      threadId,
      preferences
    }),
  unsubscribeCodexThread: (threadId: string) =>
    invoke<string>('codex_unsubscribe_thread', { threadId }),
  forkCodexThread: (
    workspacePath: string,
    threadId: string,
    lastTurnId: string | null,
    preferences: ThreadPreferences
  ) =>
    invoke<CodexThreadSession>('codex_fork_thread', {
      workspacePath,
      threadId,
      lastTurnId,
      preferences
    }),
  renameCodexThread: (threadId: string, name: string) =>
    invoke<void>('codex_rename_thread', { threadId, name }),
  archiveCodexThread: (threadId: string) =>
    invoke<void>('codex_archive_thread', { threadId }),
  unarchiveCodexThread: (threadId: string) =>
    invoke<CodexThread>('codex_unarchive_thread', { threadId }),
  deleteCodexThread: (threadId: string) =>
    invoke<void>('codex_delete_thread', { threadId }),
  startCodexTurn: (
    workspacePath: string,
    threadId: string,
    clientUserMessageId: string,
    inputs: ComposerInput[],
    preferences: ThreadPreferences
  ) =>
    invoke<CodexTurn>('codex_start_turn', {
      workspacePath,
      threadId,
      clientUserMessageId,
      inputs,
      preferences
    }),
  steerCodexTurn: (
    workspacePath: string,
    threadId: string,
    turnId: string,
    clientUserMessageId: string,
    inputs: ComposerInput[]
  ) =>
    invoke<void>('codex_steer_turn', {
      workspacePath,
      threadId,
      turnId,
      clientUserMessageId,
      inputs
    }),
  interruptCodexTurn: (threadId: string, turnId: string) =>
    invoke<void>('codex_interrupt_turn', { threadId, turnId }),
  respondToCodexRequest: (response: ServerRequestResponse) =>
    invoke<void>('codex_respond_to_server_request', { response }),
  listCodexRuntimeSkills: (workspacePath: string, forceReload = false) =>
    invoke<CodexSkill[]>('codex_list_runtime_skills', { workspacePath, forceReload }),
  listCodexRuntimePlugins: (workspacePath: string) =>
    invoke<CodexPlugin[]>('codex_list_runtime_plugins', { workspacePath }),
  buildCodexResumeCommand: (request: ResumeCommandRequest) =>
    invoke<CodexResumeCommand>('codex_build_resume_command', { request }),
  openCodexResumeInTerminal: (request: ResumeCommandRequest, execute: boolean) =>
    invoke<CodexResumeCommand>('codex_open_resume_in_terminal', { request, execute }),
  listCodexThreadUiMetadata: (workspaceId: string) =>
    invoke<CodexThreadUiMetadata[]>('list_codex_thread_ui_metadata', { workspaceId }),
  getCodexThreadUiMetadata: (workspaceId: string, threadId: string) =>
    invoke<CodexThreadUiMetadata>('get_codex_thread_ui_metadata', { workspaceId, threadId }),
  saveCodexThreadUiMetadata: (metadata: CodexThreadUiMetadata) =>
    invoke<CodexThreadUiMetadata>('save_codex_thread_ui_metadata', { metadata }),
  setCodexThreadOrder: (workspaceId: string, threadIds: string[]) =>
    invoke<CodexThreadUiMetadata[]>('set_codex_thread_order', {
      workspaceId,
      threadIds
    }),
  listWorkspaces: () => invoke<Workspace[]>('list_workspaces'),
  addWorkspace: (path: string) => invoke<Workspace>('add_workspace', { path }),
  updateWorkspace: (workspaceId: string, update: WorkspaceUpdate) =>
    invoke<Workspace>('update_workspace', { workspaceId, update }),
  relocateWorkspace: (workspaceId: string, path: string) =>
    invoke<Workspace>('relocate_workspace', { workspaceId, path }),
  cloneRepository: (repository: string, destinationParent: string) =>
    invoke<Workspace>('clone_repository', { repository, destinationParent }),
  removeWorkspace: (workspaceId: string) => invoke<boolean>('remove_workspace', { workspaceId }),
  setWorkspaceOrder: (workspaceIds: string[]) => invoke<Workspace[]>('set_workspace_order', { workspaceIds }),
  buildProjectShellCommand: (workspaceId: string) =>
    invoke<string>('build_project_shell_command', { workspaceId }),
  setWorkspaceGitPullOnMasterForNewThreads: (workspaceId: string, enabled: boolean) =>
    invoke<Workspace>('set_workspace_git_pull_on_master_for_new_threads', { workspaceId, enabled }),
  getGitInfo: (workspacePath: string) =>
    invoke<GitInfo | null>('get_git_info', { workspacePath }),
  gitListBranches: (workspacePath: string) =>
    invoke<GitBranchEntry[]>('git_list_branches', { workspacePath }),
  gitWorkspaceStatus: (workspacePath: string) =>
    invoke<GitWorkspaceStatus>('git_workspace_status', { workspacePath }),
  gitWorkspaceDiff: (workspacePath: string, filePath?: string | null) =>
    invoke<string>('git_workspace_diff', { workspacePath, filePath: filePath ?? null }),
  gitRevertFile: (workspacePath: string, filePath: string) =>
    invoke<boolean>('git_revert_file', { workspacePath, filePath }),
  gitCheckoutBranch: (workspacePath: string, branchName: string) =>
    invoke<boolean>('git_checkout_branch', { workspacePath, branchName }),
  gitCreateBranch: (workspacePath: string, branchName: string) =>
    invoke<boolean>('git_create_branch', { workspacePath, branchName }),
  gitPullMasterForNewThread: (workspacePath: string) =>
    invoke<GitPullForNewThreadResult>('git_pull_master_for_new_thread', { workspacePath }),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  openInFinder: (path: string) => invoke<void>('open_in_finder', { path }),
  openCodexConfiguration: () => invoke<void>('open_codex_configuration'),
  openProjectFile: (workspacePath: string, filePath: string) =>
    invoke<void>('open_project_file', { workspacePath, filePath }),
  revealProjectFile: (workspacePath: string, filePath: string) =>
    invoke<void>('reveal_project_file', { workspacePath, filePath }),
  openExternalUrl: (url: string) => invoke<void>('open_external_url', { url }),
  sendDesktopNotification: (title: string, body: string) =>
    invoke<boolean>('send_desktop_notification', { title, body }),
  setAppBadgeCount: (count: number | null) => invoke<boolean>('set_app_badge_count', { count }),
  writeTextToClipboard: (text: string) =>
    invoke<void>('write_text_to_clipboard', { text }),
  listProjectTerminals: () =>
    invoke<ProjectTerminalSession[]>('project_terminal_list'),
  startProjectTerminal: (
    workspaceId: string,
    cwd: string | null,
    cols: number,
    rows: number
  ) =>
    invoke<ProjectTerminalSession>('project_terminal_start', {
      workspaceId,
      cwd,
      cols,
      rows
    }),
  writeProjectTerminal: (sessionId: string, data: string) =>
    invoke<void>('project_terminal_write', { sessionId, data }),
  resizeProjectTerminal: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('project_terminal_resize', { sessionId, cols, rows }),
  stopProjectTerminal: (sessionId: string) =>
    invoke<void>('project_terminal_stop', { sessionId }),
};

export const onBrowserState = async (
  handler: (session: BrowserSessionMetadata) => void
): Promise<UnlistenFn> =>
  listen<BrowserSessionMetadata>(events.browserState, (event) => {
    handler(event.payload);
  });

export const onCodexEvent = async (
  handler: (event: CodexEvent) => void
): Promise<UnlistenFn> => {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await listen<CodexEvent>(events.codexEvent, (event) => {
        handler(event.payload);
      })
    );
    unlisteners.push(
      await listen<CodexEvent[]>(events.codexEventBatch, (event) => {
        for (const payload of event.payload) handler(payload);
      })
    );
  } catch (error) {
    unlisteners.forEach((unlisten) => unlisten());
    throw error;
  }
  return () => unlisteners.forEach((unlisten) => unlisten());
};

export const onCodexRuntimeState = async (
  handler: (diagnostics: CodexDiagnostics) => void
): Promise<UnlistenFn> =>
  listen<CodexDiagnostics>(events.codexRuntimeState, (event) => {
    handler(event.payload);
  });

export const onProjectTerminalOutput = async (
  handler: (output: ProjectTerminalOutput) => void
): Promise<UnlistenFn> =>
  listen<ProjectTerminalOutput>(events.projectTerminalOutput, (event) => {
    handler(event.payload);
  });

export const onProjectTerminalExit = async (
  handler: (exit: ProjectTerminalExit) => void
): Promise<UnlistenFn> =>
  listen<ProjectTerminalExit>(events.projectTerminalExit, (event) => {
    handler(event.payload);
  });
