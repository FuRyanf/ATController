export type RunStatus = 'Idle' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
export type ContextPack = 'Minimal' | 'Git Diff' | 'Debug';
export type TerminalSessionMode = 'resumed' | 'new' | 'forked';
export type TerminalTurnCompletionMode = 'idle' | 'jsonl';
export type WorkspaceKind = 'local' | 'rdev' | 'ssh';
export type AppearanceMode = 'dark' | 'light' | 'system';
export type ClaudePermissionMode = 'fullAccess' | 'autoMode';
export type AgentProvider = 'claude' | 'copilot';

export const CLAUDE_AGENT_ID = 'claude-code';
export const COPILOT_AGENT_ID = 'github-copilot';

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

export function normalizeClaudePermissionMode(value?: string | null): ClaudePermissionMode {
  return value === 'autoMode' ? 'autoMode' : 'fullAccess';
}

export function normalizeAgentProvider(value?: string | null): AgentProvider {
  return value === 'copilot' ? 'copilot' : 'claude';
}

export function agentIdForProvider(provider?: AgentProvider | null): string {
  return normalizeAgentProvider(provider) === 'copilot' ? COPILOT_AGENT_ID : CLAUDE_AGENT_ID;
}

export function agentProviderFromAgentId(agentId?: string | null): AgentProvider {
  return agentId === COPILOT_AGENT_ID ? 'copilot' : 'claude';
}

export function agentLabel(provider?: AgentProvider | null): string {
  return normalizeAgentProvider(provider) === 'copilot' ? 'Copilot' : 'Claude';
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
  agentId: string;
  fullAccess: boolean;
  enabledSkills: string[];
  claudeSessionId?: string | null;
  copilotSessionId?: string | null;
  forkedFromClaudeSessionId?: string | null;
  pendingForkSourceClaudeSessionId?: string | null;
  pendingForkKnownChildSessionIds?: string[];
  pendingForkRequestedAt?: string | null;
  pendingForkLaunchConsumed?: boolean;
  lastResumeAt?: string | null;
  lastNewSessionAt?: string | null;
}

export interface CreateThreadOptions {
  fullAccess?: boolean;
  agentId?: string;
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  runId?: string | null;
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
  claudeCliPath?: string | null;
  copilotCliPath?: string | null;
  appearanceMode?: AppearanceMode | null;
  claudePermissionMode?: ClaudePermissionMode | null;
  defaultNewThreadFullAccess?: boolean;
  taskCompletionAlerts?: boolean;
  terminalScrollbackLines?: number;
}

export interface ImportableClaudeSession {
  sessionId: string;
  summary?: string | null;
  firstPrompt?: string | null;
  messageCount: number;
  createdAt?: string | null;
  modifiedAt?: string | null;
  gitBranch?: string | null;
}

export interface ImportableClaudeProject {
  path: string;
  name: string;
  pathExists: boolean;
  workspaceId?: string | null;
  workspaceName?: string | null;
  sessions: ImportableClaudeSession[];
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

export interface ContextFilePreview {
  path: string;
  size: number;
}

export interface ContextPreview {
  files: ContextFilePreview[];
  totalSize: number;
  contextText: string;
}

export interface RunClaudeRequest {
  workspacePath: string;
  threadId: string;
  message: string;
  enabledSkills: string[];
  fullAccess: boolean;
  contextPack: ContextPack;
}

export interface RunClaudeResponse {
  runId: string;
}

export interface TerminalStartResponse {
  sessionId: string;
  sessionMode: TerminalSessionMode;
  resumeSessionId?: string | null;
  agentSessionId?: string | null;
  turnCompletionMode?: TerminalTurnCompletionMode;
  currentCwd?: string | null;
  thread: ThreadMetadata;
}

export interface PreparedNativeFork {
  sourceClaudeSessionId: string;
  knownChildSessionIds: string[];
  requestedAt: string;
}

export interface FinalizedNativeFork {
  currentThread: ThreadMetadata;
  preservedThread: ThreadMetadata;
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

export interface ClaudeTurnCompletionSummary {
  claudeSessionId: string;
  completionIndex: number;
  completedAtMs: number;
  status: Extract<RunStatus, 'Succeeded' | 'Failed'>;
  hasMeaningfulOutput: boolean;
}

export interface RunStreamEvent {
  runId: string;
  threadId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface RunExitEvent {
  runId: string;
  threadId: string;
  exitCode?: number;
  durationMs: number;
}

export interface GitDiffSummary {
  stat: string;
  diffExcerpt: string;
}
