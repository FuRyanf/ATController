export type AppearanceMode = 'dark' | 'light' | 'system';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  workspaceType: 'local' | string;
  lastOpenedAt?: string | null;
  isPinned: boolean;
  sortOrder: number;
  isExpanded: boolean;
  iconPreference?: string | null;
  isAvailable: boolean;
  gitPullOnMasterForNewThreads: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceUpdate {
  displayName?: string | null;
  isPinned?: boolean | null;
  isExpanded?: boolean | null;
  iconPreference?: string | null;
  clearIconPreference?: boolean;
  markOpened?: boolean;
}

export interface CodexDiscoveredProject {
  name: string;
  workspacePath: string;
  threadCount: number;
  activeThreadCount: number;
  archivedThreadCount: number;
  mostRecentActivity?: number | null;
  alreadyAdded: boolean;
  available: boolean;
  threadIds: string[];
}

export type ProjectSortMode = 'custom' | 'name' | 'recent' | 'running';

export interface ProjectTerminalSession {
  id: string;
  workspaceId: string;
  cwd: string;
  shell: string;
  processId?: number | null;
}

export interface ProjectTerminalOutput {
  sessionId: string;
  workspaceId: string;
  dataBase64: string;
  byteLength: number;
}

export interface ProjectTerminalExit {
  sessionId: string;
  workspaceId: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
}

export interface GitInfo {
  branch: string;
  shortHash: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
  isMainWorktree: boolean;
  worktreeLabel?: string | null;
  worktreePath?: string | null;
}

export interface GitBranchEntry {
  name: string;
  isCurrent: boolean;
  lastCommitUnix: number;
}

export interface GitWorkspaceStatus {
  isDirty: boolean;
  uncommittedFiles: number;
  insertions: number;
  deletions: number;
  files: GitChangedFile[];
}

export interface GitChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted' | string;
  staged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitPullForNewThreadResult {
  outcome: 'pulled' | 'skipped' | 'failed';
  message: string;
}

export interface Settings {
  codexCliPath?: string | null;
  appearanceMode?: AppearanceMode | null;
  defaultNewThreadFullAccess?: boolean;
  defaultPermissionMode?: PermissionMode;
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
  defaultServiceTier?: string | null;
  resumeTerminalBehavior?: 'insertForReview' | 'executeImmediately';
  commandEnterToSend?: boolean;
  taskCompletionAlerts?: boolean;
}

export type PermissionMode = 'standard' | 'workspaceAccess' | 'fullAccess';
export type CodexConnectionState =
  | 'stopped'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'restarting'
  | 'failed'
  | 'stopping';

export interface CodexDiagnostics {
  atcontrollerVersion: string;
  codexBinaryPath?: string | null;
  codexVersion?: string | null;
  appServerSupported: boolean;
  generatedSchemaVersion: string;
  transport: string;
  connectionState: CodexConnectionState;
  initialized: boolean;
  processId?: number | null;
  processUptimeMs?: number | null;
  codexHome?: string | null;
  platformFamily?: string | null;
  platformOs?: string | null;
  authenticationState?: string | null;
  planType?: string | null;
  currentModel?: string | null;
  currentReasoningEffort?: string | null;
  currentPermissionProfile?: string | null;
  approvalPolicy?: string | null;
  sandboxPolicy?: string | null;
  workspacePath?: string | null;
  activeThreadId?: string | null;
  activeTurnId?: string | null;
  pendingRequests: number;
  eventQueueDepth: number;
  recentStderr: string[];
  recentProtocolErrors: string[];
  lastProcessExit?: {
    code?: number | null;
    signal?: string | null;
    summary: string;
  } | null;
  restartAttempts: number;
}

export interface CodexFileChange {
  path: string;
  kind: string;
  diff: string;
}

export interface CodexInputPart {
  kind: string;
  text?: string | null;
  path?: string | null;
  url?: string | null;
  name?: string | null;
}

export interface CodexError {
  message: string;
  details?: string | null;
  kind?: string | null;
  willRetry: boolean;
}

export interface CodexItem {
  id: string;
  kind: string;
  status?: string | null;
  phase?: string | null;
  text?: string | null;
  summary: string[];
  reasoning: string[];
  content: CodexInputPart[];
  command?: string | null;
  cwd?: string | null;
  output?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes: CodexFileChange[];
  toolName?: string | null;
  toolServer?: string | null;
  toolArguments?: unknown;
  toolResult?: unknown;
  error?: string | null;
  details?: unknown;
}

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress' | string;
  items: CodexItem[];
  itemsView: string;
  error?: CodexError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  title: string;
  preview: string;
  cwd: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: string;
  source: string;
  cliVersion: string;
  archived: boolean;
  turns: CodexTurn[];
}

