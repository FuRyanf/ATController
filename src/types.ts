export type RunStatus = 'Idle' | 'Running' | 'Succeeded' | 'Failed' | 'Canceled';
export type ContextPack = 'Minimal' | 'Git Diff' | 'Debug';
export type TerminalSessionMode = 'resumed' | 'new' | 'forked';
export type TerminalTurnCompletionMode = 'idle' | 'jsonl';
export type WorkspaceKind = 'local' | 'ssh';
export type AppearanceMode = 'dark' | 'light' | 'system';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  kind?: WorkspaceKind;
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
  appearanceMode?: AppearanceMode | null;
  defaultNewThreadFullAccess?: boolean;
  taskCompletionAlerts?: boolean;
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
  turnCompletionMode?: TerminalTurnCompletionMode;
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
  currentCwd?: string | null;
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
