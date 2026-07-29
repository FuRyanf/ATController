export type RunStatus = 'Idle' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
export type TerminalSessionMode = 'resumed' | 'new' | 'forked';
export type TerminalTurnCompletionMode = 'idle' | 'jsonl';
export type WorkspaceKind = 'local' | 'rdev' | 'ssh';
export type AppearanceMode = 'dark' | 'light' | 'system';

export const TERMINAL_SCROLLBACK_LINES_MIN = 10_000;
export const TERMINAL_SCROLLBACK_LINES_DEFAULT = 100_000;
export const TERMINAL_SCROLLBACK_LINES_MAX = 250_000;

export function normalizeTerminalScrollbackLines(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_SCROLLBACK_LINES_DEFAULT;
  }
  return Math.min(
    TERMINAL_SCROLLBACK_LINES_MAX,
    Math.max(TERMINAL_SCROLLBACK_LINES_MIN, Math.round(value))
  );
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  kind?: WorkspaceKind;
  rdevSshCommand?: string | null;
  sshCommand?: string | null;
  remotePath?: string | null;
  gitPullOnMasterForNewThreads: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetadata {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
  lastRunStatus: RunStatus;
  lastRunStartedAt?: string | null;
  lastRunEndedAt?: string | null;
  fullAccess: boolean;
  enabledSkills: string[];
  codexSessionId?: string | null;
  forkedFromCodexSessionId?: string | null;
  pendingForkSourceCodexSessionId?: string | null;
  pendingForkKnownChildSessionIds?: string[];
  pendingForkRequestedAt?: string | null;
  pendingForkLaunchConsumed?: boolean;
  lastResumeAt?: string | null;
  lastNewSessionAt?: string | null;
}

export interface CreateThreadOptions {
  fullAccess?: boolean;
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
}

export interface GitPullForNewThreadResult {
  outcome: 'pulled' | 'skipped' | 'failed';
  message: string;
}

export interface Settings {
  codexCliPath?: string | null;
  appearanceMode?: AppearanceMode | null;
  defaultNewThreadFullAccess?: boolean;
  taskCompletionAlerts?: boolean;
  terminalScrollbackLines?: number;
}

export interface ImportableCodexSession {
  sessionId: string;
  summary?: string | null;
  firstPrompt?: string | null;
  messageCount: number;
  createdAt?: string | null;
  modifiedAt?: string | null;
  gitBranch?: string | null;
}

export interface ImportableCodexProject {
  path: string;
  name: string;
  pathExists: boolean;
  workspaceId?: string | null;
  workspaceName?: string | null;
  sessions: ImportableCodexSession[];
}

export interface RecentCodexThread {
  sessionId: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
}

export interface CodexReasoningEffortOption {
  value: string;
  description: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  supportsFastMode: boolean;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number | null;
}

export interface CodexRuntimeOverview {
  models: CodexModelOption[];
  selectedModel: string;
  selectedReasoningEffort: string;
  fastMode: boolean;
  fiveHourLimit?: CodexRateLimitWindow | null;
  weeklyLimit?: CodexRateLimitWindow | null;
  planType?: string | null;
}

export interface CodexRuntimePreferences {
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  releaseUrl?: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  entryPoints: string[];
  path: string;
  relativePath: string;
  isGlobal?: boolean;
  warning?: string | null;
}

export interface TerminalStartResponse {
  sessionId: string;
  sessionMode: TerminalSessionMode;
  resumeSessionId?: string | null;
  turnCompletionMode?: TerminalTurnCompletionMode;
  currentCwd?: string | null;
  thread: ThreadMetadata;
}

export interface PreparedNativeFork {
  sourceCodexSessionId: string;
  knownChildSessionIds: string[];
  requestedAt: string;
}

export interface WorkspaceShellStartResponse {
  sessionId: string;
}

export interface TerminalDataEvent {
  sessionId: string;
  threadId?: string | null;
  data: string;
  startPosition: number;
  endPosition: number;
}

export interface TerminalOutputSnapshot {
  text: string;
  startPosition: number;
  endPosition: number;
  truncated: boolean;
}

export interface TerminalReadyEvent {
  sessionId: string;
  threadId?: string | null;
}

export type TerminalSshAuthStatusReason =
  | 'host-verification-required'
  | 'password-auth-unsupported'
  | 'interactive-auth-unsupported';

export interface TerminalSshAuthStatusEvent {
  sessionId: string;
  workspaceId: string;
  threadId?: string | null;
  reason: TerminalSshAuthStatusReason;
}

export interface TerminalExitEvent {
  sessionId: string;
  code?: number | null;
  signal?: string | null;
  persistenceError?: string | null;
}

export interface TerminalTurnCompletedEvent {
  sessionId: string;
  threadId?: string | null;
  status?: Extract<RunStatus, 'Succeeded' | 'Failed'>;
  hasMeaningfulOutput?: boolean;
  completedAtMs?: number | null;
  completionIndex?: number | null;
  currentCwd?: string | null;
}

export interface CodexTurnCompletionSummary {
  codexSessionId: string;
  completionIndex: number;
  completedAtMs: number;
  status: Extract<RunStatus, 'Succeeded' | 'Failed'>;
  hasMeaningfulOutput: boolean;
}