export interface EffectiveThreadSettings {
  requestedModel?: string | null;
  effectiveModel?: string | null;
  modelResolution: 'applied' | 'runtimeDefault' | 'runtimeFallback' | string;
  requestedReasoningEffort?: string | null;
  effectiveReasoningEffort?: string | null;
  reasoningEffortResolution: 'applied' | 'runtimeDefault' | 'runtimeFallback' | string;
  requestedServiceTier?: string | null;
  effectiveServiceTier?: string | null;
  serviceTierResolution: 'applied' | 'runtimeDefault' | 'runtimeFallback' | string;
  permissionMode: PermissionMode;
  permissionProfile: string;
  approvalPolicy: string;
  sandboxPolicy: string;
  cwd: string;
}

export interface CodexThreadSession {
  thread: CodexThread;
  settings: EffectiveThreadSettings;
  instructionSources: string[];
}

export interface CodexThreadPage {
  data: CodexThread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadPreferences {
  permissionMode: PermissionMode;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

export interface CodexReasoningOption {
  value: string;
  description: string;
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  reasoningEfforts: CodexReasoningOption[];
  serviceTiers: CodexServiceTier[];
  defaultServiceTier?: string | null;
  inputModalities: string[];
}

export interface CodexRateLimitWindowV2 {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexAccount {
  signedIn: boolean;
  authenticationMode?: string | null;
  planType?: string | null;
  requiresOpenaiAuth: boolean;
  fiveHourLimit?: CodexRateLimitWindowV2 | null;
  weeklyLimit?: CodexRateLimitWindowV2 | null;
}

export interface CodexPermissionProfile {
  id: string;
  description?: string | null;
  allowed: boolean;
}

export interface CodexRuntimeCatalog {
  models: CodexModel[];
  account: CodexAccount;
  permissionProfiles: CodexPermissionProfile[];
  configuredModel?: string | null;
  configuredReasoningEffort?: string | null;
  configuredServiceTier?: string | null;
}

export interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string | null;
  path: string;
  scope: string;
  enabled: boolean;
}

export interface CodexLoginSession {
  loginId: string;
  authorizationUrl: string;
}

export type ComposerInput =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      url: string;
      detail?: 'auto' | 'low' | 'high' | 'original' | null;
    }
  | {
      type: 'localImage';
      path: string;
      detail?: 'auto' | 'low' | 'high' | 'original' | null;
      allowOutsideWorkspace?: boolean;
    }
  | { type: 'file'; path: string; name?: string | null; allowOutsideWorkspace?: boolean }
  | { type: 'skill'; name: string; path: string };

export interface CodexTokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  lastTotalTokens: number;
  modelContextWindow?: number | null;
}

export interface CodexApprovalRequest {
  requestId: string | number;
  approvalType: 'commandExecution' | 'fileChange' | 'permissions' | 'userInput' | 'mcpElicitation' | 'unsupported';
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  networkHost?: string | null;
  networkProtocol?: string | null;
  grantRoot?: string | null;
  requestedPermissions?: unknown;
  availableDecisions: string[];
  payload?: unknown;
}

export interface CodexEvent {
  sequence: number;
  kind: string;
  method: string;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  status?: string | null;
  delta?: string | null;
  thread?: CodexThread | null;
  turn?: CodexTurn | null;
  item?: CodexItem | null;
  approval?: CodexApprovalRequest | null;
  tokenUsage?: CodexTokenUsage | null;
  error?: CodexError | null;
  data?: unknown;
}

export type ServerRequestResponse =
  | { type: 'command'; requestId: string | number; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }
  | { type: 'fileChange'; requestId: string | number; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }
  | { type: 'permissions'; requestId: string | number; grant: boolean; scope?: 'turn' | 'session' | null }
  | { type: 'userInput'; requestId: string | number; answers: Record<string, string[]> }
  | { type: 'mcpElicitation'; requestId: string | number; action: 'accept' | 'decline' | 'cancel'; content?: unknown };

export interface CodexThreadUiMetadata {
  threadId: string;
  workspaceId: string;
  fallbackTitle: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  draft: string;
  promptHistory: string[];
  permissionMode: PermissionMode;
  requestedModel?: string | null;
  requestedReasoningEffort?: string | null;
  requestedServiceTier?: string | null;
  lastViewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeCommandRequest {
  threadId: string;
  workspacePath: string;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  fullAccess: boolean;
}

export interface CodexResumeCommand {
  command: string;
  binaryPath: string;
  arguments: string[];
  workingDirectory: string;
  fullAccess: boolean;
}
