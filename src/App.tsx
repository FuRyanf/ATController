import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';

import { setTheme as setAppTheme } from '@tauri-apps/api/app';
import { confirm, open } from '@tauri-apps/plugin-dialog';

import './styles.css';
import { AddWorkspaceModal } from './components/AddWorkspaceModal';
import { BulkImportClaudeSessionsModal } from './components/BulkImportClaudeSessionsModal';
import { ImportSessionModal } from './components/ImportSessionModal';
import { BottomBar } from './components/BottomBar';
import { HeaderBar } from './components/HeaderBar';
import { LeftRail } from './components/LeftRail';
import { SettingsModal } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ThreadSkillsPopover } from './components/ThreadSkillsPopover';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { WorkspaceShellDrawer } from './components/WorkspaceShellDrawer';
import * as apiModule from './lib/api';
import { resolveAppendedTerminalLogChunk } from './lib/terminalLogChunkUpdate';
import {
  presentTerminalEventData,
  presentTerminalText,
  presentTerminalWindow,
  shouldPreserveRawTerminalPresentation
} from './lib/terminalOutputPresentation';
import {
  applyAppearanceMode,
  normalizeAppearanceMode,
  persistAppearanceMode,
  readStoredAppearanceMode,
  resolveAppearanceTheme
} from './lib/appearance';
import {
  sendTaskCompletionAlert,
  sendTaskCompletionAlertsEnabledConfirmation,
  sendTaskCompletionAlertsTestNotification
} from './lib/taskCompletionAlerts';
import {
  createRunLifecycleState,
  isStreamingStuck,
  markRunExited,
  markRunReady,
  markRunStreaming,
  noteRunOutput,
  type TerminalRunLifecycleState
} from './lib/terminalRunLifecycle';
import {
  appendTerminalStreamChunk,
  bindLiveTerminalSessionStream,
  bindTerminalSessionStream,
  createTerminalSessionStreamState,
  hydrateTerminalSessionStream,
  presentTerminalSnapshot,
  terminalSessionStreamKnownRawEndPosition,
  type TerminalSessionStreamState
} from './lib/terminalSessionStream';
import { looksLikeStatefulTerminalUi, stripAnsi } from './lib/terminalUiHeuristics';
import {
  loadSkillUsageMap,
  persistSkillUsageMap,
  recordSkillUsage,
  toggleSkillPinned,
  type SkillUsageMap
} from './lib/skillUsage';
import { isRemoteWorkspaceKind } from './lib/workspaceKind';
import { useRunStore } from './stores/runStore';
import { useThreadStore } from './stores/threadStore';
import type {
  AppearanceMode,
  AppUpdateInfo,
  ClaudeTurnCompletionSummary,
  CreateThreadOptions,
  GitBranchEntry,
  GitInfo,
  GitWorkspaceStatus,
  ImportableClaudeProject,
  ImportableClaudeSession,
  PreparedNativeFork,
  RunStatus,
  Settings,
  SkillInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOutputSnapshot,
  TerminalReadyEvent,
  TerminalSshAuthStatusEvent,
  TerminalSshAuthStatusReason,
  TerminalTurnCompletedEvent,
  TerminalTurnCompletionMode,
  TerminalSessionMode,
  ThreadMetadata,
  Workspace
} from './types';

const { api, onTerminalData, onTerminalExit, onTerminalReady, onThreadUpdated } = apiModule;
const onTerminalSshAuthStatus =
  apiModule.onTerminalSshAuthStatus ??
  (async (_handler: (event: TerminalSshAuthStatusEvent) => void) => () => undefined);
const onTerminalTurnCompleted =
  apiModule.onTerminalTurnCompleted ??
  (async (_handler: (event: TerminalTurnCompletedEvent) => void) => () => undefined);

const SELECTED_WORKSPACE_KEY = 'atcontroller:selected-workspace';
const SIDEBAR_WIDTH_KEY = 'atcontroller:sidebar-width';
const SHELL_DRAWER_HEIGHT_KEY = 'atcontroller:shell-drawer-height';
const THREAD_VISIBLE_OUTPUT_GUARD_KEY = 'atcontroller:visible-output-guard';
const THREAD_ATTENTION_STATE_V2_KEY = 'atcontroller:thread-attention-v2';
const THREAD_JSONL_COMPLETION_ATTENTION_V1_KEY = 'atcontroller:jsonl-completion-attention-v1';
const TASK_COMPLETION_ALERTS_BOOTSTRAP_KEY = 'atcontroller:task-completion-alerts-bootstrap-v1';
const SIDEBAR_WIDTH_DEFAULT = 320;
const SIDEBAR_WIDTH_MIN = 260;
const SIDEBAR_WIDTH_MAX = 460;
const SHELL_DRAWER_HEIGHT_DEFAULT = 280;
const SHELL_DRAWER_HEIGHT_MIN = 220;
// Must be >= backend TERMINAL_STREAM_TAIL_MAX_CHARS + TRIM_HYSTERESIS (320K)
// to avoid position gaps that trigger full terminal resets during trimming.
const TERMINAL_LOG_BUFFER_CHARS = 320_000;
const SNAPSHOT_BUFFER_MAX_CHARS = TERMINAL_LOG_BUFFER_CHARS;
const TERMINAL_LOG_FLUSH_INTERVAL_MS = 16;
const TERMINAL_LOG_FLUSH_SAFETY_MS = 48;
const TERMINAL_DATA_LISTENER_READY_TIMEOUT_MS = 800;
const TERMINAL_RESIZE_DEBOUNCE_MS = 80;
const STATEFUL_TERMINAL_RESYNC_DEBOUNCE_MS = 160;
const STATEFUL_TERMINAL_REFRESH_RETRY_DELAYS_MS = [220, 520];
const SESSION_SNAPSHOT_REFRESH_DELAYS_MS = [320, 1100];
const SESSION_SNAPSHOT_LATE_REFRESH_DELAYS_MS = [2200, 4200];
const CLAUDE_IN_PLACE_RESTART_DELAY_MS = 120;
const RDEV_SHELL_PROMPT_POLL_INTERVAL_MS = 120;
const RDEV_SHELL_PROMPT_MAX_POLLS = 12;
const AUTO_RECOVER_SESSION_TIMEOUT_MS = 900;
const AUTO_RECOVER_RETRY_COOLDOWN_MS = 1200;
const THREAD_WORKING_IDLE_TIMEOUT_MS = 1200;
const THREAD_WORKING_STUCK_TIMEOUT_MS = 15_000;
const THREAD_FORK_RESOLUTION_POLL_INTERVAL_MS = 400;
const THREAD_FORK_RESOLUTION_TIMEOUT_MS = 12_000;
const THREAD_FORK_RESOLUTION_HARD_TIMEOUT_MS = 5 * 60 * 1000;
const BRANCH_SWITCH_RESUME_FAILURE_SUPPRESS_MS = 15_000;
const MAX_ATTACHMENT_DRAFTS = 24;
const MAX_ATTACHMENTS_PER_MESSAGE = 12;
const MAX_HIDDEN_INJECTED_PROMPTS_PER_THREAD = 80;
const MAX_VISIBLE_OUTPUT_TAIL_CHARS = 512;
const IGNORED_SSH_AUTH_STATUS_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_IGNORED_SSH_AUTH_STATUS_SESSIONS = 512;
const IGNORED_SSH_AUTH_STATUS_SESSION_PRUNE_INTERVAL_MS = 10_000;
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);
const REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON =
  'Send a message first to establish the session, then toggle Full access. To start with Full access, use New thread options and choose Full access thread, or enable full access by default in Settings.';

function normalizeSettings(settings?: Settings | null): Settings {
  return {
    claudeCliPath: settings?.claudeCliPath ?? null,
    appearanceMode: normalizeAppearanceMode(settings?.appearanceMode),
    defaultNewThreadFullAccess: settings?.defaultNewThreadFullAccess === true,
    taskCompletionAlerts: settings?.taskCompletionAlerts === true
  };
}

interface PendingSessionStart {
  requestId: number;
  promise: Promise<string>;
}

type ThreadAttentionActiveTurnStatus = 'idle' | 'running' | 'completed';
type ThreadAttentionCompletionStatus = Extract<RunStatus, 'Succeeded' | 'Failed'>;

interface ThreadAttentionState {
  activeTurnId: number | null;
  activeTurnStatus: ThreadAttentionActiveTurnStatus;
  activeTurnStartedAtMs: number | null;
  activeTurnHasMeaningfulOutput: boolean;
  activeTurnLastOutputAtMs: number | null;
  activeTurnSeenOutputAtMs: number | null;
  lastCompletedTurnIdWithOutput: number;
  lastCompletedTurnStatus: ThreadAttentionCompletionStatus | null;
  lastCompletedTurnAtMs: number | null;
  lastCompletedTurnLastOutputAtMs: number | null;
  lastNotifiedTurnId: number;
  lastNotifiedTurnStatus: ThreadAttentionCompletionStatus | null;
}

interface ThreadJsonlCompletionAttentionState {
  claudeSessionId: string;
  latestCompletionIndex: number;
  lastSeenCompletionIndex: number;
  lastNotifiedCompletionIndex: number;
  latestStatus: ThreadAttentionCompletionStatus | null;
  latestCompletedAtMs: number | null;
}

interface ThreadVisibleOutputGuard {
  seenAtMs: number;
  baselineUserInputAtMs: number;
  tail: string;
}

interface SshStartupBlockModalState {
  sessionId: string;
  workspaceId: string;
  threadId?: string | null;
  reason: TerminalSshAuthStatusReason;
}

interface ResumeFailureModalState {
  threadId: string;
  workspaceId: string;
  log: string;
  showLog: boolean;
}

interface ForkResolutionFailureModalState {
  threadId: string;
  workspaceId: string;
}

function removeThreadFlag(map: Record<string, boolean>, threadId: string) {
  if (!map[threadId]) {
    return map;
  }
  const next = { ...map };
  delete next[threadId];
  return next;
}

function removeRecordEntry<T>(map: Record<string, T>, key: string) {
  if (!(key in map)) {
    return map;
  }
  const next = { ...map };
  delete next[key];
  return next;
}

function addRecordFlag(
  map: Record<string, true>,
  key: string | null | undefined
): Record<string, true> {
  if (!key || map[key]) {
    return map;
  }
  return {
    ...map,
    [key]: true
  } as Record<string, true>;
}

function requiresExplicitSshReadySignal(workspaceKind: Workspace['kind'] | undefined | null): boolean {
  return workspaceKind === 'ssh';
}

function sshStartupBlockHeading(reason: TerminalSshAuthStatusReason): string {
  switch (reason) {
    case 'host-verification-required':
      return 'Finish SSH setup in Terminal first';
    case 'password-auth-unsupported':
      return 'ATController supports keys-only SSH';
    case 'interactive-auth-unsupported':
      return 'SSH must be unlocked outside ATController';
  }
}

function sshStartupBlockBody(reason: TerminalSshAuthStatusReason): string {
  switch (reason) {
    case 'host-verification-required':
      return 'Connect once in Terminal to accept the host key, then retry here.';
    case 'password-auth-unsupported':
      return 'This host requested a password. Configure SSH keys with macOS Keychain or ssh-agent, then verify `ssh user@host` works in Terminal before retrying.';
    case 'interactive-auth-unsupported':
      return 'This SSH target requires interactive auth such as a key passphrase or MFA prompt. Unlock it in macOS Keychain or ssh-agent and verify it in Terminal before retrying.';
  }
}

function sshStartupBlockOverlayMessage(reason: TerminalSshAuthStatusReason): string {
  switch (reason) {
    case 'host-verification-required':
      return 'SSH setup blocked. Accept the host key in Terminal, then retry.';
    case 'password-auth-unsupported':
      return 'SSH setup blocked. ATController requires key-based auth via macOS Keychain or ssh-agent.';
    case 'interactive-auth-unsupported':
      return 'SSH setup blocked. Unlock your key or MFA outside ATController, then retry.';
  }
}

function pruneIgnoredSshAuthStatusSessionsInPlace(
  sessions: Record<string, number>,
  nowMs: number
) {
  let retainedCount = 0;
  for (const [sessionId, ignoredAtMs] of Object.entries(sessions)) {
    if (
      !Number.isFinite(ignoredAtMs) ||
      ignoredAtMs <= 0 ||
      nowMs - ignoredAtMs > IGNORED_SSH_AUTH_STATUS_SESSION_TTL_MS
    ) {
      delete sessions[sessionId];
      continue;
    }
    retainedCount += 1;
  }

  if (retainedCount <= MAX_IGNORED_SSH_AUTH_STATUS_SESSIONS) {
    return;
  }

  const entries = Object.entries(sessions).sort((a, b) => b[1] - a[1]);
  for (let index = MAX_IGNORED_SSH_AUTH_STATUS_SESSIONS; index < entries.length; index += 1) {
    delete sessions[entries[index][0]];
  }
}

function parseThreadVisibleOutputGuardMap(raw: string | null): Record<string, ThreadVisibleOutputGuard> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, ThreadVisibleOutputGuard> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId || !value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const seenAtMs =
        typeof (value as { seenAtMs?: unknown }).seenAtMs === 'number'
          ? (value as { seenAtMs: number }).seenAtMs
          : Number((value as { seenAtMs?: unknown }).seenAtMs);
      if (!Number.isFinite(seenAtMs) || seenAtMs <= 0) {
        continue;
      }
      const baselineUserInputAtMs =
        typeof (value as { baselineUserInputAtMs?: unknown }).baselineUserInputAtMs === 'number'
          ? (value as { baselineUserInputAtMs: number }).baselineUserInputAtMs
          : Number((value as { baselineUserInputAtMs?: unknown }).baselineUserInputAtMs ?? 0);
      const rawTail = typeof (value as { tail?: unknown }).tail === 'string' ? (value as { tail: string }).tail : '';
      const tail = rawTail.trim();
      if (!tail) {
        continue;
      }
      normalized[threadId] = {
        seenAtMs: Math.trunc(seenAtMs),
        baselineUserInputAtMs:
          Number.isFinite(baselineUserInputAtMs) && baselineUserInputAtMs > 0
            ? Math.trunc(baselineUserInputAtMs)
            : 0,
        tail:
          tail.length <= MAX_VISIBLE_OUTPUT_TAIL_CHARS
            ? tail
            : tail.slice(tail.length - MAX_VISIBLE_OUTPUT_TAIL_CHARS)
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadThreadVisibleOutputGuardMap(storageKey: string): Record<string, ThreadVisibleOutputGuard> {
  if (typeof window === 'undefined') {
    return {};
  }
  return parseThreadVisibleOutputGuardMap(window.localStorage.getItem(storageKey));
}

function persistThreadVisibleOutputGuardMap(storageKey: string, map: Record<string, ThreadVisibleOutputGuard>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entries = Object.entries(map)
      .map(([threadId, value]) => {
        const tail = typeof value.tail === 'string' ? value.tail.trim() : '';
        if (!threadId || !tail || !Number.isFinite(value.seenAtMs) || value.seenAtMs <= 0) {
          return null;
        }
        return [
          threadId,
          {
            seenAtMs: Math.trunc(value.seenAtMs),
            baselineUserInputAtMs:
              Number.isFinite(value.baselineUserInputAtMs) && value.baselineUserInputAtMs > 0
                ? Math.trunc(value.baselineUserInputAtMs)
                : 0,
            tail:
              tail.length <= MAX_VISIBLE_OUTPUT_TAIL_CHARS
                ? tail
                : tail.slice(tail.length - MAX_VISIBLE_OUTPUT_TAIL_CHARS)
          }
        ] as const;
      })
      .filter((entry): entry is readonly [string, ThreadVisibleOutputGuard] => entry !== null);
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best effort
  }
}

function createThreadAttentionState(): ThreadAttentionState {
  return {
    activeTurnId: null,
    activeTurnStatus: 'idle',
    activeTurnStartedAtMs: null,
    activeTurnHasMeaningfulOutput: false,
    activeTurnLastOutputAtMs: null,
    activeTurnSeenOutputAtMs: null,
    lastCompletedTurnIdWithOutput: 0,
    lastCompletedTurnStatus: null,
    lastCompletedTurnAtMs: null,
    lastCompletedTurnLastOutputAtMs: null,
    lastNotifiedTurnId: 0,
    lastNotifiedTurnStatus: null
  };
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

function normalizeNonNegativeInteger(value: unknown): number {
  const normalized = normalizePositiveInteger(value);
  return normalized ?? 0;
}

function normalizeThreadAttentionTurnStatus(value: unknown): ThreadAttentionActiveTurnStatus {
  return value === 'running' || value === 'completed' ? value : 'idle';
}

function normalizeThreadAttentionCompletionStatus(value: unknown): ThreadAttentionCompletionStatus | null {
  return value === 'Succeeded' || value === 'Failed' ? value : null;
}

function normalizeThreadAttentionState(value: unknown): ThreadAttentionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const activeTurnId = normalizePositiveInteger(record.activeTurnId);
  const activeTurnStatus = normalizeThreadAttentionTurnStatus(record.activeTurnStatus);
  const activeTurnStartedAtMs = normalizePositiveInteger(record.activeTurnStartedAtMs);
  const activeTurnLastOutputAtMs = normalizePositiveInteger(record.activeTurnLastOutputAtMs);
  const activeTurnSeenOutputAtMs = normalizePositiveInteger(record.activeTurnSeenOutputAtMs);
  const lastCompletedTurnIdWithOutput = normalizeNonNegativeInteger(record.lastCompletedTurnIdWithOutput);
  const lastCompletedTurnStatus = normalizeThreadAttentionCompletionStatus(record.lastCompletedTurnStatus);
  const lastCompletedTurnAtMs = normalizePositiveInteger(record.lastCompletedTurnAtMs);
  const lastCompletedTurnLastOutputAtMs = normalizePositiveInteger(record.lastCompletedTurnLastOutputAtMs);
  const legacyLastViewedTurnId = normalizeNonNegativeInteger(record.lastViewedTurnId);
  const legacyLastViewedAtMs = normalizePositiveInteger(record.lastViewedAtMs);
  const lastNotifiedTurnId = normalizeNonNegativeInteger(record.lastNotifiedTurnId);
  const lastNotifiedTurnStatus = normalizeThreadAttentionCompletionStatus(record.lastNotifiedTurnStatus);
  const normalizedSeenOutputAtMs =
    activeTurnId &&
    legacyLastViewedTurnId === activeTurnId &&
    legacyLastViewedAtMs !== null
      ? Math.max(activeTurnSeenOutputAtMs ?? 0, legacyLastViewedAtMs)
      : activeTurnSeenOutputAtMs;

  return {
    activeTurnId,
    activeTurnStatus: activeTurnId ? activeTurnStatus : 'idle',
    activeTurnStartedAtMs: activeTurnId ? activeTurnStartedAtMs : null,
    activeTurnHasMeaningfulOutput: record.activeTurnHasMeaningfulOutput === true,
    activeTurnLastOutputAtMs,
    activeTurnSeenOutputAtMs: activeTurnId ? normalizedSeenOutputAtMs : null,
    lastCompletedTurnIdWithOutput,
    lastCompletedTurnStatus,
    lastCompletedTurnAtMs,
    lastCompletedTurnLastOutputAtMs,
    lastNotifiedTurnId,
    lastNotifiedTurnStatus
  };
}

function parseThreadAttentionStateMap(raw: string | null): Record<string, ThreadAttentionState> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, ThreadAttentionState> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId) {
        continue;
      }
      const state = normalizeThreadAttentionState(value);
      if (!state) {
        continue;
      }
      normalized[threadId] = state;
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadThreadAttentionStateMap(storageKey: string): Record<string, ThreadAttentionState> {
  if (typeof window === 'undefined') {
    return {};
  }
  return parseThreadAttentionStateMap(window.localStorage.getItem(storageKey));
}

function isDefaultThreadAttentionState(state: ThreadAttentionState): boolean {
  return (
    state.activeTurnId === null &&
    state.activeTurnStatus === 'idle' &&
    state.activeTurnStartedAtMs === null &&
    !state.activeTurnHasMeaningfulOutput &&
    state.activeTurnLastOutputAtMs === null &&
    state.activeTurnSeenOutputAtMs === null &&
    state.lastCompletedTurnIdWithOutput === 0 &&
    state.lastCompletedTurnStatus === null &&
    state.lastCompletedTurnAtMs === null &&
    state.lastCompletedTurnLastOutputAtMs === null &&
    state.lastNotifiedTurnId === 0 &&
    state.lastNotifiedTurnStatus === null
  );
}

function persistThreadAttentionStateMap(storageKey: string, map: Record<string, ThreadAttentionState>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entries = Object.entries(map).filter(([, value]) => !isDefaultThreadAttentionState(value));
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best effort
  }
}

function normalizeThreadJsonlCompletionAttentionState(
  value: unknown
): ThreadJsonlCompletionAttentionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const claudeSessionId =
    typeof record.claudeSessionId === 'string' ? record.claudeSessionId.trim() : '';
  const latestCompletionIndex = normalizeNonNegativeInteger(record.latestCompletionIndex);
  const lastSeenCompletionIndex = normalizeNonNegativeInteger(record.lastSeenCompletionIndex);
  const lastNotifiedCompletionIndex = normalizeNonNegativeInteger(record.lastNotifiedCompletionIndex);
  const latestStatus = normalizeThreadAttentionCompletionStatus(record.latestStatus);
  const latestCompletedAtMs = normalizePositiveInteger(record.latestCompletedAtMs);

  if (!claudeSessionId || latestCompletionIndex === 0 || !latestStatus || latestCompletedAtMs === null) {
    return null;
  }

  return {
    claudeSessionId,
    latestCompletionIndex,
    lastSeenCompletionIndex: Math.min(lastSeenCompletionIndex, latestCompletionIndex),
    lastNotifiedCompletionIndex: Math.min(lastNotifiedCompletionIndex, latestCompletionIndex),
    latestStatus,
    latestCompletedAtMs
  };
}

function parseThreadJsonlCompletionAttentionStateMap(
  raw: string | null
): Record<string, ThreadJsonlCompletionAttentionState> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, ThreadJsonlCompletionAttentionState> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId) {
        continue;
      }
      const state = normalizeThreadJsonlCompletionAttentionState(value);
      if (!state) {
        continue;
      }
      normalized[threadId] = state;
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadThreadJsonlCompletionAttentionStateMap(
  storageKey: string
): Record<string, ThreadJsonlCompletionAttentionState> {
  if (typeof window === 'undefined') {
    return {};
  }
  return parseThreadJsonlCompletionAttentionStateMap(window.localStorage.getItem(storageKey));
}

function persistThreadJsonlCompletionAttentionStateMap(
  storageKey: string,
  map: Record<string, ThreadJsonlCompletionAttentionState>
) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entries = Object.entries(map).filter(([, value]) => {
      return (
        value.claudeSessionId.trim().length > 0 &&
        value.latestCompletionIndex > 0 &&
        value.latestStatus !== null &&
        value.latestCompletedAtMs !== null
      );
    });
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best effort
  }
}

function areThreadJsonlCompletionAttentionStatesEqual(
  left: ThreadJsonlCompletionAttentionState | null | undefined,
  right: ThreadJsonlCompletionAttentionState | null | undefined
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.claudeSessionId === right.claudeSessionId &&
    left.latestCompletionIndex === right.latestCompletionIndex &&
    left.lastSeenCompletionIndex === right.lastSeenCompletionIndex &&
    left.lastNotifiedCompletionIndex === right.lastNotifiedCompletionIndex &&
    left.latestStatus === right.latestStatus &&
    left.latestCompletedAtMs === right.latestCompletedAtMs
  );
}

function isUnreadJsonlCompletionAttention(
  state: ThreadJsonlCompletionAttentionState | null | undefined
): boolean {
  if (!state) {
    return false;
  }
  return state.latestCompletionIndex > state.lastSeenCompletionIndex;
}

function areThreadAttentionStatesEqual(left: ThreadAttentionState, right: ThreadAttentionState): boolean {
  return (
    left.activeTurnId === right.activeTurnId &&
    left.activeTurnStatus === right.activeTurnStatus &&
    left.activeTurnStartedAtMs === right.activeTurnStartedAtMs &&
    left.activeTurnHasMeaningfulOutput === right.activeTurnHasMeaningfulOutput &&
    left.activeTurnLastOutputAtMs === right.activeTurnLastOutputAtMs &&
    left.activeTurnSeenOutputAtMs === right.activeTurnSeenOutputAtMs &&
    left.lastCompletedTurnIdWithOutput === right.lastCompletedTurnIdWithOutput &&
    left.lastCompletedTurnStatus === right.lastCompletedTurnStatus &&
    left.lastCompletedTurnAtMs === right.lastCompletedTurnAtMs &&
    left.lastCompletedTurnLastOutputAtMs === right.lastCompletedTurnLastOutputAtMs &&
    left.lastNotifiedTurnId === right.lastNotifiedTurnId &&
    left.lastNotifiedTurnStatus === right.lastNotifiedTurnStatus
  );
}

function nextTurnIdForAttentionState(state: ThreadAttentionState): number {
  return Math.max(
    state.activeTurnId ?? 0,
    state.lastCompletedTurnIdWithOutput,
    state.lastNotifiedTurnId
  ) + 1;
}

function runningTurnReattachBoundaryMs(state?: ThreadAttentionState): number | null {
  if (!state || state.activeTurnId === null || state.activeTurnStatus !== 'running') {
    return null;
  }

  return state.activeTurnStartedAtMs ?? state.activeTurnLastOutputAtMs ?? state.lastCompletedTurnAtMs ?? null;
}

function hasSeenCompletedAttentionTurn(state?: ThreadAttentionState): boolean {
  if (!state) {
    return false;
  }
  if (state.activeTurnId === null || state.lastCompletedTurnIdWithOutput === 0) {
    return false;
  }
  if (state.activeTurnId !== state.lastCompletedTurnIdWithOutput) {
    return false;
  }
  if (state.lastCompletedTurnLastOutputAtMs === null) {
    return false;
  }
  return (state.activeTurnSeenOutputAtMs ?? 0) >= state.lastCompletedTurnLastOutputAtMs;
}

function hasCompletedAttentionTurn(state?: ThreadAttentionState): boolean {
  if (!state) {
    return false;
  }
  return state.activeTurnId !== null && state.activeTurnStatus === 'completed';
}

function shouldNotifyAttentionTurn(state?: ThreadAttentionState): boolean {
  if (!state || !state.lastCompletedTurnStatus || state.lastCompletedTurnIdWithOutput === 0) {
    return false;
  }
  if (state.lastCompletedTurnIdWithOutput > state.lastNotifiedTurnId) {
    return !hasSeenCompletedAttentionTurn(state);
  }
  return (
    state.lastCompletedTurnIdWithOutput === state.lastNotifiedTurnId &&
    state.lastCompletedTurnStatus === 'Failed' &&
    state.lastNotifiedTurnStatus !== 'Failed' &&
    !hasSeenCompletedAttentionTurn(state)
  );
}

function threadSelectionKey(workspaceId: string) {
  return `atcontroller:selected-thread:${workspaceId}`;
}

function todayId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildClaudeInPlaceRestartCommand(sessionId: string, fullAccess: boolean): string {
  const parts = [
    'exec',
    'env',
    'TERM=xterm-256color',
    'COLORTERM=truecolor',
    'CLICOLOR=1',
    'CLICOLOR_FORCE=1',
    'FORCE_COLOR=1',
    'NO_COLOR=',
    'claude',
    '--resume',
    `'${sessionId}'`
  ];
  if (fullAccess) {
    parts.push('--dangerously-skip-permissions');
  }
  return parts.join(' ');
}

function hasShellPromptInSnapshot(snapshot: string): boolean {
  if (!snapshot) {
    return false;
  }

  const lines = snapshot
    .replace(/\r/g, '\n')
    .split('\n')
    .slice(-12)
    .map((line) =>
      stripAnsi(line)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        .trimEnd()
    )
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    if (
      lower.includes('claude code') ||
      lower.includes('for shortcuts') ||
      lower.includes('bypass permissions') ||
      lower.includes('starting ssh connection') ||
      lower.includes('uploading gh auth token')
    ) {
      continue;
    }
    if (/[#$%>]$/.test(line)) {
      return true;
    }
  }

  return false;
}

function looksLikeClaudeUiReadyText(snapshot: string): boolean {
  if (!snapshot) {
    return false;
  }

  const normalized = stripAnsi(snapshot).toLowerCase();
  return (
    normalized.includes('for shortcuts') ||
    normalized.includes('bypass permissions') ||
    normalized.includes('what should claude do instead')
  );
}

function isDefaultThreadTitle(title: string): boolean {
  return title.trim().toLowerCase() === 'new thread';
}

function normalizeTerminalInputChunk(data: string): string {
  // Claude Code treats Esc+Enter as "insert newline without submitting".
  // We preserve that behavior in app-side draft parsing so Shift/Option+Enter
  // stays multiline instead of looking like a normal submit.
  return data.replace(/\x1b\r/g, '\n');
}

interface StripControlSequencesResult {
  text: string;
  carry: string;
}

function consumeCsiSequence(input: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
    index += 1;
  }
  return null;
}

function consumeStringControlSequence(input: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) {
      return index + 1;
    }
    if (code === 0x1b) {
      if (index + 1 >= input.length) {
        return null;
      }
      if (input.charCodeAt(index + 1) === 0x5c) {
        return index + 2;
      }
    }
    index += 1;
  }
  return null;
}

function consumeEscapeSequence(input: string, startIndex: number): number | null {
  const escIndex = startIndex;
  if (escIndex + 1 >= input.length) {
    return null;
  }

  const code = input.charCodeAt(escIndex + 1);
  if (code === 0x5b) {
    return consumeCsiSequence(input, escIndex + 2);
  }

  // OSC, DCS, SOS, PM, APC
  if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return consumeStringControlSequence(input, escIndex + 2);
  }

  // ESC Fe / ESC Fs / ESC Fp forms.
  if (code >= 0x20 && code <= 0x2f) {
    let index = escIndex + 2;
    while (index < input.length) {
      const current = input.charCodeAt(index);
      if (current >= 0x30 && current <= 0x7e) {
        return index + 1;
      }
      index += 1;
    }
    return null;
  }

  return escIndex + 2;
}

function stripTerminalControlSequences(chunk: string, previousCarry: string): StripControlSequencesResult {
  const source = `${previousCarry}${chunk}`;
  if (!source) {
    return { text: '', carry: '' };
  }

  let output = '';
  let index = 0;

  while (index < source.length) {
    const code = source.charCodeAt(index);

    if (code === 0x1b) {
      const next = consumeEscapeSequence(source, index);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    // C1 CSI
    if (code === 0x9b) {
      const next = consumeCsiSequence(source, index + 1);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    // C1 DCS / SOS / OSC / PM / APC
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      const next = consumeStringControlSequence(source, index + 1);
      if (next === null) {
        return { text: output, carry: source.slice(index) };
      }
      index = next;
      continue;
    }

    output += source[index];
    index += 1;
  }

  return { text: output, carry: '' };
}

function extractSubmittedInputLines(
  previousBuffer: string,
  previousControlCarry: string,
  chunk: string
): { nextBuffer: string; nextControlCarry: string; submittedLines: string[] } {
  const normalizedChunk = normalizeTerminalInputChunk(chunk);
  const { text: normalized, carry } = stripTerminalControlSequences(normalizedChunk, previousControlCarry);
  if (!normalized) {
    return { nextBuffer: previousBuffer, nextControlCarry: carry, submittedLines: [] };
  }

  let buffer = previousBuffer;
  const submittedLines: string[] = [];

  for (const char of normalized) {
    if (char === '\n') {
      buffer += '\n';
      continue;
    }

    if (char === '\r') {
      if (buffer.trim().length > 0) {
        submittedLines.push(buffer);
      }
      buffer = '';
      continue;
    }

    if (char === '\u007f' || char === '\b') {
      if (buffer.length > 0) {
        buffer = buffer.slice(0, -1);
      }
      continue;
    }

    if (char >= ' ' && char !== '\u007f') {
      buffer += char;
    }
  }

  return { nextBuffer: buffer, nextControlCarry: carry, submittedLines };
}

function detectNativeForkCommand(submittedLines: string[]): string | null {
  if (submittedLines.length !== 1) {
    return null;
  }
  const line = submittedLines[0]?.trim() ?? '';
  if (!/^\/(?:fork|branch)(?:\s+.+)?$/i.test(line)) {
    return null;
  }
  return line;
}

function isThreadAwaitingConsumedForkResolution(thread: ThreadMetadata | null | undefined): boolean {
  if (!thread?.pendingForkLaunchConsumed) {
    return false;
  }
  const sourceClaudeSessionId = thread.pendingForkSourceClaudeSessionId?.trim() ?? '';
  if (!isUuidLike(sourceClaudeSessionId)) {
    return false;
  }
  const currentClaudeSessionId = thread.claudeSessionId?.trim() ?? '';
  return !isUuidLike(currentClaudeSessionId) || currentClaudeSessionId === sourceClaudeSessionId;
}

function isThreadMissingClaimedForkSession(thread: ThreadMetadata | null | undefined): boolean {
  const forkedFromClaudeSessionId = thread?.forkedFromClaudeSessionId?.trim() ?? '';
  if (!isUuidLike(forkedFromClaudeSessionId)) {
    return false;
  }
  const currentClaudeSessionId = thread?.claudeSessionId?.trim() ?? '';
  if (isUuidLike(currentClaudeSessionId)) {
    return false;
  }
  const pendingSourceClaudeSessionId = thread?.pendingForkSourceClaudeSessionId?.trim() ?? '';
  return !isUuidLike(pendingSourceClaudeSessionId);
}

function isForkSessionAlreadyClaimedError(error: unknown): boolean {
  return String(error).toLowerCase().includes('already claimed by another thread');
}

function normalizeAttachmentPaths(raw: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of raw) {
    const path = value.trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
  }

  return normalized;
}

function mergeAttachmentPaths(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  const seen = new Set(existing);
  for (const path of incoming) {
    if (seen.has(path)) {
      continue;
    }
    merged.push(path);
    seen.add(path);
    if (merged.length >= MAX_ATTACHMENT_DRAFTS) {
      break;
    }
  }
  return merged;
}

function isImageAttachmentPath(path: string): boolean {
  const lastSegment = path.split(/[\\/]/).pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  const extension = lastSegment.slice(dotIndex + 1).toLowerCase();
  return IMAGE_ATTACHMENT_EXTENSIONS.has(extension);
}

function quotePathForPrompt(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

function buildAttachmentPrompt(paths: string[]): string {
  const limited = paths.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const omittedCount = Math.max(0, paths.length - limited.length);
  const hasImages = limited.some(isImageAttachmentPath);

  const parts = [
    'Attachments from ATController:',
    ...limited.map((path) => `- ${quotePathForPrompt(path)}`),
    '',
    hasImages ? 'Inspect image and screenshot files visually.' : 'Read the attached files directly.',
    'If any attachment cannot be opened, say exactly which one failed.'
  ];

  if (omittedCount > 0) {
    parts.push(
      `${omittedCount} additional attachment${omittedCount === 1 ? '' : 's'} were selected but omitted to keep the prompt compact.`
    );
  }

  return parts.join('\n');
}

function buildSkillPrompt(skills: SkillInfo[]): string {
  const limited = skills.slice(0, 8);
  const omittedCount = Math.max(0, skills.length - limited.length);
  const references = limited.map((skill) => `${skill.name} (${skill.relativePath})`);
  const parts = [
    'Project skills to use for this request when relevant:',
    ...references.map((reference) => `- ${reference}`),
    '',
    'Read each referenced SKILL.md before acting and follow its instructions when it applies.'
  ];

  if (omittedCount > 0) {
    parts.push(
      `${omittedCount} additional skill${omittedCount === 1 ? '' : 's'} were selected but omitted from this inline preamble to keep it compact.`
    );
  }

  return parts.join('\n');
}

function stripFirstOccurrence(source: string, fragment: string): string {
  if (!source || !fragment) {
    return source;
  }
  const index = source.indexOf(fragment);
  if (index < 0) {
    return source;
  }
  return `${source.slice(0, index)}${source.slice(index + fragment.length)}`;
}

function stripHiddenPromptEchoes(text: string, prompts: string[]): string {
  if (!text || prompts.length === 0) {
    return text;
  }

  let next = text;
  for (const prompt of prompts) {
    if (!prompt) {
      continue;
    }
    const variants = new Set([
      prompt,
      prompt.replace(/\n/g, '\r\n'),
      prompt.replace(/\n/g, '\r')
    ]);
    for (const variant of variants) {
      next = stripFirstOccurrence(next, variant);
    }
  }
  return next;
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  if (element.closest('.thread-rename-input') !== null) {
    return true;
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'button' || type === 'checkbox' || type === 'file' || type === 'radio' || type === 'reset' || type === 'submit') {
      return false;
    }
    return true;
  }

  return element.getAttribute('role') === 'textbox';
}

function shouldIgnoreGlobalTerminalShortcutTarget(target: EventTarget | null): boolean {
  if (target instanceof Element && isEditableElement(target)) {
    return true;
  }

  if (typeof document !== 'undefined' && isEditableElement(document.activeElement)) {
    return true;
  }

  return false;
}

function hasMeaningfulTerminalOutputChunk(chunk: string): boolean {
  if (!chunk) {
    return false;
  }
  const visibleText = stripAnsi(chunk).replace(/[\r\n\t\b\f\v]/g, '');
  return visibleText.trim().length > 0;
}

function normalizeMeaningfulOutputText(chunk: string): string {
  if (!chunk) {
    return '';
  }
  const visibleText = stripAnsi(chunk)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return visibleText;
}

function looksLikeShellPromptText(chunk: string): boolean {
  if (!chunk) {
    return false;
  }

  const lines = stripAnsi(chunk)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.length > 2) {
    return false;
  }

  const line = lines[lines.length - 1];
  if (!/[#$%>]$/.test(line)) {
    return false;
  }

  const withoutPrompt = line.slice(0, -1).trim();
  if (!withoutPrompt) {
    return true;
  }

  if (/[.?!]$/.test(withoutPrompt)) {
    return false;
  }

  const tokens = withoutPrompt.split(/\s+/);
  if (tokens.length > 4) {
    return false;
  }

  const hasShellLikeToken = tokens.some((token) => /[@/~:[\]()\\]/.test(token));
  if (!hasShellLikeToken && tokens.length !== 1) {
    return false;
  }

  return tokens.every((token) => {
    if (/^\[[^\]]+\]$/.test(token) || /^\([^)]+\)$/.test(token)) {
      return true;
    }
    return /^[A-Za-z0-9._/+:-]+$/.test(token);
  });
}

function extractMeaningfulOutputTail(text: string, maxChars = MAX_VISIBLE_OUTPUT_TAIL_CHARS): string {
  if (!text) {
    return '';
  }

  const lines = stripAnsi(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
    .filter((line) => line.length > 0);

  while (lines.length > 0 && looksLikeShellPromptText(lines[lines.length - 1] ?? '')) {
    lines.pop();
  }

  if (lines.length === 0) {
    return '';
  }

  const normalized = normalizeMeaningfulOutputText(lines.join('\n'));
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxChars ? normalized : normalized.slice(normalized.length - maxChars);
}

function matchesVisibleOutputTail(normalizedChunk: string, visibleTail: string): boolean {
  if (!normalizedChunk || !visibleTail) {
    return false;
  }
  return (
    visibleTail === normalizedChunk ||
    visibleTail.includes(normalizedChunk) ||
    visibleTail.endsWith(normalizedChunk) ||
    normalizedChunk.includes(visibleTail) ||
    normalizedChunk.endsWith(visibleTail)
  );
}

function statusFromExit(event: TerminalExitEvent): RunStatus {
  if (event.signal || event.code === 130) {
    return 'Canceled';
  }
  if (event.code === 0) {
    return 'Succeeded';
  }
  if (typeof event.code === 'number') {
    return 'Failed';
  }
  return 'Idle';
}

function looksLikeResumeFailureOutput(output: string): boolean {
  const normalized = stripAnsi(output).toLowerCase();
  const mentionsResume =
    normalized.includes('--resume') || normalized.includes('resume a conversation') || normalized.includes('session');
  if (!mentionsResume) {
    return false;
  }
  return (
    normalized.includes('unknown session') ||
    normalized.includes('invalid session') ||
    normalized.includes('session not found') ||
    normalized.includes('no session found') ||
    normalized.includes('failed to resume')
  );
}

function isTerminalSessionUnavailableError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes('terminal session not found') ||
    message.includes('session not found') ||
    message.includes('no such process') ||
    message.includes('broken pipe')
  );
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
}

function clampShellDrawerHeight(height: number, viewportHeight = window.innerHeight): number {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  const maxHeight = Math.min(
    Math.round(safeViewportHeight * 0.82),
    Math.max(0, safeViewportHeight - 160)
  );
  const effectiveMin = Math.min(SHELL_DRAWER_HEIGHT_MIN, maxHeight);
  return Math.max(effectiveMin, Math.min(maxHeight, Math.round(height)));
}

function reorderWorkspacesByIds(currentWorkspaces: Workspace[], workspaceIds: string[]): Workspace[] {
  if (currentWorkspaces.length <= 1 || workspaceIds.length === 0) {
    return currentWorkspaces;
  }

  const remaining = [...currentWorkspaces];
  const ordered: Workspace[] = [];
  for (const workspaceId of workspaceIds) {
    const index = remaining.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) {
      continue;
    }
    ordered.push(remaining[index]);
    remaining.splice(index, 1);
  }

  if (ordered.length === 0) {
    return currentWorkspaces;
  }
  return [...ordered, ...remaining];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return await Promise.race<T | null>([
    promise,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs);
    })
  ]);
}

export default function App() {
  const threadStore = useThreadStore();
  const runStore = useRunStore();

  const {
    threadsByWorkspace,
    selectedWorkspaceId,
    selectedThreadId,
    listThreads,
    createThread,
    setThreadFullAccess,
    setThreadSkills,
    renameThread,
    deleteThread,
    setSelectedWorkspace,
    setSelectedThread,
    setThreadRunState,
    applyThreadUpdate,
    markThreadUserInput,
    clearThreadUserInputTimestamps
  } = threadStore;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedRaw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (savedRaw !== null) {
      const saved = Number(savedRaw);
      if (Number.isFinite(saved)) {
        return clampSidebarWidth(saved);
      }
    }
    return SIDEBAR_WIDTH_DEFAULT;
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [threadRuntimeCwdByThread, setThreadRuntimeCwdByThread] = useState<Record<string, string>>({});
  const [focusedTerminalKind, setFocusedTerminalKind] = useState<'claude' | 'shell' | null>(null);
  const [terminalSize, setTerminalSize] = useState({ cols: 120, rows: 32 });
  const [selectedTerminalFollowPaused, setSelectedTerminalFollowPaused] = useState(false);
  const [selectedStatefulHydrationSessionId, setSelectedStatefulHydrationSessionId] = useState<string | null>(null);
  const [selectedStatefulHydrationFailedSessionId, setSelectedStatefulHydrationFailedSessionId] = useState<string | null>(null);
  const [shellTerminalSize, setShellTerminalSize] = useState({ cols: 120, rows: 16 });
  const [shellDrawerHeight, setShellDrawerHeight] = useState(() => {
    const savedRaw = window.localStorage.getItem(SHELL_DRAWER_HEIGHT_KEY);
    if (savedRaw !== null) {
      const saved = Number(savedRaw);
      if (Number.isFinite(saved)) {
        return clampShellDrawerHeight(saved);
      }
    }
    return SHELL_DRAWER_HEIGHT_DEFAULT;
  });
  const [isShellDrawerResizing, setIsShellDrawerResizing] = useState(false);
  const [selectedTerminalStreamRevision, setSelectedTerminalStreamRevision] = useState(0);
  const [draftAttachmentsByThread, setDraftAttachmentsByThread] = useState<Record<string, string[]>>({});
  const [skillsByWorkspaceId, setSkillsByWorkspaceId] = useState<Record<string, SkillInfo[]>>({});
  const [skillsLoadingByWorkspaceId, setSkillsLoadingByWorkspaceId] = useState<Record<string, boolean>>({});
  const [skillErrorsByWorkspaceId, setSkillErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [skillUsageMap, setSkillUsageMap] = useState<SkillUsageMap>(() => loadSkillUsageMap());
  const [skillsUpdating, setSkillsUpdating] = useState(false);
  const [shellDrawerOpen, setShellDrawerOpen] = useState(false);
  const [shellTerminalSessionId, setShellTerminalSessionId] = useState<string | null>(null);
  const [shellTerminalWorkspaceId, setShellTerminalWorkspaceId] = useState<string | null>(null);
  const [shellTerminalStream, setShellTerminalStream] = useState<TerminalSessionStreamState>(
    () => createTerminalSessionStreamState()
  );
  const [shellTerminalStarting, setShellTerminalStarting] = useState(false);
  const [shellTerminalFocusRequestId, setShellTerminalFocusRequestId] = useState(0);
  const [terminalSearchToggleRequestId, setTerminalSearchToggleRequestId] = useState(0);
  const [shellTerminalSearchToggleRequestId, setShellTerminalSearchToggleRequestId] = useState(0);

  const [settings, setSettings] = useState<Settings>(() =>
    normalizeSettings({
      claudeCliPath: null,
      appearanceMode: readStoredAppearanceMode(),
      defaultNewThreadFullAccess: false,
      taskCompletionAlerts: false
    })
  );
  const [detectedCliPath, setDetectedCliPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blockingError, setBlockingError] = useState<string | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceMode, setAddWorkspaceMode] = useState<'local' | 'rdev' | 'ssh'>('local');
  const [addWorkspacePath, setAddWorkspacePath] = useState('');
  const [addWorkspaceRdevCommand, setAddWorkspaceRdevCommand] = useState('');
  const [addWorkspaceSshCommand, setAddWorkspaceSshCommand] = useState('');
  const [addWorkspaceSshRemotePath, setAddWorkspaceSshRemotePath] = useState('');
  const [addWorkspaceDisplayName, setAddWorkspaceDisplayName] = useState('');
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  const [importSessionWorkspace, setImportSessionWorkspace] = useState<Workspace | null>(null);
  const [importSessionError, setImportSessionError] = useState<string | null>(null);
  const [importingSession, setImportingSession] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportLoading, setBulkImportLoading] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkImportError, setBulkImportError] = useState<string | null>(null);
  const [discoveredImportableClaudeProjects, setDiscoveredImportableClaudeProjects] = useState<
    ImportableClaudeProject[]
  >([]);
  const [selectedBulkImportSessionIds, setSelectedBulkImportSessionIds] = useState<string[]>([]);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [appUpdateInfo, setAppUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [fullAccessUpdating, setFullAccessUpdating] = useState(false);
  const [startingByThread, setStartingByThread] = useState<Record<string, boolean>>({});
  const [readyByThread, setReadyByThread] = useState<Record<string, boolean>>({});
  const [sshStartupBlockedByThread, setSshStartupBlockedByThread] = useState<
    Record<string, TerminalSshAuthStatusReason>
  >({});
  const [sshStartupBlockedShellByWorkspace, setSshStartupBlockedShellByWorkspace] = useState<
    Record<string, TerminalSshAuthStatusReason>
  >({});
  const [hasInteractedByThread, setHasInteractedByThread] = useState<Record<string, boolean>>({});
  const [creatingThreadByWorkspace, setCreatingThreadByWorkspace] = useState<Record<string, boolean>>({});
  const [resumeFailureBlockedByThread, setResumeFailureBlockedByThread] = useState<Record<string, true>>({});
  const [resumeFailureModal, setResumeFailureModal] = useState<ResumeFailureModalState | null>(null);
  const [forkResolutionFailureBlockedByThread, setForkResolutionFailureBlockedByThread] = useState<
    Record<string, true>
  >({});
  const [forkResolutionFailureModal, setForkResolutionFailureModal] = useState<ForkResolutionFailureModalState | null>(
    null
  );
  const [sshStartupBlockModal, setSshStartupBlockModal] = useState<SshStartupBlockModalState | null>(null);

  const selectedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const selectedThreadIdRef = useRef<string | undefined>(undefined);
  const focusedTerminalKindRef = useRef<'claude' | 'shell' | null>(null);
  const shellTerminalSessionIdRef = useRef<string | null>(null);
  const shellTerminalWorkspaceIdRef = useRef<string | null>(null);
  const shellSessionStartRequestIdRef = useRef(0);
  const pendingShellSessionStartRef = useRef<{ requestId: number; workspaceId: string } | null>(null);
  const activeRunsByThreadRef = useRef(runStore.activeRunsByThread);
  const workingByThreadRef = useRef(runStore.workingByThread);
  const readyByThreadRef = useRef<Record<string, boolean>>({});
  const sshStartupBlockedByThreadRef = useRef<Record<string, TerminalSshAuthStatusReason>>({});
  const sshStartupBlockedShellByWorkspaceRef = useRef<Record<string, TerminalSshAuthStatusReason>>({});
  const ignoredSshAuthStatusSessionIdsRef = useRef<Record<string, number>>({});
  const ignoredSshAuthStatusSessionLastPrunedAtMsRef = useRef(0);
  const pendingSshStartupAuthStatusBySessionIdRef = useRef<Record<string, TerminalSshAuthStatusEvent>>({});
  const threadWorkspaceKindByThreadIdRef = useRef<Record<string, Workspace['kind']>>({});
  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const shellDrawerResizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const startingSessionByThreadRef = useRef<Record<string, PendingSessionStart>>({});
  const sessionStartRequestIdByThreadRef = useRef<Record<string, number>>({});
  const threadsByWorkspaceRef = useRef<Record<string, ThreadMetadata[]>>({});
  const terminalStreamsByThreadRef = useRef<Record<string, TerminalSessionStreamState>>({});
  const threadIdBySessionIdRef = useRef<Record<string, string>>({});
  const lastTerminalLogByThreadRef = useRef<Record<string, string>>({});
  const workingStopTimerByThreadRef = useRef<Record<string, number>>({});
  const draftAttachmentsByThreadRef = useRef<Record<string, string[]>>({});
  const inputBufferByThreadRef = useRef<Record<string, string>>({});
  const inputControlCarryByThreadRef = useRef<Record<string, string>>({});
  const outputControlCarryByThreadRef = useRef<Record<string, string>>({});
  const threadTitleInitializedRef = useRef<Record<string, true>>({});
  const deletedThreadIdsRef = useRef<Record<string, true>>({});
  const creatingThreadByWorkspaceRef = useRef<Record<string, true>>({});
  const pendingInputByThreadRef = useRef<Record<string, string>>({});
  const pendingSkillClearByThreadRef = useRef<Record<string, true>>({});
  const hiddenInjectedPromptsByThreadRef = useRef<Record<string, string[]>>({});
  const forkResolutionByThreadRef = useRef<Record<string, Promise<void>>>({});
  const forkResolutionTimeoutNotifiedByThreadRef = useRef<Record<string, true>>({});
  const suppressAutoForkResolutionByThreadRef = useRef<Record<string, true>>({});
  const allowFreshStartAfterForkFailureByThreadRef = useRef<Record<string, true>>({});
  const selectedGitContextPathRef = useRef<string | null>(null);
  const threadRuntimeCwdByThreadRef = useRef<Record<string, string>>({});
  const gitInfoRequestIdRef = useRef(0);
  const escapeSignalRef = useRef<{ sessionId: string; at: number } | null>(null);
  const terminalDataListenerReadyRef = useRef(false);
  const terminalDataListenerReadyResolverRef = useRef<(() => void) | null>(null);
  const terminalDataListenerReadyPromiseRef = useRef<Promise<void> | null>(null);
  const visibleOutputGuardByThreadRef = useRef<Record<string, ThreadVisibleOutputGuard>>(
    loadThreadVisibleOutputGuardMap(THREAD_VISIBLE_OUTPUT_GUARD_KEY)
  );
  const threadAttentionByThreadRef = useRef<Record<string, ThreadAttentionState>>(
    loadThreadAttentionStateMap(THREAD_ATTENTION_STATE_V2_KEY)
  );
  const threadJsonlCompletionAttentionByThreadRef = useRef<
    Record<string, ThreadJsonlCompletionAttentionState>
  >(loadThreadJsonlCompletionAttentionStateMap(THREAD_JSONL_COMPLETION_ATTENTION_V1_KEY));
  const visibleOutputGuardDirtyRef = useRef(false);
  const threadAttentionDirtyRef = useRef(false);
  const threadJsonlCompletionAttentionDirtyRef = useRef(false);
  const jsonlCompletionReconcileRequestIdByThreadRef = useRef<Record<string, number>>({});
  const jsonlCompletionSeededSessionIdByThreadRef = useRef<Record<string, string>>({});
  const suppressResumeFailureModalUntilByWorkspaceRef = useRef<Record<string, number>>({});
  const taskCompletionAlertBootstrapAttemptedRef = useRef(false);
  const lastMeaningfulOutputByThreadRef = useRef<Record<string, string>>({});
  const lastSessionStartAtMsByThreadRef = useRef<Record<string, number>>({});
  const lastUserInputAtMsByThreadRef = useRef<Record<string, number>>({});
  const runLifecycleByThreadRef = useRef<Record<string, TerminalRunLifecycleState>>({});
  const sessionFailCountByThreadRef = useRef<Record<string, number>>({});
  const terminalDataEventHandlerRef = useRef<(event: TerminalDataEvent) => void>(() => undefined);
  const terminalReadyEventHandlerRef = useRef<(event: TerminalReadyEvent) => void>(() => undefined);
  const terminalSshAuthStatusEventHandlerRef = useRef<(event: TerminalSshAuthStatusEvent) => void>(() => undefined);
  const terminalTurnCompletedEventHandlerRef = useRef<(event: TerminalTurnCompletedEvent) => void>(() => undefined);
  const terminalExitEventHandlerRef = useRef<(event: TerminalExitEvent) => void>(() => undefined);
  const threadUpdatedEventHandlerRef = useRef<(thread: ThreadMetadata) => void>(() => undefined);
  const terminalOnDataHandlerRef = useRef<(data: string) => void>(() => undefined);
  const terminalOnResizeHandlerRef = useRef<(cols: number, rows: number) => void>(() => undefined);
  const pendingTerminalResizeRef = useRef<{ sessionId: string; cols: number; rows: number } | null>(null);
  const pendingTerminalResizeTimerRef = useRef<number | null>(null);
  const terminalHydrationRequestIdByThreadRef = useRef<Record<string, number>>({});
  const lastSentTerminalSizeBySessionRef = useRef<Record<string, { cols: number; rows: number }>>({});
  const selectedSessionIdRef = useRef<string | null>(null);
  const statefulTerminalResyncTimerRef = useRef<number | null>(null);
  const statefulRedrawRequestTokenRef = useRef(0);
  const autoRecoverInFlightRef = useRef(false);
  const lastAutoRecoverAttemptAtRef = useRef(0);
  const skillListRequestIdByWorkspaceRef = useRef<Record<string, number>>({});
  const [threadJsonlCompletionAttentionVersion, setThreadJsonlCompletionAttentionVersion] = useState(0);
  const sessionMetaBySessionIdRef = useRef<
    Record<
      string,
      {
        threadId: string;
        workspaceId: string;
        workspaceKind: Workspace['kind'];
        claudeSessionId?: string | null;
        currentCwd?: string | null;
        mode: TerminalSessionMode;
        turnCompletionMode: TerminalTurnCompletionMode;
        startedAtMs: number;
      }
    >
  >({});

  if (!terminalDataListenerReadyPromiseRef.current) {
    terminalDataListenerReadyPromiseRef.current = new Promise<void>((resolve) => {
      terminalDataListenerReadyResolverRef.current = resolve;
    });
  }

  const stableTerminalOnData = useCallback((data: string) => {
    terminalOnDataHandlerRef.current(data);
  }, []);

  const stableTerminalOnResize = useCallback((cols: number, rows: number) => {
    terminalOnResizeHandlerRef.current(cols, rows);
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces]
  );
  const workspaceById = useMemo(
    () => Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces]
  );

  const allThreads = useMemo(() => Object.values(threadsByWorkspace).flat(), [threadsByWorkspace]);
  const importedClaudeSessionIds = useMemo(
    () =>
      Array.from(
        new Set(
          allThreads
            .filter((thread) => !thread.isArchived)
            .map((thread) => thread.claudeSessionId?.trim() ?? '')
            .filter((sessionId) => sessionId.length > 0)
        )
      ),
    [allThreads]
  );
  const discoveredImportableClaudeSessionsById = useMemo(() => {
    const lookup = new Map<string, { project: ImportableClaudeProject; session: ImportableClaudeSession }>();
    for (const project of discoveredImportableClaudeProjects) {
      for (const session of project.sessions) {
        lookup.set(session.sessionId, { project, session });
      }
    }
    return lookup;
  }, [discoveredImportableClaudeProjects]);

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) {
      return undefined;
    }
    return allThreads.find((thread) => thread.id === selectedThreadId);
  }, [allThreads, selectedThreadId]);
  const selectedThreadRuntimeCwd = selectedThread ? threadRuntimeCwdByThread[selectedThread.id] ?? null : null;
  const selectedGitContextPath = useMemo(() => {
    if (!selectedWorkspace || selectedWorkspace.kind !== 'local') {
      return null;
    }
    const runtimeCwd = selectedThreadRuntimeCwd?.trim();
    return runtimeCwd && runtimeCwd.length > 0 ? runtimeCwd : selectedWorkspace.path;
  }, [selectedThreadRuntimeCwd, selectedWorkspace]);
  selectedGitContextPathRef.current = selectedGitContextPath;
  const selectedThreadResumeFailureBlocked =
    selectedThread ? Boolean(resumeFailureBlockedByThread[selectedThread.id]) : false;
  const selectedThreadForkResolutionFailureBlocked =
    selectedThread ? Boolean(forkResolutionFailureBlockedByThread[selectedThread.id]) : false;
  const selectedThreadAwaitingForkResolution =
    selectedThread ? isThreadAwaitingConsumedForkResolution(selectedThread) : false;

  useEffect(() => {
    let changed = false;
    for (const thread of allThreads) {
      if (!allowFreshStartAfterForkFailureByThreadRef.current[thread.id]) {
        continue;
      }
      if (
        isUuidLike(thread.claudeSessionId?.trim() ?? '') ||
        isUuidLike(thread.pendingForkSourceClaudeSessionId?.trim() ?? '')
      ) {
        delete allowFreshStartAfterForkFailureByThreadRef.current[thread.id];
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
  }, [allThreads]);

  useEffect(() => {
    if (!selectedThread) {
      return;
    }
    if (allowFreshStartAfterForkFailureByThreadRef.current[selectedThread.id]) {
      return;
    }
    if (!isThreadMissingClaimedForkSession(selectedThread)) {
      if (forkResolutionFailureBlockedByThread[selectedThread.id]) {
        setForkResolutionFailureBlockedByThread((current) => removeRecordEntry(current, selectedThread.id));
      }
      if (forkResolutionFailureModal?.threadId === selectedThread.id) {
        setForkResolutionFailureModal(null);
      }
      return;
    }

    setForkResolutionFailureBlockedByThread((current) =>
      current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
    );
    setForkResolutionFailureModal((current) =>
      current?.threadId === selectedThread.id
        ? current
        : {
            threadId: selectedThread.id,
            workspaceId: selectedThread.workspaceId
          }
    );
  }, [
    forkResolutionFailureBlockedByThread,
    forkResolutionFailureModal,
    selectedThread
  ]);

  const selectedSessionId = runStore.sessionForThread(selectedThreadId);
  const isSelectedThreadStarting = selectedThread ? Boolean(startingByThread[selectedThread.id]) : false;
  const isSelectedThreadReady = selectedThread ? Boolean(readyByThread[selectedThread.id]) : false;
  const selectedThreadSshStartupBlockReason =
    selectedThread && selectedWorkspace?.kind === 'ssh'
      ? sshStartupBlockedByThread[selectedThread.id] ?? null
      : null;
  const selectedShellSshStartupBlockReason =
    selectedWorkspace?.kind === 'ssh' ? sshStartupBlockedShellByWorkspace[selectedWorkspace.id] ?? null : null;
  const hasInteractedForSelectedThread = selectedThread ? Boolean(hasInteractedByThread[selectedThread.id]) : false;
  const fullAccessToggleBlockedReason =
    selectedThread &&
    selectedWorkspace &&
    isRemoteWorkspaceKind(selectedWorkspace.kind) &&
    (isSelectedThreadStarting || !hasInteractedForSelectedThread)
      ? REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON
      : null;

  const selectedTerminalStream = useMemo(() => {
    if (!selectedThreadId) {
      return createTerminalSessionStreamState();
    }
    return terminalStreamsByThreadRef.current[selectedThreadId] ?? createTerminalSessionStreamState();
  }, [selectedTerminalStreamRevision, selectedThreadId]);
  const selectedSessionMode = selectedSessionId ? sessionMetaBySessionIdRef.current[selectedSessionId]?.mode ?? null : null;
  const selectedTerminalLooksStateful =
    Boolean(selectedThread) &&
    Boolean(selectedSessionId) &&
    selectedTerminalStream.sessionId === selectedSessionId &&
    looksLikeStatefulTerminalUi(selectedTerminalStream.text);
  const selectedTerminalRenderStream = useMemo(() => {
    if (!selectedSessionId || selectedStatefulHydrationSessionId !== selectedSessionId) {
      return selectedTerminalStream;
    }
    return {
      sessionId: selectedSessionId,
      phase: 'hydrating' as const,
      text: '',
      rawEndPosition: selectedTerminalStream.rawEndPosition,
      startPosition: 0,
      endPosition: 0,
      chunks: [],
      resetToken: selectedTerminalStream.resetToken
    };
  }, [selectedSessionId, selectedStatefulHydrationSessionId, selectedTerminalStream]);
  const hasSelectedTerminalContent = selectedTerminalRenderStream.text.length > 0;
  const selectedTerminalPrefersLiveRedraw =
    selectedStatefulHydrationSessionId !== selectedSessionId &&
    selectedTerminalLooksStateful &&
    selectedSessionMode !== 'new' &&
    selectedTerminalStream.phase === 'ready';
  const selectedThreadWorking = selectedThread ? runStore.isThreadWorking(selectedThread.id) : false;

  useEffect(() => {
    setSelectedTerminalFollowPaused(false);
  }, [selectedSessionId, selectedThreadId]);

  useEffect(() => {
    if (!selectedSessionId && selectedStatefulHydrationSessionId !== null) {
      setSelectedStatefulHydrationSessionId(null);
      setSelectedStatefulHydrationFailedSessionId(null);
      return;
    }
    if (
      selectedStatefulHydrationSessionId !== null &&
      selectedSessionId !== null &&
      selectedStatefulHydrationSessionId !== selectedSessionId
    ) {
      setSelectedStatefulHydrationSessionId(null);
    }
    if (
      selectedStatefulHydrationFailedSessionId !== null &&
      selectedSessionId !== null &&
      selectedStatefulHydrationFailedSessionId !== selectedSessionId
    ) {
      setSelectedStatefulHydrationFailedSessionId(null);
    }
  }, [selectedSessionId, selectedStatefulHydrationFailedSessionId, selectedStatefulHydrationSessionId]);

  useEffect(() => {
    if (
      selectedStatefulHydrationFailedSessionId !== null &&
      selectedStatefulHydrationFailedSessionId === selectedSessionId &&
      selectedTerminalStream.text.length > 0
    ) {
      setSelectedStatefulHydrationFailedSessionId(null);
    }
  }, [selectedSessionId, selectedStatefulHydrationFailedSessionId, selectedTerminalStream.text]);

  useEffect(() => {
    const activeThreadIds = new Set(allThreads.map((thread) => thread.id));
    setThreadRuntimeCwdByThread((current) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [threadId, cwd] of Object.entries(current)) {
        if (!activeThreadIds.has(threadId)) {
          changed = true;
          continue;
        }
        next[threadId] = cwd;
      }
      if (changed) {
        threadRuntimeCwdByThreadRef.current = next;
      }
      return changed ? next : current;
    });
  }, [allThreads]);

  const selectedThreadDraftAttachments = useMemo(() => {
    if (!selectedThreadId) {
      return [];
    }
    return draftAttachmentsByThread[selectedThreadId] ?? [];
  }, [draftAttachmentsByThread, selectedThreadId]);

  const selectedWorkspaceSkills = useMemo(() => {
    if (!selectedWorkspace) {
      return [];
    }
    return skillsByWorkspaceId[selectedWorkspace.id] ?? [];
  }, [selectedWorkspace, skillsByWorkspaceId]);

  const selectedWorkspaceSkillsLoading = selectedWorkspace ? Boolean(skillsLoadingByWorkspaceId[selectedWorkspace.id]) : false;
  const selectedWorkspaceSkillError = selectedWorkspace ? skillErrorsByWorkspaceId[selectedWorkspace.id] ?? null : null;

  const selectedInjectableSkills = useMemo(() => {
    if (!selectedThread || !selectedWorkspace) {
      return [];
    }
    const availableById = new Map(selectedWorkspaceSkills.map((skill) => [skill.id, skill]));
    return selectedThread.enabledSkills
      .map((skillId) => availableById.get(skillId))
      .filter((skill): skill is SkillInfo => Boolean(skill));
  }, [selectedThread, selectedWorkspace, selectedWorkspaceSkills]);

  const handleClaudeTerminalFocusChange = useCallback((focused: boolean) => {
    setFocusedTerminalKind((current) => (focused ? 'claude' : current === 'claude' ? null : current));
  }, []);

  const handleShellTerminalFocusChange = useCallback((focused: boolean) => {
    setFocusedTerminalKind((current) => (focused ? 'shell' : current === 'shell' ? null : current));
  }, []);

  const handleShellTerminalData = useCallback((data: string) => {
    if (!shellTerminalSessionId || selectedShellSshStartupBlockReason) {
      return;
    }
    void api.terminalWrite(shellTerminalSessionId, data);
  }, [selectedShellSshStartupBlockReason, shellTerminalSessionId]);

  const handleShellTerminalResize = useCallback((cols: number, rows: number) => {
    setShellTerminalSize((current) =>
      current.cols === cols && current.rows === rows ? current : { cols, rows }
    );
    if (!shellTerminalSessionId) {
      return;
    }
    void api.terminalResize(shellTerminalSessionId, cols, rows);
  }, [shellTerminalSessionId]);

  const resolveTerminalDataListenerReady = useCallback(() => {
    if (terminalDataListenerReadyRef.current) {
      return;
    }
    terminalDataListenerReadyRef.current = true;
    terminalDataListenerReadyResolverRef.current?.();
    terminalDataListenerReadyResolverRef.current = null;
  }, []);

  const waitForTerminalDataListenerReady = useCallback(async () => {
    if (terminalDataListenerReadyRef.current) {
      return;
    }
    if (!terminalDataListenerReadyPromiseRef.current) {
      return;
    }
    await withTimeout(terminalDataListenerReadyPromiseRef.current, TERMINAL_DATA_LISTENER_READY_TIMEOUT_MS);
  }, []);

  const flushPendingTerminalResize = useCallback(() => {
    if (pendingTerminalResizeTimerRef.current !== null) {
      window.clearTimeout(pendingTerminalResizeTimerRef.current);
      pendingTerminalResizeTimerRef.current = null;
    }

    const pending = pendingTerminalResizeRef.current;
    pendingTerminalResizeRef.current = null;
    if (!pending) {
      return;
    }

    const lastSent = lastSentTerminalSizeBySessionRef.current[pending.sessionId];
    if (lastSent && lastSent.cols === pending.cols && lastSent.rows === pending.rows) {
      return;
    }

    lastSentTerminalSizeBySessionRef.current[pending.sessionId] = {
      cols: pending.cols,
      rows: pending.rows
    };
    void api.terminalResize(pending.sessionId, pending.cols, pending.rows);
  }, []);

  const scheduleTerminalResize = useCallback(
    (sessionId: string, cols: number, rows: number, immediate = false) => {
      pendingTerminalResizeRef.current = { sessionId, cols, rows };
      if (immediate) {
        flushPendingTerminalResize();
        return;
      }
      if (pendingTerminalResizeTimerRef.current !== null) {
        window.clearTimeout(pendingTerminalResizeTimerRef.current);
      }
      pendingTerminalResizeTimerRef.current = window.setTimeout(() => {
        flushPendingTerminalResize();
      }, TERMINAL_RESIZE_DEBOUNCE_MS);
    },
    [flushPendingTerminalResize]
  );

  useEffect(() => {
    return () => {
      if (pendingTerminalResizeTimerRef.current !== null) {
        window.clearTimeout(pendingTerminalResizeTimerRef.current);
        pendingTerminalResizeTimerRef.current = null;
      }
      pendingTerminalResizeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const pending = pendingTerminalResizeRef.current;
    if (!pending) {
      return;
    }
    if (selectedSessionId && pending.sessionId === selectedSessionId) {
      return;
    }
    if (pendingTerminalResizeTimerRef.current !== null) {
      window.clearTimeout(pendingTerminalResizeTimerRef.current);
      pendingTerminalResizeTimerRef.current = null;
    }
    pendingTerminalResizeRef.current = null;
  }, [selectedSessionId]);

  const cancelPendingStatefulTerminalResync = useCallback(() => {
    if (statefulTerminalResyncTimerRef.current !== null) {
      window.clearTimeout(statefulTerminalResyncTimerRef.current);
      statefulTerminalResyncTimerRef.current = null;
    }
    statefulRedrawRequestTokenRef.current += 1;
  }, []);

  const handleSelectedTerminalFollowPausedChange = useCallback((paused: boolean) => {
    setSelectedTerminalFollowPaused((current) => (current === paused ? current : paused));
  }, []);

  useEffect(() => {
    return () => {
      cancelPendingStatefulTerminalResync();
    };
  }, [cancelPendingStatefulTerminalResync]);

  useEffect(() => {
    if (!selectedTerminalFollowPaused) {
      return;
    }
    cancelPendingStatefulTerminalResync();
  }, [cancelPendingStatefulTerminalResync, selectedTerminalFollowPaused]);

  useEffect(() => {
    cancelPendingStatefulTerminalResync();
  }, [
    cancelPendingStatefulTerminalResync,
    isSelectedThreadStarting,
    selectedSessionId,
    selectedThread?.id,
    selectedTerminalLooksStateful
  ]);

  const flushVisibleOutputGuardState = useCallback(() => {
    if (!visibleOutputGuardDirtyRef.current) {
      return;
    }
    visibleOutputGuardDirtyRef.current = false;
    persistThreadVisibleOutputGuardMap(THREAD_VISIBLE_OUTPUT_GUARD_KEY, visibleOutputGuardByThreadRef.current);
  }, []);

  const rememberThreadVisibleOutput = useCallback((threadId: string, outputText: string, seenAtMs = Date.now()) => {
    const tail = extractMeaningfulOutputTail(outputText);
    if (!tail) {
      return;
    }
    visibleOutputGuardByThreadRef.current[threadId] = {
      seenAtMs,
      baselineUserInputAtMs: lastUserInputAtMsByThreadRef.current[threadId] ?? 0,
      tail
    };
    visibleOutputGuardDirtyRef.current = true;
  }, []);

  const flushThreadJsonlCompletionAttentionState = useCallback(() => {
    if (!threadJsonlCompletionAttentionDirtyRef.current) {
      return;
    }
    threadJsonlCompletionAttentionDirtyRef.current = false;
    persistThreadJsonlCompletionAttentionStateMap(
      THREAD_JSONL_COMPLETION_ATTENTION_V1_KEY,
      threadJsonlCompletionAttentionByThreadRef.current
    );
  }, []);

  const flushThreadAttentionState = useCallback(() => {
    if (!threadAttentionDirtyRef.current) {
      return;
    }
    threadAttentionDirtyRef.current = false;
    persistThreadAttentionStateMap(THREAD_ATTENTION_STATE_V2_KEY, threadAttentionByThreadRef.current);
  }, []);

  const commitThreadJsonlCompletionAttentionState = useCallback(
    (
      threadId: string,
      nextState: ThreadJsonlCompletionAttentionState | null,
      { persistNow = false }: { persistNow?: boolean } = {}
    ) => {
      const currentState = threadJsonlCompletionAttentionByThreadRef.current[threadId] ?? null;
      if (!areThreadJsonlCompletionAttentionStatesEqual(currentState, nextState)) {
        if (!nextState) {
          delete threadJsonlCompletionAttentionByThreadRef.current[threadId];
        } else {
          threadJsonlCompletionAttentionByThreadRef.current[threadId] = nextState;
        }
        threadJsonlCompletionAttentionDirtyRef.current = true;
        setThreadJsonlCompletionAttentionVersion((current) => current + 1);
      }
      if (persistNow) {
        flushThreadJsonlCompletionAttentionState();
      }
      return nextState;
    },
    [flushThreadJsonlCompletionAttentionState]
  );

  const commitThreadAttentionState = useCallback(
    (
      threadId: string,
      nextState: ThreadAttentionState,
      { persistNow = false }: { persistNow?: boolean } = {}
    ) => {
      const currentState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      if (!areThreadAttentionStatesEqual(currentState, nextState)) {
        if (isDefaultThreadAttentionState(nextState)) {
          delete threadAttentionByThreadRef.current[threadId];
        } else {
          threadAttentionByThreadRef.current[threadId] = nextState;
        }
        threadAttentionDirtyRef.current = true;
      }
      if (persistNow) {
        flushThreadAttentionState();
      }
      return nextState;
    },
    [flushThreadAttentionState]
  );

  const resetThreadJsonlCompletionAttentionForSession = useCallback(
    (threadId: string, claudeSessionId: string | null | undefined) => {
      const normalizedSessionId = claudeSessionId?.trim() ?? '';
      const currentState = threadJsonlCompletionAttentionByThreadRef.current[threadId] ?? null;
      if (!currentState) {
        return null;
      }
      if (!normalizedSessionId || currentState.claudeSessionId === normalizedSessionId) {
        return currentState;
      }
      return commitThreadJsonlCompletionAttentionState(threadId, null, { persistNow: true });
    },
    [commitThreadJsonlCompletionAttentionState]
  );

  const isThreadVisibleToUser = useCallback((threadId: string) => {
    if (!threadId || selectedThreadIdRef.current !== threadId) {
      return false;
    }
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }, []);

  const readLatestClaudeTurnCompletion = useCallback(async (workspacePath: string, claudeSessionId: string) => {
    if (typeof api.latestClaudeTurnCompletion !== 'function') {
      return null;
    }
    try {
      return await api.latestClaudeTurnCompletion(workspacePath, claudeSessionId);
    } catch {
      return null;
    }
  }, []);

  const resolveJsonlCompletionAttentionContext = useCallback(
    (threadId: string, sessionId?: string | null) => {
      const activeSessionId = sessionId ?? activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
      const sessionMeta = activeSessionId ? sessionMetaBySessionIdRef.current[activeSessionId] ?? null : null;
      const thread =
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId) ?? null;
      const workspaceId = sessionMeta?.workspaceId ?? thread?.workspaceId ?? '';
      const workspace = workspaceId ? workspaceById[workspaceId] ?? null : null;
      const claudeSessionId =
        sessionMeta?.claudeSessionId?.trim() ||
        thread?.claudeSessionId?.trim() ||
        '';
      const workspaceKind =
        sessionMeta?.workspaceKind ??
        threadWorkspaceKindByThreadIdRef.current[threadId] ??
        workspace?.kind ??
        null;
      const usesJsonlAttention =
        workspaceKind === 'local' &&
        claudeSessionId.length > 0;

      return {
        thread,
        workspace,
        sessionMeta,
        claudeSessionId,
        workspaceKind,
        usesJsonlAttention
      };
    },
    [workspaceById]
  );

  const markThreadJsonlCompletionSeen = useCallback(
    (threadId: string, persistNow = true) => {
      const currentState = threadJsonlCompletionAttentionByThreadRef.current[threadId] ?? null;
      if (!currentState || currentState.latestCompletionIndex <= currentState.lastSeenCompletionIndex) {
        return currentState;
      }
      return commitThreadJsonlCompletionAttentionState(
        threadId,
        {
          ...currentState,
          lastSeenCompletionIndex: currentState.latestCompletionIndex
        },
        { persistNow }
      );
    },
    [commitThreadJsonlCompletionAttentionState]
  );

  const observeThreadJsonlCompletion = useCallback(
    (
      threadId: string,
      claudeSessionId: string,
      completion: ClaudeTurnCompletionSummary,
      { persistNow = true, allowNotify = true }: { persistNow?: boolean; allowNotify?: boolean } = {}
    ) => {
      const normalizedSessionId = claudeSessionId.trim();
      if (!normalizedSessionId || completion.completionIndex <= 0) {
        return null;
      }

      const currentState = threadJsonlCompletionAttentionByThreadRef.current[threadId];
      const baseState =
        currentState && currentState.claudeSessionId === normalizedSessionId
          ? currentState
          : null;
      const latestCompletionIndex = baseState?.latestCompletionIndex ?? 0;
      const latestCompletedAtMs = baseState?.latestCompletedAtMs ?? 0;
      if (
        completion.completionIndex < latestCompletionIndex ||
        (completion.completionIndex === latestCompletionIndex &&
          completion.completedAtMs <= latestCompletedAtMs)
      ) {
        if (isThreadVisibleToUser(threadId)) {
          return markThreadJsonlCompletionSeen(threadId, persistNow);
        }
        return baseState ?? null;
      }

      let nextState: ThreadJsonlCompletionAttentionState = {
        claudeSessionId: normalizedSessionId,
        latestCompletionIndex: completion.completionIndex,
        lastSeenCompletionIndex: Math.min(
          baseState?.lastSeenCompletionIndex ?? 0,
          completion.completionIndex
        ),
        lastNotifiedCompletionIndex: Math.min(
          baseState?.lastNotifiedCompletionIndex ?? 0,
          completion.completionIndex
        ),
        latestStatus: completion.status,
        latestCompletedAtMs: completion.completedAtMs
      };

      const isVisible = isThreadVisibleToUser(threadId);
      if (isVisible) {
        nextState = {
          ...nextState,
          lastSeenCompletionIndex: completion.completionIndex
        };
      }

      const shouldNotify =
        allowNotify &&
        !isVisible &&
        settings.taskCompletionAlerts &&
        completion.completionIndex > (baseState?.lastNotifiedCompletionIndex ?? 0);
      if (shouldNotify) {
        nextState = {
          ...nextState,
          lastNotifiedCompletionIndex: completion.completionIndex
        };
      }

      const committedState = commitThreadJsonlCompletionAttentionState(threadId, nextState, {
        persistNow
      });

      if (shouldNotify) {
        const thread =
          Object.values(threadsByWorkspaceRef.current)
            .flat()
            .find((candidate) => candidate.id === threadId) ?? null;
        void sendTaskCompletionAlert({
          threadTitle: thread?.title ?? 'Current thread',
          status: completion.status
        });
      }

      return committedState;
    },
    [
      commitThreadJsonlCompletionAttentionState,
      isThreadVisibleToUser,
      settings.taskCompletionAlerts
    ]
  );

  const reconcileThreadJsonlCompletionAttention = useCallback(
    async (
      threadId: string,
      workspacePath: string,
      claudeSessionId: string,
      { allowNotify = true }: { allowNotify?: boolean } = {}
    ) => {
      const normalizedSessionId = claudeSessionId.trim();
      if (!threadId || !workspacePath || !normalizedSessionId) {
        return null;
      }

      const requestId = (jsonlCompletionReconcileRequestIdByThreadRef.current[threadId] ?? 0) + 1;
      jsonlCompletionReconcileRequestIdByThreadRef.current[threadId] = requestId;
      const completion = await readLatestClaudeTurnCompletion(workspacePath, normalizedSessionId);
      if (jsonlCompletionReconcileRequestIdByThreadRef.current[threadId] !== requestId) {
        return null;
      }

      const activeSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
      const currentSessionId =
        (activeSessionId
          ? sessionMetaBySessionIdRef.current[activeSessionId]?.claudeSessionId?.trim()
          : '') ||
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId)
          ?.claudeSessionId?.trim() ||
        '';
      if (currentSessionId && currentSessionId !== normalizedSessionId) {
        return null;
      }

      if (!completion) {
        return null;
      }

      return observeThreadJsonlCompletion(threadId, normalizedSessionId, completion, {
        persistNow: true,
        allowNotify
      });
    },
    [observeThreadJsonlCompletion, readLatestClaudeTurnCompletion]
  );

  const beginTurn = useCallback(
    (threadId: string) => {
      const currentState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      const startedAtMs = Date.now();
      delete lastMeaningfulOutputByThreadRef.current[threadId];
      delete outputControlCarryByThreadRef.current[threadId];
      const nextState: ThreadAttentionState = {
        ...currentState,
        activeTurnId: nextTurnIdForAttentionState(currentState),
        activeTurnStatus: 'running',
        activeTurnStartedAtMs: startedAtMs,
        activeTurnHasMeaningfulOutput: false,
        activeTurnLastOutputAtMs: null,
        activeTurnSeenOutputAtMs: null
      };
      return commitThreadAttentionState(threadId, nextState);
    },
    [commitThreadAttentionState]
  );

  const recordThreadVisibleOutput = useCallback(
    (threadId: string, persistNow = false, seenAtMs = Date.now(), visibleOutputText?: string | null) => {
      const currentState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      const outputText = visibleOutputText ?? lastTerminalLogByThreadRef.current[threadId] ?? '';
      const hasVisibleMeaningfulOutput = Boolean(extractMeaningfulOutputTail(outputText));
      const shouldPersistActiveTurnSeenOutput =
        hasVisibleMeaningfulOutput &&
        currentState.activeTurnId !== null &&
        currentState.activeTurnSeenOutputAtMs === null;
      rememberThreadVisibleOutput(threadId, outputText, seenAtMs);

      let nextState = currentState;
      if (hasVisibleMeaningfulOutput && currentState.activeTurnId !== null) {
        const nextSeenOutputAtMs = Math.max(currentState.activeTurnSeenOutputAtMs ?? 0, seenAtMs);
        if (nextSeenOutputAtMs !== (currentState.activeTurnSeenOutputAtMs ?? 0)) {
          nextState = commitThreadAttentionState(
            threadId,
            {
              ...currentState,
              activeTurnSeenOutputAtMs: nextSeenOutputAtMs
            },
            {
              persistNow: persistNow || shouldPersistActiveTurnSeenOutput
            }
          );
        } else if (persistNow) {
          flushThreadAttentionState();
        }
      } else if (persistNow) {
        flushThreadAttentionState();
      }

      if (persistNow || shouldPersistActiveTurnSeenOutput) {
        flushVisibleOutputGuardState();
      }
      return nextState;
    },
    [commitThreadAttentionState, flushThreadAttentionState, flushVisibleOutputGuardState, rememberThreadVisibleOutput]
  );

  const noteTurnOutput = useCallback(
    (threadId: string, chunk: string) => {
      const previousCarry = outputControlCarryByThreadRef.current[threadId] ?? '';
      const stripped = stripTerminalControlSequences(chunk, previousCarry);
      outputControlCarryByThreadRef.current[threadId] = stripped.carry;
      const normalized = normalizeMeaningfulOutputText(stripped.text);
      if (!normalized) {
        return false;
      }

      const looksLikeRedrawChunk = chunk.includes('\r') || chunk.includes('\u001b') || chunk.includes('\u009b');
      const lastMeaningfulOutput = lastMeaningfulOutputByThreadRef.current[threadId] ?? '';
      if (looksLikeRedrawChunk && lastMeaningfulOutput === normalized) {
        return false;
      }

      const lastUserInputAtMs = lastUserInputAtMsByThreadRef.current[threadId] ?? 0;
      const visibleOutputGuard = visibleOutputGuardByThreadRef.current[threadId];
      const isReplayOfVisibleReadOutput =
        Boolean(visibleOutputGuard) &&
        lastUserInputAtMs <= visibleOutputGuard.baselineUserInputAtMs &&
        matchesVisibleOutputTail(normalized, visibleOutputGuard.tail);
      if (isReplayOfVisibleReadOutput) {
        return false;
      }

      const attentionState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      if (attentionState.activeTurnId === null) {
        return false;
      }

      const lifecycle = runLifecycleByThreadRef.current[threadId];
      if (!workingByThreadRef.current[threadId] && lifecycle?.phase !== 'streaming' && looksLikeShellPromptText(normalized)) {
        return false;
      }

      const nowMs = Date.now();
      lastMeaningfulOutputByThreadRef.current[threadId] = normalized;
      const isCompletedTurn = attentionState.activeTurnStatus === 'completed';
      const nextAttentionState: ThreadAttentionState = {
        ...attentionState,
        activeTurnStatus: isCompletedTurn ? 'completed' : 'running',
        activeTurnHasMeaningfulOutput: true,
        activeTurnLastOutputAtMs: nowMs
      };
      if (isCompletedTurn && attentionState.lastCompletedTurnStatus) {
        nextAttentionState.lastCompletedTurnIdWithOutput = Math.max(
          attentionState.lastCompletedTurnIdWithOutput,
          attentionState.activeTurnId
        );
        nextAttentionState.lastCompletedTurnAtMs = attentionState.lastCompletedTurnAtMs ?? nowMs;
        nextAttentionState.lastCompletedTurnLastOutputAtMs = nowMs;
      }
      commitThreadAttentionState(threadId, nextAttentionState);

      if (isThreadVisibleToUser(threadId)) {
        const visibleOutputText = `${lastTerminalLogByThreadRef.current[threadId] ?? ''}${stripped.text}`;
        recordThreadVisibleOutput(threadId, false, nowMs, visibleOutputText);
      }
      return true;
    },
    [commitThreadAttentionState, isThreadVisibleToUser, recordThreadVisibleOutput]
  );

  const completeTurn = useCallback(
    (threadId: string, status: RunStatus, completedAtMs = Date.now()) => {
      const currentState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      if (currentState.activeTurnId === null) {
        return currentState;
      }

      const completedStatus: ThreadAttentionCompletionStatus | null =
        status === 'Succeeded' || status === 'Failed' ? status : null;
      const didTurnProduceOutput =
        currentState.activeTurnHasMeaningfulOutput ||
        currentState.activeTurnLastOutputAtMs !== null ||
        Boolean(lastMeaningfulOutputByThreadRef.current[threadId]);
      const shouldPersistCompletion = didTurnProduceOutput && completedStatus !== null;
      const nextState: ThreadAttentionState = {
        ...currentState,
        activeTurnStatus: 'completed',
        activeTurnHasMeaningfulOutput: didTurnProduceOutput,
        activeTurnLastOutputAtMs:
          currentState.activeTurnLastOutputAtMs ??
          (didTurnProduceOutput ? completedAtMs : null)
      };

      if (shouldPersistCompletion) {
        nextState.lastCompletedTurnIdWithOutput = currentState.activeTurnId;
        nextState.lastCompletedTurnStatus = completedStatus;
        nextState.lastCompletedTurnAtMs = completedAtMs;
        nextState.lastCompletedTurnLastOutputAtMs = nextState.activeTurnLastOutputAtMs;
      }

      return commitThreadAttentionState(threadId, nextState, {
        persistNow: true
      });
    },
    [commitThreadAttentionState]
  );

  const markTurnNotified = useCallback(
    (threadId: string, turnId: number, status: ThreadAttentionCompletionStatus | null) => {
      if (turnId <= 0 || !status) {
        return;
      }
      const currentState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      if (
        turnId < currentState.lastNotifiedTurnId ||
        (turnId === currentState.lastNotifiedTurnId && currentState.lastNotifiedTurnStatus === status)
      ) {
        return;
      }
      commitThreadAttentionState(
        threadId,
        {
          ...currentState,
          lastNotifiedTurnId: turnId,
          lastNotifiedTurnStatus: status
        },
        { persistNow: true }
      );
    },
    [commitThreadAttentionState]
  );

  const notifyCompletedTurnIfNeeded = useCallback(
    (threadId: string, attentionState: ThreadAttentionState) => {
      if (!settings.taskCompletionAlerts || !shouldNotifyAttentionTurn(attentionState) || !attentionState.lastCompletedTurnStatus) {
        return;
      }

      markTurnNotified(threadId, attentionState.lastCompletedTurnIdWithOutput, attentionState.lastCompletedTurnStatus);
      const thread =
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId) ?? null;

      void sendTaskCompletionAlert({
        threadTitle: thread?.title ?? 'Current thread',
        status: attentionState.lastCompletedTurnStatus
      });
    },
    [markTurnNotified, settings.taskCompletionAlerts]
  );

  const deleteThreadAttentionState = useCallback(
    (threadId: string) => {
      if (threadId in visibleOutputGuardByThreadRef.current) {
        delete visibleOutputGuardByThreadRef.current[threadId];
        visibleOutputGuardDirtyRef.current = true;
      }
      if (threadId in threadJsonlCompletionAttentionByThreadRef.current) {
        delete threadJsonlCompletionAttentionByThreadRef.current[threadId];
        threadJsonlCompletionAttentionDirtyRef.current = true;
        setThreadJsonlCompletionAttentionVersion((current) => current + 1);
      }
      if (!(threadId in threadAttentionByThreadRef.current)) {
        return;
      }
      delete threadAttentionByThreadRef.current[threadId];
      threadAttentionDirtyRef.current = true;
    },
    []
  );

  selectedWorkspaceIdRef.current = selectedWorkspaceId;
  selectedThreadIdRef.current = selectedThreadId;
  selectedSessionIdRef.current = selectedSessionId ?? null;
  focusedTerminalKindRef.current = focusedTerminalKind;
  shellTerminalSessionIdRef.current = shellTerminalSessionId;
  shellTerminalWorkspaceIdRef.current = shellTerminalWorkspaceId;
  readyByThreadRef.current = readyByThread;
  sshStartupBlockedByThreadRef.current = sshStartupBlockedByThread;
  sshStartupBlockedShellByWorkspaceRef.current = sshStartupBlockedShellByWorkspace;

  const setWorkspaceCreatingThread = useCallback((workspaceId: string, creating: boolean) => {
    if (!workspaceId) {
      return;
    }
    if (creating) {
      creatingThreadByWorkspaceRef.current[workspaceId] = true;
      setCreatingThreadByWorkspace((current) =>
        current[workspaceId] ? current : { ...current, [workspaceId]: true }
      );
      return;
    }

    delete creatingThreadByWorkspaceRef.current[workspaceId];
    setCreatingThreadByWorkspace((current) => removeThreadFlag(current, workspaceId));
  }, []);

  const setShellSessionBinding = useCallback((sessionId: string | null, workspaceId: string | null) => {
    shellTerminalSessionIdRef.current = sessionId;
    shellTerminalWorkspaceIdRef.current = workspaceId;
    setShellTerminalSessionId(sessionId);
    setShellTerminalWorkspaceId(workspaceId);
    if (sessionId) {
      setShellTerminalStream((current) => bindLiveTerminalSessionStream(current, sessionId));
    }
  }, []);

  const bumpShellSessionStartRequestId = useCallback(() => {
    const next = shellSessionStartRequestIdRef.current + 1;
    shellSessionStartRequestIdRef.current = next;
    return next;
  }, []);

  const invalidatePendingShellSessionStart = useCallback(
    (workspaceId?: string | null) => {
      if (
        workspaceId &&
        pendingShellSessionStartRef.current &&
        pendingShellSessionStartRef.current.workspaceId !== workspaceId
      ) {
        return;
      }
      bumpShellSessionStartRequestId();
      pendingShellSessionStartRef.current = null;
      setShellTerminalStarting(false);
    },
    [bumpShellSessionStartRequestId]
  );

  useEffect(() => {
    persistSkillUsageMap(skillUsageMap);
  }, [skillUsageMap]);

  useEffect(() => {
    window.localStorage.removeItem('atcontroller:last-read-at');
  }, []);

  const bindSession = useCallback(
    (threadId: string, sessionId: string, startedAt: string) => {
      const previousSessionId = activeRunsByThreadRef.current[threadId]?.sessionId;
      if (previousSessionId && previousSessionId !== sessionId) {
        delete threadIdBySessionIdRef.current[previousSessionId];
      }
      activeRunsByThreadRef.current = {
        ...activeRunsByThreadRef.current,
        [threadId]: {
          threadId,
          sessionId,
          startedAt
        }
      };
      threadIdBySessionIdRef.current[sessionId] = threadId;
      runStore.bindSession(threadId, sessionId, startedAt);
      lastSessionStartAtMsByThreadRef.current[threadId] = Date.now();
      delete lastMeaningfulOutputByThreadRef.current[threadId];
      delete outputControlCarryByThreadRef.current[threadId];
      const nextStream = bindTerminalSessionStream(
        terminalStreamsByThreadRef.current[threadId] ?? createTerminalSessionStreamState(),
        sessionId
      );
      terminalStreamsByThreadRef.current[threadId] = nextStream;
      lastTerminalLogByThreadRef.current[threadId] = nextStream.text;
      if (selectedThreadIdRef.current === threadId) {
        setSelectedTerminalStreamRevision((current) => current + 1);
      }
      runLifecycleByThreadRef.current[threadId] = createRunLifecycleState();
    },
    [runStore]
  );

  const startThreadWorking = useCallback(
    (threadId: string, startedAt = new Date().toISOString()) => {
      workingByThreadRef.current = {
        ...workingByThreadRef.current,
        [threadId]: { startedAt }
      };
      runStore.startWorking(threadId, startedAt);
      const startedAtMs = Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : Date.now();
      runLifecycleByThreadRef.current[threadId] = markRunStreaming(
        runLifecycleByThreadRef.current[threadId],
        startedAtMs
      );
    },
    [runStore]
  );

  const stopThreadWorking = useCallback(
    (threadId: string) => {
      if (workingByThreadRef.current[threadId]) {
        const next = { ...workingByThreadRef.current };
        delete next[threadId];
        workingByThreadRef.current = next;
      }
      runStore.stopWorking(threadId);
      const lifecycle = runLifecycleByThreadRef.current[threadId];
      if (lifecycle?.phase === 'streaming') {
        runLifecycleByThreadRef.current[threadId] = markRunReady(lifecycle);
      }
    },
    [runStore]
  );

  const finishSessionBinding = useCallback(
    (sessionId: string): string | null => {
      const mappedThreadId = threadIdBySessionIdRef.current[sessionId] ?? null;
      const removedThreadId =
        mappedThreadId && activeRunsByThreadRef.current[mappedThreadId]?.sessionId === sessionId
          ? mappedThreadId
          : null;
      if (removedThreadId) {
        const next = { ...activeRunsByThreadRef.current };
        delete next[removedThreadId];
        activeRunsByThreadRef.current = next;
      }
      delete threadIdBySessionIdRef.current[sessionId];
      const removedFromStore = runStore.finishSession(sessionId);
      const removed = removedThreadId ?? removedFromStore;
      if (removed && workingByThreadRef.current[removed]) {
        const nextWorking = { ...workingByThreadRef.current };
        delete nextWorking[removed];
        workingByThreadRef.current = nextWorking;
      }
      return removed;
    },
    [runStore]
  );

  useEffect(() => {
    const onBeforeUnload = () => {
      flushVisibleOutputGuardState();
      flushThreadJsonlCompletionAttentionState();
      flushThreadAttentionState();
    };
    const onPageHide = () => {
      flushVisibleOutputGuardState();
      flushThreadJsonlCompletionAttentionState();
      flushThreadAttentionState();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushVisibleOutputGuardState();
        flushThreadJsonlCompletionAttentionState();
        flushThreadAttentionState();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const id = window.setInterval(() => {
      flushVisibleOutputGuardState();
      flushThreadJsonlCompletionAttentionState();
      flushThreadAttentionState();
    }, 2000);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushVisibleOutputGuardState();
      flushThreadJsonlCompletionAttentionState();
      flushThreadAttentionState();
    };
  }, [
    flushThreadAttentionState,
    flushThreadJsonlCompletionAttentionState,
    flushVisibleOutputGuardState
  ]);

  useEffect(() => {
    draftAttachmentsByThreadRef.current = draftAttachmentsByThread;
  }, [draftAttachmentsByThread]);

  useEffect(() => {
    threadsByWorkspaceRef.current = threadsByWorkspace;
    const nextThreadWorkspaceKinds: Record<string, Workspace['kind']> = {};

    for (const workspace of workspaces) {
      for (const thread of threadsByWorkspace[workspace.id] ?? []) {
        nextThreadWorkspaceKinds[thread.id] = workspace.kind;
      }
    }

    threadWorkspaceKindByThreadIdRef.current = nextThreadWorkspaceKinds;

    for (const thread of Object.values(threadsByWorkspace).flat()) {
      if (!isDefaultThreadTitle(thread.title)) {
        threadTitleInitializedRef.current[thread.id] = true;
      }
    }

    const nextSeededJsonlSessions: Record<string, string> = {};
    for (const thread of Object.values(threadsByWorkspace).flat()) {
      if (thread.isArchived) {
        continue;
      }
      const claudeSessionId = thread.claudeSessionId?.trim() ?? '';
      if (!claudeSessionId) {
        continue;
      }
      const workspace = workspaces.find((candidate) => candidate.id === thread.workspaceId);
      if (!workspace || workspace.kind !== 'local') {
        continue;
      }
      nextSeededJsonlSessions[thread.id] = claudeSessionId;
      if (jsonlCompletionSeededSessionIdByThreadRef.current[thread.id] === claudeSessionId) {
        continue;
      }
      jsonlCompletionSeededSessionIdByThreadRef.current[thread.id] = claudeSessionId;
      resetThreadJsonlCompletionAttentionForSession(thread.id, claudeSessionId);
      void reconcileThreadJsonlCompletionAttention(thread.id, workspace.path, claudeSessionId, {
        allowNotify: false
      });
    }
    jsonlCompletionSeededSessionIdByThreadRef.current = nextSeededJsonlSessions;

    const deletedThreadIds = deletedThreadIdsRef.current;
    if (Object.keys(deletedThreadIds).length === 0) {
      return;
    }

    for (const thread of Object.values(threadsByWorkspace).flat()) {
      if (!deletedThreadIds[thread.id]) {
        continue;
      }
      applyThreadUpdate({
        ...thread,
        isArchived: true
      });
    }
  }, [
    applyThreadUpdate,
    reconcileThreadJsonlCompletionAttention,
    resetThreadJsonlCompletionAttentionForSession,
    threadsByWorkspace,
    workspaces
  ]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SHELL_DRAWER_HEIGHT_KEY, String(shellDrawerHeight));
  }, [shellDrawerHeight]);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    const onMove = (clientX: number) => {
      const state = sidebarResizeStateRef.current;
      if (!state) {
        return;
      }
      const safeClientX = Number.isFinite(clientX) ? clientX : state.startX;
      const nextWidth = clampSidebarWidth(state.startWidth + (safeClientX - state.startX));
      if (!Number.isFinite(nextWidth)) {
        return;
      }
      setSidebarWidth(nextWidth);
    };

    const onPointerMove = (event: PointerEvent) => {
      onMove(event.clientX);
    };

    const onMouseMove = (event: MouseEvent) => {
      onMove(event.clientX);
    };

    const finishResize = () => {
      sidebarResizeStateRef.current = null;
      setIsSidebarResizing(false);
    };

    document.body.classList.add('sidebar-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
    window.addEventListener('mouseup', finishResize);

    return () => {
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      window.removeEventListener('mouseup', finishResize);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    if (!isShellDrawerResizing) {
      return;
    }

    const onMove = (clientY: number) => {
      const state = shellDrawerResizeStateRef.current;
      if (!state) {
        return;
      }
      const safeClientY = Number.isFinite(clientY) ? clientY : state.startY;
      const nextHeight = clampShellDrawerHeight(state.startHeight + (state.startY - safeClientY));
      if (!Number.isFinite(nextHeight)) {
        return;
      }
      setShellDrawerHeight(nextHeight);
    };

    const onPointerMove = (event: PointerEvent) => {
      onMove(event.clientY);
    };

    const finishResize = () => {
      shellDrawerResizeStateRef.current = null;
      setIsShellDrawerResizing(false);
    };

    document.body.classList.add('shell-drawer-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);

    return () => {
      document.body.classList.remove('shell-drawer-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };
  }, [isShellDrawerResizing]);

  useEffect(() => {
    const clampToViewport = () => {
      setShellDrawerHeight((current) => clampShellDrawerHeight(current));
    };

    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  const pushToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    const id = todayId();
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const refreshAppUpdateInfo = useCallback(async () => {
    try {
      const updateInfo = await api.checkForUpdate();
      setAppUpdateInfo(updateInfo);
    } catch {
      setAppUpdateInfo(null);
    }
  }, []);

  useEffect(() => {
    void refreshAppUpdateInfo();
    const handle = window.setInterval(() => {
      void refreshAppUpdateInfo();
    }, 10 * 60 * 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [refreshAppUpdateInfo]);

  const registerHiddenInjectedPrompt = useCallback((threadId: string, prompt: string) => {
    const normalized = prompt.trimEnd();
    if (!normalized.trim()) {
      return;
    }
    const existing = hiddenInjectedPromptsByThreadRef.current[threadId] ?? [];
    hiddenInjectedPromptsByThreadRef.current[threadId] =
      existing.length >= MAX_HIDDEN_INJECTED_PROMPTS_PER_THREAD
        ? [...existing.slice(-(MAX_HIDDEN_INJECTED_PROMPTS_PER_THREAD - 1)), normalized]
        : [...existing, normalized];
  }, []);

  const stripThreadHiddenInjectedPrompts = useCallback((threadId: string, text: string) => {
    const prompts = hiddenInjectedPromptsByThreadRef.current[threadId] ?? [];
    return stripHiddenPromptEchoes(text, prompts);
  }, []);

  const presentThreadTerminalText = useCallback(
    (threadId: string, text: string) =>
      presentTerminalText(text, {
        currentText: terminalStreamsByThreadRef.current[threadId]?.text ?? '',
        maxChars: TERMINAL_LOG_BUFFER_CHARS,
        stripHiddenPrompts: (value) => stripThreadHiddenInjectedPrompts(threadId, value)
      }),
    [stripThreadHiddenInjectedPrompts]
  );

  const updateThreadTerminalStream = useCallback(
    (threadId: string, updater: (current: TerminalSessionStreamState) => TerminalSessionStreamState) => {
      const previous = terminalStreamsByThreadRef.current[threadId] ?? createTerminalSessionStreamState();
      const next = updater(previous);
      if (next === previous) {
        return;
      }
      terminalStreamsByThreadRef.current[threadId] = next;
      lastTerminalLogByThreadRef.current[threadId] = next.text;
      if (selectedThreadIdRef.current === threadId) {
        setSelectedTerminalStreamRevision((current) => current + 1);
      }
    },
    []
  );

  const normalizeThreadTerminalSnapshot = useCallback(
    (threadId: string, snapshot: TerminalOutputSnapshot | null | undefined): TerminalOutputSnapshot => {
      const rawText = snapshot?.text ?? '';
      const presented = presentTerminalWindow(rawText, {
        currentText: terminalStreamsByThreadRef.current[threadId]?.text ?? '',
        maxChars: TERMINAL_LOG_BUFFER_CHARS,
        stripHiddenPrompts: (value) => stripThreadHiddenInjectedPrompts(threadId, value)
      });
      return {
        text: presented.text,
        startPosition: (snapshot?.startPosition ?? 0) + presented.startOffset,
        endPosition: snapshot?.endPosition ?? rawText.length,
        truncated: snapshot?.truncated ?? false
      };
    },
    [stripThreadHiddenInjectedPrompts]
  );

  const presentThreadTerminalSnapshot = useCallback(
    (
      threadId: string,
      snapshot: TerminalOutputSnapshot | null | undefined,
      sessionId: string | null = null
    ) => {
      const nextSnapshot = normalizeThreadTerminalSnapshot(threadId, snapshot);
      const previousText = lastTerminalLogByThreadRef.current[threadId] ?? '';

      updateThreadTerminalStream(threadId, (current) => {
        const boundState =
          current.sessionId === sessionId ? current : bindTerminalSessionStream(current, sessionId);
        return presentTerminalSnapshot(boundState, nextSnapshot, TERMINAL_LOG_BUFFER_CHARS);
      });

      if (
        threadId === selectedThreadIdRef.current &&
        nextSnapshot.text &&
        nextSnapshot.text !== previousText &&
        isThreadVisibleToUser(threadId)
      ) {
        recordThreadVisibleOutput(threadId, false, Date.now(), nextSnapshot.text);
      }
    },
    [isThreadVisibleToUser, normalizeThreadTerminalSnapshot, recordThreadVisibleOutput, updateThreadTerminalStream]
  );

  const clearThreadTerminalStream = useCallback((threadId: string) => {
    if (!(threadId in terminalStreamsByThreadRef.current)) {
      return;
    }
    delete terminalStreamsByThreadRef.current[threadId];
    delete lastTerminalLogByThreadRef.current[threadId];
    delete terminalHydrationRequestIdByThreadRef.current[threadId];
    if (selectedThreadIdRef.current === threadId) {
      setSelectedTerminalStreamRevision((current) => current + 1);
    }
  }, []);

  const clearThreadTerminalStreams = useCallback((threadIds: string[]) => {
    let changed = false;
    let clearedSelectedThread = false;
    for (const threadId of threadIds) {
      if (threadId in terminalStreamsByThreadRef.current) {
        delete terminalStreamsByThreadRef.current[threadId];
        changed = true;
      }
      if (threadId in lastTerminalLogByThreadRef.current) {
        delete lastTerminalLogByThreadRef.current[threadId];
      }
      if (threadId in terminalHydrationRequestIdByThreadRef.current) {
        delete terminalHydrationRequestIdByThreadRef.current[threadId];
      }
      if (selectedThreadIdRef.current === threadId) {
        clearedSelectedThread = true;
      }
    }
    if (changed || clearedSelectedThread) {
      setSelectedTerminalStreamRevision((current) => current + 1);
    }
  }, []);

  const clearThreadWorkingStopTimer = useCallback((threadId: string) => {
    const handle = workingStopTimerByThreadRef.current[threadId];
    if (typeof handle === 'number') {
      window.clearTimeout(handle);
    }
    delete workingStopTimerByThreadRef.current[threadId];
  }, []);

  const clearAllThreadWorkingStopTimers = useCallback(() => {
    for (const handle of Object.values(workingStopTimerByThreadRef.current)) {
      window.clearTimeout(handle);
    }
    workingStopTimerByThreadRef.current = {};
  }, []);

  const rememberThreadRuntimeCwd = useCallback((threadId: string, cwd: string | null | undefined) => {
    const normalized = cwd?.trim() ?? '';
    if (!threadId) {
      return;
    }
    const current = threadRuntimeCwdByThreadRef.current;
    const next = !normalized
      ? (current[threadId] ? removeRecordEntry(current, threadId) : current)
      : current[threadId] === normalized
        ? current
        : {
            ...current,
            [threadId]: normalized
          };
    threadRuntimeCwdByThreadRef.current = next;
    setThreadRuntimeCwdByThread(next);
  }, []);
  const clearThreadRuntimeCwd = useCallback((threadId: string) => {
    rememberThreadRuntimeCwd(threadId, null);
  }, [rememberThreadRuntimeCwd]);

  const bootstrapThreadRuntimeCwdFromClaudeSession = useCallback(
    async (threadId: string, sessionId: string) => {
      if (!threadId || !sessionId) {
        return;
      }

      const sessionMeta = sessionMetaBySessionIdRef.current[sessionId];
      if (!sessionMeta || sessionMeta.workspaceKind !== 'local') {
        return;
      }

      const thread =
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId) ?? null;
      const claudeSessionId = sessionMeta.claudeSessionId?.trim() || thread?.claudeSessionId?.trim() || '';
      if (!claudeSessionId) {
        return;
      }

      const workspace = workspaces.find((candidate) => candidate.id === sessionMeta.workspaceId);
      if (!workspace || workspace.kind !== 'local') {
        return;
      }

      try {
        const cwd = await api.latestClaudeSessionCwd(workspace.path, claudeSessionId);
        if (!cwd?.trim()) {
          return;
        }
        if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
          return;
        }
        const latestSessionMeta = sessionMetaBySessionIdRef.current[sessionId];
        if (!latestSessionMeta) {
          return;
        }
        latestSessionMeta.claudeSessionId = claudeSessionId;
        latestSessionMeta.currentCwd = cwd;
        rememberThreadRuntimeCwd(threadId, cwd);
      } catch {
        // best effort
      }
    },
    [rememberThreadRuntimeCwd, workspaces]
  );

  const resolveInitialThreadCwd = useCallback(
    async (thread: ThreadMetadata, workspace: Workspace): Promise<string | null> => {
      if (workspace.kind !== 'local') {
        return null;
      }

      const remembered = threadRuntimeCwdByThreadRef.current[thread.id]?.trim() ?? '';
      if (remembered) {
        return remembered;
      }

      const claudeSessionId = thread.claudeSessionId?.trim() ?? '';
      if (!claudeSessionId) {
        return workspace.path;
      }

      try {
        const latestCwd = await api.latestClaudeSessionCwd(workspace.path, claudeSessionId);
        return latestCwd?.trim() || workspace.path;
      } catch {
        return workspace.path;
      }
    },
    []
  );

  const clearTerminalSessionTracking = useCallback(
    (sessionId: string) => {
      delete threadIdBySessionIdRef.current[sessionId];
      delete sessionMetaBySessionIdRef.current[sessionId];
      delete lastSentTerminalSizeBySessionRef.current[sessionId];
      delete pendingSshStartupAuthStatusBySessionIdRef.current[sessionId];
      if (pendingTerminalResizeRef.current?.sessionId === sessionId) {
        pendingTerminalResizeRef.current = null;
        if (pendingTerminalResizeTimerRef.current !== null) {
          window.clearTimeout(pendingTerminalResizeTimerRef.current);
          pendingTerminalResizeTimerRef.current = null;
        }
      }
    },
    []
  );

  // Returns true only if the user sent at least one message in the current session
  // (i.e. after the most recent session bind). Prevents Claude's startup prompt from
  // being treated as fresh output on non-selected threads.
  const hasUserSentMessageInCurrentSession = useCallback((threadId: string) => {
    const sessionStart = lastSessionStartAtMsByThreadRef.current[threadId] ?? 0;
    const lastUserInput = lastUserInputAtMsByThreadRef.current[threadId] ?? 0;
    return lastUserInput > sessionStart;
  }, []);

  const resolveThreadTurnCompletionMode = useCallback((threadId: string): TerminalTurnCompletionMode => {
    const activeSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
    if (!activeSessionId) {
      return 'idle';
    }
    return sessionMetaBySessionIdRef.current[activeSessionId]?.turnCompletionMode ?? 'idle';
  }, []);

  const threadStatusById = useMemo(() => {
    const statusById: Record<string, { isWorking: boolean }> = {};
    for (const thread of allThreads) {
      statusById[thread.id] = {
        isWorking: runStore.isThreadWorking(thread.id)
      };
    }
    return statusById;
  }, [allThreads, runStore]);

  const isThreadWorking = useCallback(
    (threadId: string) => threadStatusById[threadId]?.isWorking ?? false,
    [threadStatusById]
  );

  const unreadCompletedTurnByThread = useMemo(() => {
    const unreadByThread: Record<string, true> = {};
    for (const thread of allThreads) {
      if (thread.isArchived) {
        continue;
      }
      if (!isUnreadJsonlCompletionAttention(threadJsonlCompletionAttentionByThreadRef.current[thread.id])) {
        continue;
      }
      unreadByThread[thread.id] = true;
    }
    return unreadByThread;
  }, [allThreads, threadJsonlCompletionAttentionVersion]);

  const unreadCompletedTurnCount = useMemo(
    () => Object.keys(unreadCompletedTurnByThread).length,
    [unreadCompletedTurnByThread]
  );

  const scheduleThreadWorkingStop = useCallback(
    (threadId: string, delayMs = THREAD_WORKING_IDLE_TIMEOUT_MS) => {
      clearThreadWorkingStopTimer(threadId);
      workingStopTimerByThreadRef.current[threadId] = window.setTimeout(() => {
        delete workingStopTimerByThreadRef.current[threadId];
        stopThreadWorking(threadId);
        if (resolveThreadTurnCompletionMode(threadId) === 'jsonl') {
          return;
        }
        const runCompletion = () => {
          // Skip if re-entered working state since the visual stop.
          if (workingByThreadRef.current[threadId]) {
            return;
          }
          const previousAttentionState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
          if (hasCompletedAttentionTurn(previousAttentionState)) {
            return;
          }
          const completedAttentionState = completeTurn(threadId, 'Succeeded');
          if (
            completedAttentionState.lastCompletedTurnIdWithOutput > previousAttentionState.lastCompletedTurnIdWithOutput ||
            (
              completedAttentionState.lastCompletedTurnIdWithOutput === previousAttentionState.lastCompletedTurnIdWithOutput &&
              completedAttentionState.lastCompletedTurnStatus === 'Succeeded' &&
              shouldNotifyAttentionTurn(completedAttentionState)
            )
          ) {
            notifyCompletedTurnIfNeeded(threadId, completedAttentionState);
          }
        };
        runCompletion();
      }, delayMs);
    },
    [
      clearThreadWorkingStopTimer,
      completeTurn,
      notifyCompletedTurnIfNeeded,
      resolveThreadTurnCompletionMode,
      stopThreadWorking
    ]
  );

  useEffect(() => {
    return () => {
      clearAllThreadWorkingStopTimers();
      outputControlCarryByThreadRef.current = {};
      runLifecycleByThreadRef.current = {};
    };
  }, [clearAllThreadWorkingStopTimers]);

  const beginSidebarResize = useCallback(
    (clientX: number) => {
      const safeClientX = Number.isFinite(clientX) ? clientX : 0;
      sidebarResizeStateRef.current = {
        startX: safeClientX,
        startWidth: sidebarWidth
      };
      setIsSidebarResizing(true);
    },
    [sidebarWidth]
  );

  const beginShellDrawerResize = useCallback(
    (clientY: number) => {
      const safeClientY = Number.isFinite(clientY) ? clientY : 0;
      shellDrawerResizeStateRef.current = {
        startY: safeClientY,
        startHeight: shellDrawerHeight
      };
      setIsShellDrawerResizing(true);
    },
    [shellDrawerHeight]
  );

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      event.preventDefault();
      beginSidebarResize(event.clientX);
    },
    [beginSidebarResize]
  );

  const startSidebarResizeWithMouse = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      event.preventDefault();
      beginSidebarResize(event.clientX);
    },
    [beginSidebarResize]
  );

  const refreshWorkspaces = useCallback(async () => {
    const all = await api.listWorkspaces();
    setWorkspaces((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(all)) {
        return prev;
      }
      return all;
    });
    if (all.length === 0) {
      setSelectedWorkspace(undefined);
      setSelectedThread(undefined);
      return;
    }

    const persisted = window.localStorage.getItem(SELECTED_WORKSPACE_KEY) ?? '';
    const current = selectedWorkspaceIdRef.current;

    const nextWorkspaceId =
      (current && all.some((workspace) => workspace.id === current) && current) ||
      (persisted && all.some((workspace) => workspace.id === persisted) && persisted) ||
      all[0].id;

    setSelectedWorkspace(nextWorkspaceId);
  }, [setSelectedThread, setSelectedWorkspace]);

  const primeRemoteThreadStartupOnSelection = useCallback(
    (thread: ThreadMetadata | undefined, workspaceOverride?: Workspace | null) => {
      if (!thread) {
        return;
      }

      const workspace =
        workspaceOverride ?? workspaces.find((candidate) => candidate.id === thread.workspaceId) ?? null;
      if (!workspace || !isRemoteWorkspaceKind(workspace.kind)) {
        return;
      }
      if ((sessionFailCountByThreadRef.current[thread.id] ?? 0) >= 3) {
        return;
      }
      if (workspace.kind === 'ssh' && sshStartupBlockedByThreadRef.current[thread.id]) {
        return;
      }
      if (activeRunsByThreadRef.current[thread.id]?.sessionId || startingSessionByThreadRef.current[thread.id]) {
        return;
      }

      setStartingByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
      setReadyByThread((current) => removeThreadFlag(current, thread.id));
    },
    [workspaces]
  );

  const refreshThreadsForWorkspace = useCallback(
    async (workspaceId: string) => {
      const threads = await listThreads(workspaceId);

      if (selectedWorkspaceIdRef.current !== workspaceId) {
        return threads;
      }

      const persistedThreadId = window.localStorage.getItem(threadSelectionKey(workspaceId)) ?? '';
      const currentThreadId = selectedThreadIdRef.current;

      const nextThreadId =
        (currentThreadId && threads.some((thread) => thread.id === currentThreadId) && currentThreadId) ||
        (persistedThreadId && threads.some((thread) => thread.id === persistedThreadId) && persistedThreadId) ||
        threads[0]?.id;

      const nextThread = threads.find((thread) => thread.id === nextThreadId);
      primeRemoteThreadStartupOnSelection(nextThread);
      setSelectedThread(nextThreadId);
      return threads;
    },
    [listThreads, primeRemoteThreadStartupOnSelection, setSelectedThread]
  );

  const resolvePendingThreadFork = useCallback(
    async (threadId: string, options?: { notifyOnTimeout?: boolean }) => {
      const existing = forkResolutionByThreadRef.current[threadId];
      if (existing) {
        return existing;
      }

      const promise = (async () => {
        const initialThread = Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId);
        if (!initialThread || deletedThreadIdsRef.current[threadId]) {
          return;
        }

        const workspace = workspaces.find((candidate) => candidate.id === initialThread.workspaceId);
        if (!workspace || isRemoteWorkspaceKind(workspace.kind)) {
          return;
        }

        const sourceClaudeSessionId = initialThread.pendingForkSourceClaudeSessionId?.trim() ?? '';
        if (!isUuidLike(sourceClaudeSessionId)) {
          return;
        }

        const excludedChildSessionIds = new Set(
          (initialThread.pendingForkKnownChildSessionIds ?? []).filter((sessionId) => isUuidLike(sessionId))
        );
        let deadlineAtMs: number | null = null;
        const hardDeadlineAtMs = Date.now() + THREAD_FORK_RESOLUTION_HARD_TIMEOUT_MS;

        while (Date.now() < hardDeadlineAtMs) {
          if (deletedThreadIdsRef.current[threadId]) {
            return;
          }

          const latestThread = Object.values(threadsByWorkspaceRef.current)
            .flat()
            .find((candidate) => candidate.id === threadId);
          if (!latestThread) {
            return;
          }
          if ((latestThread.pendingForkSourceClaudeSessionId?.trim() ?? '') !== sourceClaudeSessionId) {
            return;
          }

          const activeSessionId = activeRunsByThreadRef.current[latestThread.id]?.sessionId ?? null;
          const activeSessionMode =
            activeSessionId ? sessionMetaBySessionIdRef.current[activeSessionId]?.mode ?? null : null;
          const waitingForFirstForkTurn =
            activeSessionMode === 'forked' && !hasUserSentMessageInCurrentSession(latestThread.id);

          if (waitingForFirstForkTurn) {
            deadlineAtMs = null;
          } else if (deadlineAtMs === null) {
            deadlineAtMs = Date.now() + THREAD_FORK_RESOLUTION_TIMEOUT_MS;
          } else if (Date.now() >= deadlineAtMs) {
            break;
          }

          if (!waitingForFirstForkTurn) {
            const childClaudeSessionId = (await api.resolveThreadForkCandidate(
              sourceClaudeSessionId,
              [...excludedChildSessionIds],
              latestThread.pendingForkRequestedAt ?? null
            ))?.trim();
            if (
              childClaudeSessionId &&
              isUuidLike(childClaudeSessionId) &&
              childClaudeSessionId !== sourceClaudeSessionId
            ) {
              try {
                delete forkResolutionTimeoutNotifiedByThreadRef.current[threadId];
                const updatedThread = await api.setThreadClaudeSessionId(
                  latestThread.workspaceId,
                  latestThread.id,
                  childClaudeSessionId
                );
                applyThreadUpdate(updatedThread);
                setForkResolutionFailureBlockedByThread((current) =>
                  removeRecordEntry(current, updatedThread.id)
                );
                setForkResolutionFailureModal((current) =>
                  current?.threadId === updatedThread.id ? null : current
                );
                delete allowFreshStartAfterForkFailureByThreadRef.current[updatedThread.id];

                if (activeSessionId) {
                  void api.terminalRebindClaudeSession(activeSessionId, childClaudeSessionId);
                }

                await refreshThreadsForWorkspace(latestThread.workspaceId);
                return;
              } catch (error) {
                if (isForkSessionAlreadyClaimedError(error)) {
                  excludedChildSessionIds.add(childClaudeSessionId);
                  continue;
                }
                throw error;
              }
            }
          }

          await new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), THREAD_FORK_RESOLUTION_POLL_INTERVAL_MS);
          });
        }

        const timedOutThread = Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((candidate) => candidate.id === threadId);
        if (
          timedOutThread &&
          (timedOutThread.pendingForkSourceClaudeSessionId?.trim() ?? '') === sourceClaudeSessionId
        ) {
          try {
            const clearedThread = await api.clearThreadPendingFork(
              timedOutThread.workspaceId,
              timedOutThread.id
            );
            applyThreadUpdate(clearedThread);
            await refreshThreadsForWorkspace(timedOutThread.workspaceId);
            if (!allowFreshStartAfterForkFailureByThreadRef.current[timedOutThread.id]) {
              setForkResolutionFailureBlockedByThread((current) =>
                current[timedOutThread.id] ? current : { ...current, [timedOutThread.id]: true }
              );
              setForkResolutionFailureModal((current) =>
                current?.threadId === timedOutThread.id
                  ? current
                  : {
                      threadId: timedOutThread.id,
                      workspaceId: timedOutThread.workspaceId
                    }
              );
            }
          } catch {
            // Leave the pending state in place if cleanup fails so the user can retry later.
          }
        }

        if (options?.notifyOnTimeout && !forkResolutionTimeoutNotifiedByThreadRef.current[threadId]) {
          forkResolutionTimeoutNotifiedByThreadRef.current[threadId] = true;
          pushToast(
            'ATController could not confirm the forked child session, so fork tracking was cleared for this thread.',
            'error'
          );
        }
      })().finally(() => {
        delete forkResolutionByThreadRef.current[threadId];
      });

      forkResolutionByThreadRef.current[threadId] = promise;
      return promise;
    },
    [
      applyThreadUpdate,
      hasUserSentMessageInCurrentSession,
      pushToast,
      refreshThreadsForWorkspace,
      workspaces
    ]
  );

  const refreshSkillsForWorkspace = useCallback(async (workspace: Workspace) => {
    if (isRemoteWorkspaceKind(workspace.kind)) {
      setSkillsByWorkspaceId((current) => {
        if ((current[workspace.id] ?? []).length === 0) {
          return current;
        }
        return {
          ...current,
          [workspace.id]: []
        };
      });
      setSkillsLoadingByWorkspaceId((current) => ({
        ...current,
        [workspace.id]: false
      }));
      setSkillErrorsByWorkspaceId((current) => ({
        ...current,
        [workspace.id]: null
      }));
      return [];
    }

    const requestId = (skillListRequestIdByWorkspaceRef.current[workspace.id] ?? 0) + 1;
    skillListRequestIdByWorkspaceRef.current[workspace.id] = requestId;
    setSkillsLoadingByWorkspaceId((current) => ({
      ...current,
      [workspace.id]: true
    }));
    setSkillErrorsByWorkspaceId((current) => ({
      ...current,
      [workspace.id]: null
    }));

    try {
      const skills = await api.listSkills(workspace.path);
      if (skillListRequestIdByWorkspaceRef.current[workspace.id] !== requestId) {
        return skills;
      }
      setSkillsByWorkspaceId((current) => ({
        ...current,
        [workspace.id]: skills
      }));
      return skills;
    } catch (error) {
      if (skillListRequestIdByWorkspaceRef.current[workspace.id] !== requestId) {
        return [];
      }
      setSkillErrorsByWorkspaceId((current) => ({
        ...current,
        [workspace.id]: String(error)
      }));
      return [];
    } finally {
      if (skillListRequestIdByWorkspaceRef.current[workspace.id] === requestId) {
        setSkillsLoadingByWorkspaceId((current) => ({
          ...current,
          [workspace.id]: false
        }));
      }
    }
  }, []);

  const refreshGitInfo = useCallback(async () => {
    const requestId = gitInfoRequestIdRef.current + 1;
    gitInfoRequestIdRef.current = requestId;
    const requestedPath = selectedGitContextPath?.trim() ?? '';
    if (!requestedPath) {
      setGitInfo(null);
      return;
    }
    try {
      const info = await api.getGitInfo(requestedPath);
      if (gitInfoRequestIdRef.current !== requestId) {
        return;
      }
      if (selectedGitContextPathRef.current !== requestedPath) {
        return;
      }
      setGitInfo(info);
    } catch (error) {
      if (gitInfoRequestIdRef.current === requestId && selectedGitContextPathRef.current === requestedPath) {
        setGitInfo(null);
      }
    }
  }, [selectedGitContextPath]);

  const clearThreadSkillsAfterSend = useCallback(
    async (threadId: string) => {
      delete pendingSkillClearByThreadRef.current[threadId];
      const thread = Object.values(threadsByWorkspaceRef.current)
        .flat()
        .find((item) => item.id === threadId);
      if (!thread || (thread.enabledSkills?.length ?? 0) === 0) {
        return;
      }

      setSkillsUpdating(true);
      try {
        const updated = await setThreadSkills(thread.workspaceId, thread.id, []);
        applyThreadUpdate(updated);
      } catch (error) {
        pushToast(`Failed to update skills: ${String(error)}`, 'error');
      } finally {
        setSkillsUpdating(false);
      }
    },
    [applyThreadUpdate, pushToast, setThreadSkills]
  );

  const flushPendingThreadInput = useCallback(async (threadId: string, sessionId: string) => {
    const pending = pendingInputByThreadRef.current[threadId];
    if (!pending) {
      return;
    }
    const shouldClearSkills = Boolean(pendingSkillClearByThreadRef.current[threadId]);
    delete pendingInputByThreadRef.current[threadId];
    lastUserInputAtMsByThreadRef.current[threadId] = Date.now();
    try {
      await api.terminalWrite(sessionId, pending);
    } catch (error) {
      if (shouldClearSkills) {
        delete pendingSkillClearByThreadRef.current[threadId];
      }
      throw error;
    }
    if (shouldClearSkills) {
      await clearThreadSkillsAfterSend(threadId);
    }
  }, [clearThreadSkillsAfterSend]);

  const getThreadDraftInput = useCallback((threadId: string) => inputBufferByThreadRef.current[threadId] ?? '', []);

  const replayThreadDraftInput = useCallback(async (sessionId: string | null, draftInput: string) => {
    if (!sessionId || draftInput.length === 0) {
      return;
    }
    await api.terminalWrite(sessionId, draftInput).catch(() => undefined);
  }, []);

  const waitForThreadReplayWindow = useCallback(
    async (threadId: string, sessionId: string | null, timeoutMs = 2500) => {
      if (!sessionId) {
        return false;
      }

      const startedAtMs = Date.now();
      let hydrationSettledAtMs: number | null = null;
      while (Date.now() - startedAtMs < timeoutMs) {
        if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
          return false;
        }

        const hydrationPending =
          terminalStreamsByThreadRef.current[threadId]?.sessionId === sessionId &&
          terminalStreamsByThreadRef.current[threadId]?.phase === 'hydrating';
        if (!hydrationPending && hydrationSettledAtMs === null) {
          hydrationSettledAtMs = Date.now();
        }

        const cached = lastTerminalLogByThreadRef.current[threadId] ?? '';
        if (!hydrationPending && looksLikeClaudeUiReadyText(cached)) {
          return true;
        }

        const snapshot = await api.terminalReadOutput(sessionId).catch(() => null);
        if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
          return false;
        }

        const hydrationStillPending =
          terminalStreamsByThreadRef.current[threadId]?.sessionId === sessionId &&
          terminalStreamsByThreadRef.current[threadId]?.phase === 'hydrating';
        if (!hydrationStillPending && hydrationSettledAtMs === null) {
          hydrationSettledAtMs = Date.now();
        }

        if (!hydrationStillPending && looksLikeClaudeUiReadyText(snapshot?.text ?? '')) {
          return true;
        }

        if (hydrationSettledAtMs !== null && Date.now() - hydrationSettledAtMs >= 180) {
          return true;
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 70);
        });
      }

      return (
        activeRunsByThreadRef.current[threadId]?.sessionId === sessionId &&
        terminalStreamsByThreadRef.current[threadId]?.phase !== 'hydrating'
      );
    },
    []
  );

  const setAttachmentDraftForThread = useCallback((threadId: string, paths: string[]) => {
    setDraftAttachmentsByThread((current) => {
      const next = { ...current };
      if (paths.length === 0) {
        if (!(threadId in next)) {
          return current;
        }
        delete next[threadId];
        return next;
      }
      const existing = current[threadId] ?? [];
      if (existing.length === paths.length && existing.every((item, index) => item === paths[index])) {
        return current;
      }
      next[threadId] = paths;
      return next;
    });
  }, []);

  const addAttachmentDraftPaths = useCallback(
    (threadId: string, rawPaths: string[]) => {
      const incoming = normalizeAttachmentPaths(rawPaths);
      if (incoming.length === 0) {
        return 0;
      }
      const existing = draftAttachmentsByThreadRef.current[threadId] ?? [];
      const merged = mergeAttachmentPaths(existing, incoming);
      setAttachmentDraftForThread(threadId, merged);
      return merged.length - existing.length;
    },
    [setAttachmentDraftForThread]
  );

  const clearAttachmentDraftForThread = useCallback(
    (threadId: string) => {
      setAttachmentDraftForThread(threadId, []);
    },
    [setAttachmentDraftForThread]
  );

  const removeAttachmentDraftPath = useCallback(
    (threadId: string, path: string) => {
      const existing = draftAttachmentsByThreadRef.current[threadId] ?? [];
      if (existing.length === 0) {
        return;
      }
      const next = existing.filter((item) => item !== path);
      setAttachmentDraftForThread(threadId, next);
    },
    [setAttachmentDraftForThread]
  );

  const togglePinnedSkillForSelectedWorkspace = useCallback((skillId: string) => {
    if (!selectedWorkspace) {
      return;
    }
    setSkillUsageMap((current) => toggleSkillPinned(current, selectedWorkspace.path, skillId));
  }, [selectedWorkspace]);

  const updateSelectedThreadSkills = useCallback(
    async (nextSkillIds: string[]) => {
      if (!selectedThread) {
        return;
      }
      const normalizedSkillIds = Array.from(new Set(nextSkillIds.filter((skillId) => skillId.trim().length > 0)));
      setSkillsUpdating(true);
      try {
        const updated = await setThreadSkills(selectedThread.workspaceId, selectedThread.id, normalizedSkillIds);
        applyThreadUpdate(updated);
      } catch (error) {
        pushToast(`Failed to update skills: ${String(error)}`, 'error');
      } finally {
        setSkillsUpdating(false);
      }
    },
    [applyThreadUpdate, pushToast, selectedThread, setThreadSkills]
  );

  const toggleSelectedThreadSkill = useCallback(
    async (skillId: string) => {
      if (!selectedThread) {
        return;
      }
      const selectedIds = selectedThread.enabledSkills ?? [];
      const nextSkillIds = selectedIds.includes(skillId)
        ? selectedIds.filter((currentSkillId) => currentSkillId !== skillId)
        : [...selectedIds, skillId];
      await updateSelectedThreadSkills(nextSkillIds);
    },
    [selectedThread, updateSelectedThreadSkills]
  );

  const removeMissingSelectedThreadSkill = useCallback(
    async (skillId: string) => {
      if (!selectedThread) {
        return;
      }
      const nextSkillIds = (selectedThread.enabledSkills ?? []).filter((currentSkillId) => currentSkillId !== skillId);
      await updateSelectedThreadSkills(nextSkillIds);
    },
    [selectedThread, updateSelectedThreadSkills]
  );

  const appendTerminalLogChunk = useCallback((threadId: string, event: TerminalDataEvent) => {
    const visibleChunk = presentTerminalEventData(event.data, {
      currentText: terminalStreamsByThreadRef.current[threadId]?.text ?? '',
      stripHiddenPrompts: (value) => stripThreadHiddenInjectedPrompts(threadId, value)
    });
    if (!visibleChunk) {
      updateThreadTerminalStream(threadId, (current) =>
        appendTerminalStreamChunk(
          current,
          {
            sessionId: event.sessionId,
            startPosition: event.startPosition,
            endPosition: event.endPosition,
            data: ''
          },
          TERMINAL_LOG_BUFFER_CHARS
        )
      );
      return;
    }
    updateThreadTerminalStream(threadId, (current) =>
      appendTerminalStreamChunk(
        current,
        {
          sessionId: event.sessionId,
          startPosition: event.startPosition,
          endPosition: event.endPosition,
          data: visibleChunk
        },
        TERMINAL_LOG_BUFFER_CHARS
      )
    );
  }, [stripThreadHiddenInjectedPrompts, updateThreadTerminalStream]);

  const hasCachedTerminalLog = useCallback((threadId: string) => {
    const stream = terminalStreamsByThreadRef.current[threadId];
    return Boolean(stream && (stream.text.length > 0 || stream.chunks.length > 0));
  }, []);

  const hydrateSessionSnapshot = useCallback(
    async (
      threadId: string,
      sessionId: string,
      options: {
        forceFreshReadySnapshot?: boolean;
        keepSelectedStatefulHydrationOverlayOnFailure?: boolean;
        requestId?: number;
        retryDelaysMs?: readonly number[];
      } = {}
    ) => {
      const requestId =
        options.requestId ?? (terminalHydrationRequestIdByThreadRef.current[threadId] ?? 0) + 1;
      if (options.requestId === undefined) {
        terminalHydrationRequestIdByThreadRef.current[threadId] = requestId;
      } else if (terminalHydrationRequestIdByThreadRef.current[threadId] !== requestId) {
        return;
      }
      if (threadId === selectedThreadIdRef.current && sessionId === selectedSessionIdRef.current) {
        setSelectedStatefulHydrationFailedSessionId((current) => (current === sessionId ? null : current));
      }
      const scheduleRetry = (remainingRetryDelays: readonly number[]) => {
        const [nextDelayMs, ...restRetryDelays] = remainingRetryDelays;
        if (nextDelayMs === undefined) {
          return false;
        }
        window.setTimeout(() => {
          if (terminalHydrationRequestIdByThreadRef.current[threadId] !== requestId) {
            return;
          }
          if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
            return;
          }
          void hydrateSessionSnapshot(threadId, sessionId, {
            ...options,
            requestId,
            retryDelaysMs: restRetryDelays
          });
        }, nextDelayMs);
        return true;
      };
      void bootstrapThreadRuntimeCwdFromClaudeSession(threadId, sessionId);
      const snapshot = await api.terminalReadOutput(sessionId).catch(() => null);
      if (terminalHydrationRequestIdByThreadRef.current[threadId] !== requestId) {
        return;
      }
      if (activeRunsByThreadRef.current[threadId]?.sessionId !== sessionId) {
        return;
      }
      if (!snapshot) {
        if (scheduleRetry(options.retryDelaysMs ?? [])) {
          return;
        }
        if (
          threadId === selectedThreadIdRef.current &&
          sessionId === selectedSessionIdRef.current
        ) {
          if (options.keepSelectedStatefulHydrationOverlayOnFailure) {
            updateThreadTerminalStream(threadId, (current) => ({
              ...bindLiveTerminalSessionStream(current, sessionId),
              rawEndPosition: current.rawEndPosition,
              startPosition: current.rawEndPosition,
              endPosition: current.rawEndPosition
            }));
            setSelectedStatefulHydrationFailedSessionId((current) =>
              current === sessionId ? current : sessionId
            );
          }
          setSelectedStatefulHydrationSessionId((current) => (current === sessionId ? null : current));
        }
        return;
      }
      const sessionMeta = sessionMetaBySessionIdRef.current[sessionId];
      const requiresReadySignal = requiresExplicitSshReadySignal(sessionMeta?.workspaceKind);
      const nextSnapshot = normalizeThreadTerminalSnapshot(threadId, snapshot);
      updateThreadTerminalStream(threadId, (current) => {
        if (options.forceFreshReadySnapshot) {
          return presentTerminalSnapshot(
            bindLiveTerminalSessionStream(current, sessionId),
            nextSnapshot,
            TERMINAL_LOG_BUFFER_CHARS
          );
        }
        return hydrateTerminalSessionStream(current, sessionId, nextSnapshot, TERMINAL_LOG_BUFFER_CHARS);
      });
      if (
        threadId === selectedThreadIdRef.current &&
        nextSnapshot.text &&
        isThreadVisibleToUser(threadId)
      ) {
        recordThreadVisibleOutput(threadId, false, Date.now(), nextSnapshot.text);
      }
      if (threadId === selectedThreadIdRef.current && sessionId === selectedSessionIdRef.current) {
        setSelectedStatefulHydrationSessionId((current) => (current === sessionId ? null : current));
        setSelectedStatefulHydrationFailedSessionId((current) => (current === sessionId ? null : current));
      }
      scheduleRetry(options.retryDelaysMs ?? []);
      if (!requiresReadySignal) {
        runLifecycleByThreadRef.current[threadId] = markRunReady(runLifecycleByThreadRef.current[threadId]);
        setStartingByThread((current) => removeThreadFlag(current, threadId));
        setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
      }
    },
    [
      bootstrapThreadRuntimeCwdFromClaudeSession,
      isThreadVisibleToUser,
      recordThreadVisibleOutput,
      normalizeThreadTerminalSnapshot,
      updateThreadTerminalStream
    ]
  );

  const requestSelectedStatefulTerminalRepair = useCallback(() => {
    const threadId = selectedThread?.id;
    const sessionId = selectedSessionId;
    if (
      !threadId ||
      !sessionId ||
      !selectedTerminalLooksStateful ||
      isSelectedThreadStarting ||
      selectedTerminalFollowPaused
    ) {
      return;
    }
    const requestToken = statefulRedrawRequestTokenRef.current + 1;
    statefulRedrawRequestTokenRef.current = requestToken;

    if (statefulTerminalResyncTimerRef.current !== null) {
      window.clearTimeout(statefulTerminalResyncTimerRef.current);
    }
    statefulTerminalResyncTimerRef.current = window.setTimeout(() => {
      statefulTerminalResyncTimerRef.current = null;
      if (statefulRedrawRequestTokenRef.current !== requestToken) {
        return;
      }
      if (selectedThreadIdRef.current !== threadId) {
        return;
      }
      if (selectedSessionIdRef.current !== sessionId) {
        return;
      }
      void hydrateSessionSnapshot(threadId, sessionId, {
        forceFreshReadySnapshot: true,
        retryDelaysMs: STATEFUL_TERMINAL_REFRESH_RETRY_DELAYS_MS
      });
    }, STATEFUL_TERMINAL_RESYNC_DEBOUNCE_MS);
  }, [
    hydrateSessionSnapshot,
    isSelectedThreadStarting,
    selectedThread,
    selectedSessionId,
    selectedTerminalFollowPaused,
    selectedTerminalLooksStateful
  ]);

  const bumpSessionStartRequestId = useCallback((threadId: string) => {
    const next = (sessionStartRequestIdByThreadRef.current[threadId] ?? 0) + 1;
    sessionStartRequestIdByThreadRef.current[threadId] = next;
    return next;
  }, []);

  const invalidatePendingSessionStart = useCallback(
    (threadId: string) => {
      bumpSessionStartRequestId(threadId);
      delete startingSessionByThreadRef.current[threadId];
      delete pendingInputByThreadRef.current[threadId];
      delete pendingSkillClearByThreadRef.current[threadId];
      setStartingByThread((current) => removeThreadFlag(current, threadId));
    },
    [bumpSessionStartRequestId]
  );

  const pruneIgnoredSshAuthStatusSessions = useCallback((nowMs: number, force = false) => {
    if (
      !force &&
      nowMs - ignoredSshAuthStatusSessionLastPrunedAtMsRef.current < IGNORED_SSH_AUTH_STATUS_SESSION_PRUNE_INTERVAL_MS
    ) {
      return;
    }
    pruneIgnoredSshAuthStatusSessionsInPlace(ignoredSshAuthStatusSessionIdsRef.current, nowMs);
    ignoredSshAuthStatusSessionLastPrunedAtMsRef.current = nowMs;
  }, []);

  const ignoreSshAuthStatusSession = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) {
      return;
    }
    const nowMs = Date.now();
    ignoredSshAuthStatusSessionIdsRef.current[sessionId] = nowMs;
    pruneIgnoredSshAuthStatusSessions(nowMs, true);
  }, [pruneIgnoredSshAuthStatusSessions]);

  const isIgnoredSshAuthStatusSession = useCallback((sessionId: string | null | undefined): boolean => {
    if (!sessionId) {
      return false;
    }
    const nowMs = Date.now();
    const ignoredAtMs = ignoredSshAuthStatusSessionIdsRef.current[sessionId];
    if (!Number.isFinite(ignoredAtMs) || ignoredAtMs <= 0) {
      pruneIgnoredSshAuthStatusSessions(nowMs, false);
      return false;
    }
    if (nowMs - ignoredAtMs > IGNORED_SSH_AUTH_STATUS_SESSION_TTL_MS) {
      delete ignoredSshAuthStatusSessionIdsRef.current[sessionId];
      return false;
    }
    pruneIgnoredSshAuthStatusSessions(nowMs, false);
    return true;
  }, [pruneIgnoredSshAuthStatusSessions]);

  const stagePendingSshStartupAuthStatus = useCallback((event: TerminalSshAuthStatusEvent) => {
    pendingSshStartupAuthStatusBySessionIdRef.current = {
      ...pendingSshStartupAuthStatusBySessionIdRef.current,
      [event.sessionId]: event
    };
  }, []);

  const takePendingSshStartupAuthStatus = useCallback(
    (sessionId: string | null | undefined): TerminalSshAuthStatusEvent | null => {
      if (!sessionId) {
        return null;
      }
      const event = pendingSshStartupAuthStatusBySessionIdRef.current[sessionId] ?? null;
      if (!event) {
        return null;
      }
      pendingSshStartupAuthStatusBySessionIdRef.current = removeRecordEntry(
        pendingSshStartupAuthStatusBySessionIdRef.current,
        sessionId
      );
      return event;
    },
    []
  );

  const applyThreadSshStartupBlock = useCallback(
    (threadId: string, event: TerminalSshAuthStatusEvent) => {
      setSshStartupBlockModal({
        sessionId: event.sessionId,
        workspaceId: event.workspaceId,
        threadId,
        reason: event.reason
      });
      setSshStartupBlockedByThread((current) =>
        current[threadId] === event.reason ? current : { ...current, [threadId]: event.reason }
      );
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));
    },
    []
  );

  const applyWorkspaceShellSshStartupBlock = useCallback((event: TerminalSshAuthStatusEvent) => {
    setSshStartupBlockModal({
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      threadId: null,
      reason: event.reason
    });
    setSshStartupBlockedShellByWorkspace((current) =>
      current[event.workspaceId] === event.reason
        ? current
        : { ...current, [event.workspaceId]: event.reason }
    );
    setShellTerminalStarting(false);
  }, []);

  const ensureSessionForThread = useCallback(
    async (thread: ThreadMetadata): Promise<string> => {
      if (deletedThreadIdsRef.current[thread.id]) {
        return '';
      }
      if (sshStartupBlockedByThreadRef.current[thread.id]) {
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        setReadyByThread((current) => removeThreadFlag(current, thread.id));
        return '';
      }
      if (
        !allowFreshStartAfterForkFailureByThreadRef.current[thread.id] &&
        isThreadMissingClaimedForkSession(thread)
      ) {
        setForkResolutionFailureBlockedByThread((current) =>
          current[thread.id] ? current : { ...current, [thread.id]: true }
        );
        setForkResolutionFailureModal((current) =>
          current?.threadId === thread.id
            ? current
            : {
                threadId: thread.id,
                workspaceId: thread.workspaceId
              }
        );
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        setReadyByThread((current) => removeThreadFlag(current, thread.id));
        return '';
      }
      if (
        isThreadAwaitingConsumedForkResolution(thread)
      ) {
        setStartingByThread((current) => removeThreadFlag(current, thread.id));
        setReadyByThread((current) => removeThreadFlag(current, thread.id));
        return '';
      }

      const existing = activeRunsByThreadRef.current[thread.id]?.sessionId ?? null;
      if (existing) {
        const existingStream = terminalStreamsByThreadRef.current[thread.id];
        const streamMatchesSession = existingStream?.sessionId === existing;
        const pendingHydration = streamMatchesSession && existingStream?.phase === 'hydrating';
        const sessionMeta = sessionMetaBySessionIdRef.current[existing];
        void bootstrapThreadRuntimeCwdFromClaudeSession(thread.id, existing);
        const requiresReadySignal = requiresExplicitSshReadySignal(sessionMeta?.workspaceKind);
        if (!runLifecycleByThreadRef.current[thread.id]) {
          runLifecycleByThreadRef.current[thread.id] = createRunLifecycleState();
        }
        if (
          (!requiresReadySignal && (!pendingHydration || hasCachedTerminalLog(thread.id))) ||
          (requiresReadySignal && readyByThreadRef.current[thread.id])
        ) {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
        }
        if (streamMatchesSession && existingStream?.phase === 'ready' && !requiresReadySignal) {
          runLifecycleByThreadRef.current[thread.id] = markRunReady(runLifecycleByThreadRef.current[thread.id]);
          setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
        } else {
          if (!streamMatchesSession) {
            updateThreadTerminalStream(thread.id, (current) => bindTerminalSessionStream(current, existing));
          }
          if (!requiresReadySignal) {
            setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
          }
          if (!pendingHydration) {
            void hydrateSessionSnapshot(thread.id, existing);
          }
        }
        await flushPendingThreadInput(thread.id, existing);
        return existing;
      }

      const inFlight = startingSessionByThreadRef.current[thread.id];
      if (inFlight) {
        return inFlight.promise;
      }

      const workspace = workspaces.find((item) => item.id === thread.workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found for thread.');
      }
      const requestId = bumpSessionStartRequestId(thread.id);
      setStartingByThread((current) => ({
        ...current,
        [thread.id]: true
      }));
      setReadyByThread((current) => removeThreadFlag(current, thread.id));

      const startPromise = (async () => {
        await waitForTerminalDataListenerReady();
        const initialThreadCwd = await resolveInitialThreadCwd(thread, workspace);
        if ((sessionStartRequestIdByThreadRef.current[thread.id] ?? 0) !== requestId) {
          return '';
        }
        const response = await api.terminalStartSession({
          workspacePath: workspace.path,
          initialCwd: initialThreadCwd,
          fullAccessFlag: thread.fullAccess,
          threadId: thread.id
        });

        const sessionId = response.sessionId;
        const discardStartedSession = async () => {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          takePendingSshStartupAuthStatus(sessionId);
          ignoreSshAuthStatusSession(sessionId);
          try {
            await api.terminalKill(sessionId);
          } catch {
            // best effort
          }
          return '';
        };

        if ((sessionStartRequestIdByThreadRef.current[thread.id] ?? 0) !== requestId) {
          return discardStartedSession();
        }

        if (deletedThreadIdsRef.current[thread.id]) {
          return discardStartedSession();
        }

        const threadStillExists = (threadsByWorkspaceRef.current[thread.workspaceId] ?? []).some(
          (item) => item.id === thread.id
        );
        if (!threadStillExists) {
          return discardStartedSession();
        }

        const pendingSshStartupAuthStatus = takePendingSshStartupAuthStatus(sessionId);
        if (pendingSshStartupAuthStatus) {
          applyThreadSshStartupBlock(thread.id, pendingSshStartupAuthStatus);
          ignoreSshAuthStatusSession(sessionId);
          try {
            await api.terminalKill(sessionId);
          } catch {
            // best effort
          }
          return '';
        }

        if (isIgnoredSshAuthStatusSession(sessionId)) {
          return discardStartedSession();
        }
        applyThreadUpdate(response.thread);

        const startedAt = new Date().toISOString();
        const sessionCurrentCwd = initialThreadCwd;
        const claudeSessionId =
          response.thread.claudeSessionId?.trim() ||
          response.resumeSessionId?.trim() ||
          thread.claudeSessionId?.trim() ||
          null;
        sessionMetaBySessionIdRef.current[sessionId] = {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          workspaceKind: workspace.kind,
          claudeSessionId,
          currentCwd: sessionCurrentCwd,
          mode: response.sessionMode,
          turnCompletionMode: response.turnCompletionMode ?? 'idle',
          startedAtMs: Date.now()
        };
        rememberThreadRuntimeCwd(thread.id, sessionCurrentCwd);
        bindSession(thread.id, sessionId, startedAt);
        if ((response.turnCompletionMode ?? 'idle') === 'jsonl' && workspace.kind === 'local') {
          resetThreadJsonlCompletionAttentionForSession(thread.id, claudeSessionId);
          if (claudeSessionId) {
            void reconcileThreadJsonlCompletionAttention(thread.id, workspace.path, claudeSessionId);
          }
        }
        setHasInteractedByThread((current) => removeThreadFlag(current, thread.id));

        scheduleTerminalResize(sessionId, terminalSize.cols, terminalSize.rows, true);
        await flushPendingThreadInput(thread.id, sessionId);
        void hydrateSessionSnapshot(thread.id, sessionId);
        return sessionId;
      })()
        .catch((error) => {
          sessionFailCountByThreadRef.current[thread.id] =
            (sessionFailCountByThreadRef.current[thread.id] ?? 0) + 1;
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
          throw error;
        })
        .finally(() => {
          if (startingSessionByThreadRef.current[thread.id]?.requestId === requestId) {
            delete startingSessionByThreadRef.current[thread.id];
          }
        });

      startingSessionByThreadRef.current[thread.id] = { requestId, promise: startPromise };
      return startPromise;
    },
    [
      applyThreadUpdate,
      bindSession,
      bootstrapThreadRuntimeCwdFromClaudeSession,
      bumpSessionStartRequestId,
      flushPendingThreadInput,
      hasCachedTerminalLog,
      hydrateSessionSnapshot,
      resolveInitialThreadCwd,
      rememberThreadRuntimeCwd,
      scheduleTerminalResize,
      applyThreadSshStartupBlock,
      isIgnoredSshAuthStatusSession,
      ignoreSshAuthStatusSession,
      reconcileThreadJsonlCompletionAttention,
      resetThreadJsonlCompletionAttentionForSession,
      terminalSize.cols,
      terminalSize.rows,
      takePendingSshStartupAuthStatus,
      updateThreadTerminalStream,
      waitForTerminalDataListenerReady,
      workspaces
    ]
  );

  const addAttachmentPathsForSelectedThread = useCallback(
    (rawPaths: string[]) => {
      if (!selectedThread) {
        return 0;
      }
      return addAttachmentDraftPaths(selectedThread.id, rawPaths);
    },
    [addAttachmentDraftPaths, selectedThread]
  );

  const queueAttachmentPathsForSelectedThread = useCallback(
    (rawPaths: string[], showMissingThreadToast = true) => {
      if (!selectedThread) {
        if (showMissingThreadToast) {
          pushToast('Select a thread before adding attachments.', 'error');
        }
        return 0;
      }
      const added = addAttachmentPathsForSelectedThread(rawPaths);
      if (added > 0) {
        pushToast(`Queued ${added} attachment${added === 1 ? '' : 's'} for the next prompt.`, 'info');
      }
      return added;
    },
    [addAttachmentPathsForSelectedThread, pushToast, selectedThread]
  );

  const stopShellSessionForWorkspace = useCallback(
    async (
      workspaceId: string,
      options?: {
        closeDrawer?: boolean;
        clearContent?: boolean;
      }
    ) => {
      if (!workspaceId) {
        return;
      }

      const ownsVisibleShellWorkspace = shellTerminalWorkspaceIdRef.current === workspaceId;
      const ownsPendingShellStart = pendingShellSessionStartRef.current?.workspaceId === workspaceId;
      const shouldCloseDrawer = Boolean(options?.closeDrawer) && ownsVisibleShellWorkspace;
      invalidatePendingShellSessionStart(workspaceId);

      const sessionId = ownsVisibleShellWorkspace ? shellTerminalSessionIdRef.current : null;

      if (sessionId) {
        ignoreSshAuthStatusSession(sessionId);
        try {
          await withTimeout(api.terminalKill(sessionId), 900);
        } catch {
          // best effort
        }
      }

      if (ownsVisibleShellWorkspace || sessionId) {
        setShellSessionBinding(null, null);
      }

      if (ownsVisibleShellWorkspace || ownsPendingShellStart) {
        setShellTerminalStarting(false);
      }

      if (ownsVisibleShellWorkspace) {
        setFocusedTerminalKind((current) => (current === 'shell' ? null : current));
      }

      if ((options?.clearContent ?? true) && ownsVisibleShellWorkspace) {
        setShellTerminalStream((current) =>
          presentTerminalSnapshot(
            current,
            {
              text: '',
              startPosition: 0,
              endPosition: 0,
              truncated: false
            },
            TERMINAL_LOG_BUFFER_CHARS
          )
        );
      }

      if (shouldCloseDrawer) {
        setShellDrawerOpen(false);
      }
    },
    [ignoreSshAuthStatusSession, invalidatePendingShellSessionStart, setShellSessionBinding]
  );

  const startWorkspaceShellSession = useCallback(
    async (workspace: Workspace): Promise<string | null> => {
      if (workspace.kind === 'ssh' && sshStartupBlockedShellByWorkspaceRef.current[workspace.id]) {
        setShellTerminalStarting(false);
        return null;
      }
      const requestId = bumpShellSessionStartRequestId();
      pendingShellSessionStartRef.current = {
        requestId,
        workspaceId: workspace.id
      };
      const isCurrentRequest = () =>
        pendingShellSessionStartRef.current?.requestId === requestId &&
        pendingShellSessionStartRef.current?.workspaceId === workspace.id;

      const existingSessionId = shellTerminalSessionIdRef.current;
      const existingWorkspaceId = shellTerminalWorkspaceIdRef.current;
      if (existingSessionId && existingWorkspaceId === workspace.id) {
        const stillAlive =
          (await api
          .terminalResize(existingSessionId, shellTerminalSize.cols, shellTerminalSize.rows)
          .catch(() => false)) === true;
        if (!isCurrentRequest()) {
          return null;
        }
        if (stillAlive) {
          pendingShellSessionStartRef.current = null;
          setShellTerminalStarting(false);
          return existingSessionId;
        }
        setShellSessionBinding(null, workspace.id);
      }

      if (existingSessionId && existingWorkspaceId && existingWorkspaceId !== workspace.id) {
        ignoreSshAuthStatusSession(existingSessionId);
        try {
          await withTimeout(api.terminalKill(existingSessionId), 900);
        } catch {
          // best effort
        }
        if (shellTerminalSessionIdRef.current === existingSessionId) {
          setShellSessionBinding(null, null);
        }
      }

      setShellTerminalStarting(true);
      if (existingWorkspaceId !== workspace.id) {
        setShellTerminalStream((current) =>
          presentTerminalSnapshot(
            current,
            {
              text: '',
              startPosition: 0,
              endPosition: 0,
              truncated: false
            },
            TERMINAL_LOG_BUFFER_CHARS
          )
        );
      }
      setShellSessionBinding(null, workspace.id);

      try {
        await waitForTerminalDataListenerReady();
        const response = await api.workspaceShellStartSession({
          workspacePath: workspace.path,
          initialCwd: workspace.kind === 'local' ? workspace.path : null
        });

        if (!isCurrentRequest()) {
          if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
            console.debug('[workspace-shell] dropped stale session start', {
              workspaceId: workspace.id,
              sessionId: response.sessionId
            });
          }
          takePendingSshStartupAuthStatus(response.sessionId);
          ignoreSshAuthStatusSession(response.sessionId);
          try {
            await withTimeout(api.terminalKill(response.sessionId), 900);
          } catch {
            // best effort
          }
          return null;
        }

        const pendingSshStartupAuthStatus = takePendingSshStartupAuthStatus(response.sessionId);
        if (pendingSshStartupAuthStatus) {
          pendingShellSessionStartRef.current = null;
          applyWorkspaceShellSshStartupBlock(pendingSshStartupAuthStatus);
          ignoreSshAuthStatusSession(response.sessionId);
          try {
            await withTimeout(api.terminalKill(response.sessionId), 900);
          } catch {
            // best effort
          }
          return null;
        }

        if (isIgnoredSshAuthStatusSession(response.sessionId)) {
          pendingShellSessionStartRef.current = null;
          setShellTerminalStarting(false);
          try {
            await withTimeout(api.terminalKill(response.sessionId), 900);
          } catch {
            // best effort
          }
          return null;
        }

        pendingShellSessionStartRef.current = null;
        setShellSessionBinding(response.sessionId, workspace.id);
        setShellTerminalStarting(false);
        void api.terminalResize(response.sessionId, shellTerminalSize.cols, shellTerminalSize.rows);
        return response.sessionId;
      } catch (error) {
        if (!isCurrentRequest()) {
          return null;
        }
        pendingShellSessionStartRef.current = null;
        setShellTerminalStarting(false);
        if (shellTerminalWorkspaceIdRef.current === workspace.id && shellTerminalSessionIdRef.current === null) {
          setShellSessionBinding(null, workspace.id);
        }
        throw error;
      }
    },
    [
      bumpShellSessionStartRequestId,
      applyWorkspaceShellSshStartupBlock,
      isIgnoredSshAuthStatusSession,
      ignoreSshAuthStatusSession,
      setShellSessionBinding,
      shellTerminalSize.cols,
      shellTerminalSize.rows,
      takePendingSshStartupAuthStatus,
      waitForTerminalDataListenerReady
    ]
  );

  const closeWorkspaceShellDrawer = useCallback(() => {
    invalidatePendingShellSessionStart(shellTerminalWorkspaceIdRef.current);
    setShellDrawerOpen(false);
    setFocusedTerminalKind((current) => (current === 'shell' ? null : current));
  }, [invalidatePendingShellSessionStart]);

  const toggleWorkspaceShellDrawer = useCallback(() => {
    if (!selectedWorkspace) {
      return;
    }

    if (shellDrawerOpen && shellTerminalWorkspaceId === selectedWorkspace.id) {
      closeWorkspaceShellDrawer();
      return;
    }

    setShellDrawerOpen(true);
    setShellTerminalFocusRequestId((current) => current + 1);
    if (selectedWorkspace.kind === 'ssh' && selectedShellSshStartupBlockReason) {
      setShellTerminalStarting(false);
      return;
    }
    void startWorkspaceShellSession(selectedWorkspace).catch((error) => {
      pushToast(`Failed to start workspace terminal: ${String(error)}`, 'error');
    });
  }, [
    closeWorkspaceShellDrawer,
    pushToast,
    selectedShellSshStartupBlockReason,
    selectedWorkspace,
    shellDrawerOpen,
    shellTerminalWorkspaceId,
    startWorkspaceShellSession
  ]);

  useEffect(() => {
    if (!shellDrawerOpen) {
      return;
    }
    if (!selectedWorkspace) {
      invalidatePendingShellSessionStart();
      setShellDrawerOpen(false);
      setShellTerminalStarting(false);
      return;
    }
    if (pendingShellSessionStartRef.current?.workspaceId === selectedWorkspace.id) {
      return;
    }
    if (shellTerminalWorkspaceId === selectedWorkspace.id && shellTerminalSessionId) {
      return;
    }
    if (selectedWorkspace.kind === 'ssh' && selectedShellSshStartupBlockReason) {
      setShellTerminalStarting(false);
      return;
    }
    void startWorkspaceShellSession(selectedWorkspace).catch((error) => {
      pushToast(`Failed to start workspace terminal: ${String(error)}`, 'error');
    });
  }, [
    invalidatePendingShellSessionStart,
    pushToast,
    selectedShellSshStartupBlockReason,
    selectedWorkspace,
    shellDrawerOpen,
    shellTerminalSessionId,
    shellTerminalWorkspaceId,
    startWorkspaceShellSession
  ]);

  const attemptAutoRecoverSelectedThread = useCallback(async () => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const threadId = selectedThreadIdRef.current;
    if (!workspaceId || !threadId) {
      return;
    }
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !isRemoteWorkspaceKind(workspace.kind)) {
      return;
    }

    if (autoRecoverInFlightRef.current) {
      return;
    }
    const now = Date.now();
    if (now - lastAutoRecoverAttemptAtRef.current < AUTO_RECOVER_RETRY_COOLDOWN_MS) {
      return;
    }
    lastAutoRecoverAttemptAtRef.current = now;

    const thread = (threadsByWorkspaceRef.current[workspaceId] ?? []).find((item) => item.id === threadId);
    if (!thread || deletedThreadIdsRef.current[thread.id] || startingSessionByThreadRef.current[thread.id]) {
      return;
    }
    if ((sessionFailCountByThreadRef.current[thread.id] ?? 0) >= 3) {
      return;
    }

    autoRecoverInFlightRef.current = true;
    let sessionId = activeRunsByThreadRef.current[thread.id]?.sessionId ?? null;
    try {
      if (!sessionId) {
        if (selectedThreadIdRef.current === thread.id) {
          await ensureSessionForThread(thread);
        }
        return;
      }

      const hasCachedLog = hasCachedTerminalLog(thread.id);
      const snapshot = await withTimeout(api.terminalReadOutput(sessionId), AUTO_RECOVER_SESSION_TIMEOUT_MS);
      if (snapshot) {
        const requiresReadySignal = requiresExplicitSshReadySignal(workspace.kind);
        if (snapshot.text.length > 0 && !hasCachedLog) {
          const presentedSnapshot = normalizeThreadTerminalSnapshot(thread.id, snapshot);
          updateThreadTerminalStream(thread.id, (current) =>
            current.sessionId === sessionId && current.phase === 'hydrating'
              ? hydrateTerminalSessionStream(current, sessionId, presentedSnapshot, TERMINAL_LOG_BUFFER_CHARS)
              : presentTerminalSnapshot(current, presentedSnapshot, TERMINAL_LOG_BUFFER_CHARS)
          );
        }
        if (!requiresReadySignal || readyByThreadRef.current[thread.id]) {
          setStartingByThread((current) => removeThreadFlag(current, thread.id));
        }
        if (!requiresReadySignal && (snapshot.text.length > 0 || hasCachedLog)) {
          setReadyByThread((current) => (current[thread.id] ? current : { ...current, [thread.id]: true }));
        }
        if (!hasCachedLog || snapshot.text.length === 0) {
          void hydrateSessionSnapshot(thread.id, sessionId);
        }
      }
      return;
    } catch (error) {
      if (!sessionId || !isTerminalSessionUnavailableError(error)) {
        return;
      }

      clearThreadWorkingStopTimer(thread.id);
      finishSessionBinding(sessionId);
      clearTerminalSessionTracking(sessionId);
      setStartingByThread((current) => removeThreadFlag(current, thread.id));
      setReadyByThread((current) => removeThreadFlag(current, thread.id));

      if (selectedThreadIdRef.current !== thread.id) {
        return;
      }

      try {
        await ensureSessionForThread(thread);
      } catch (startError) {
        pushToast(`Failed to recover terminal session: ${String(startError)}`, 'error');
      }
    } finally {
      autoRecoverInFlightRef.current = false;
    }
  }, [
    clearTerminalSessionTracking,
    clearThreadWorkingStopTimer,
    ensureSessionForThread,
    finishSessionBinding,
    hasCachedTerminalLog,
    hydrateSessionSnapshot,
    normalizeThreadTerminalSnapshot,
    pushToast,
    updateThreadTerminalStream,
    workspaces
  ]);

  const pickAttachmentFiles = useCallback(async () => {
    if (!selectedThread) {
      pushToast('Select a thread before adding attachments.', 'error');
      return;
    }

    try {
      const picked = await open({
        title: 'Add attachments',
        directory: false,
        multiple: true,
        defaultPath: selectedWorkspace?.path
      });

      if (!picked) {
        return;
      }

      queueAttachmentPathsForSelectedThread((Array.isArray(picked) ? picked : [picked]).filter(Boolean), false);
    } catch (error) {
      pushToast(`Attach failed: ${String(error)}`, 'error');
    }
  }, [pushToast, queueAttachmentPathsForSelectedThread, selectedThread, selectedWorkspace?.path]);

  const addAttachmentPathsFromDrop = useCallback(
    (paths: string[]) => {
      return queueAttachmentPathsForSelectedThread(paths) > 0;
    },
    [queueAttachmentPathsForSelectedThread]
  );

  const removeSelectedThreadAttachmentPath = useCallback(
    (path: string) => {
      if (!selectedThread) {
        return;
      }
      removeAttachmentDraftPath(selectedThread.id, path);
    },
    [removeAttachmentDraftPath, selectedThread]
  );

  const clearSelectedThreadAttachmentDraft = useCallback(() => {
    if (!selectedThread) {
      return;
    }
    clearAttachmentDraftForThread(selectedThread.id);
  }, [clearAttachmentDraftForThread, selectedThread]);

  const ensureLocalWorkspaceByPath = useCallback(
    async (path: string, options?: { select?: boolean }) => {
      const normalized = path.trim();
      if (!normalized) {
        throw new Error('Please enter a workspace path.');
      }

      const existingWorkspace = workspaces.find(
        (workspace) => workspace.kind === 'local' && workspace.path === normalized
      );
      const workspace = existingWorkspace ?? (await api.addWorkspace(normalized));
      setWorkspaces((current) => {
        if (current.some((item) => item.id === workspace.id)) {
          return current;
        }
        return [...current, workspace];
      });
      if (options?.select !== false) {
        setSelectedWorkspace(workspace.id);
        setSelectedThread(undefined);
      }
      await refreshThreadsForWorkspace(workspace.id);
      return workspace;
    },
    [refreshThreadsForWorkspace, setSelectedThread, setSelectedWorkspace, workspaces]
  );

  const addWorkspaceByPath = useCallback(
    async (path: string) => {
      return ensureLocalWorkspaceByPath(path, { select: true });
    },
    [ensureLocalWorkspaceByPath]
  );

  const addRdevWorkspaceByCommand = useCallback(
    async (rdevSshCommand: string, displayName: string) => {
      const command = rdevSshCommand.trim();
      if (!command) {
        throw new Error('Please enter an rdev ssh command.');
      }

      const workspace = await api.addRdevWorkspace(command, displayName.trim() || null);
      setWorkspaces((current) => {
        if (current.some((item) => item.id === workspace.id)) {
          return current;
        }
        return [...current, workspace];
      });
      setSelectedWorkspace(workspace.id);
      setSelectedThread(undefined);
      await refreshThreadsForWorkspace(workspace.id);
      return workspace;
    },
    [refreshThreadsForWorkspace, setSelectedThread, setSelectedWorkspace]
  );

  const addSshWorkspaceByCommand = useCallback(
    async (sshCommand: string, displayName: string, remotePath: string) => {
      const command = sshCommand.trim();
      if (!command) {
        throw new Error('Please enter an ssh command.');
      }

      const workspace = await api.addSshWorkspace(
        command,
        displayName.trim() || null,
        remotePath.trim() || null
      );
      setWorkspaces((current) => {
        if (current.some((item) => item.id === workspace.id)) {
          return current;
        }
        return [...current, workspace];
      });
      setSelectedWorkspace(workspace.id);
      setSelectedThread(undefined);
      await refreshThreadsForWorkspace(workspace.id);
      return workspace;
    },
    [refreshThreadsForWorkspace, setSelectedThread, setSelectedWorkspace]
  );

  const openWorkspacePicker = useCallback(() => {
    setAddWorkspaceMode('local');
    setAddWorkspacePath('');
    setAddWorkspaceRdevCommand('');
    setAddWorkspaceSshCommand('');
    setAddWorkspaceSshRemotePath('');
    setAddWorkspaceDisplayName('');
    setAddWorkspaceError(null);
    setAddWorkspaceOpen(true);
  }, []);

  const pickWorkspaceDirectory = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select workspace folder'
      });

      if (!selected) {
        return;
      }

      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) {
        return;
      }

      setAddWorkspacePath(path);
    } catch (error) {
      const message = `Add workspace failed: ${String(error)}`;
      pushToast(message, 'error');
      setAddWorkspaceError(message);
      setAddWorkspaceOpen(true);
    }
  }, [pushToast]);

  const confirmManualWorkspace = useCallback(
    async (path: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('local');
      setAddWorkspacePath(path);
      setAddWorkspaceRdevCommand('');
      setAddWorkspaceSshCommand('');
      setAddWorkspaceSshRemotePath('');
      try {
        await addWorkspaceByPath(path);
        setAddWorkspaceOpen(false);
        setAddWorkspacePath('');
        setAddWorkspaceRdevCommand('');
        setAddWorkspaceSshCommand('');
        setAddWorkspaceSshRemotePath('');
        setAddWorkspaceError(null);
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addWorkspaceByPath, pushToast]
  );

  const confirmRdevWorkspace = useCallback(
    async (rdevSshCommand: string, displayName: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('rdev');
      setAddWorkspaceRdevCommand(rdevSshCommand);
      setAddWorkspaceSshCommand('');
      setAddWorkspaceSshRemotePath('');
      setAddWorkspaceDisplayName(displayName);
      try {
        await addRdevWorkspaceByCommand(rdevSshCommand, displayName);
        setAddWorkspaceOpen(false);
        setAddWorkspaceRdevCommand('');
        setAddWorkspaceSshCommand('');
        setAddWorkspaceSshRemotePath('');
        setAddWorkspaceDisplayName('');
        setAddWorkspaceError(null);
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addRdevWorkspaceByCommand, pushToast]
  );

  const confirmSshWorkspace = useCallback(
    async (sshCommand: string, displayName: string, remotePath: string) => {
      setAddingWorkspace(true);
      setAddWorkspaceError(null);
      setAddWorkspaceMode('ssh');
      setAddWorkspaceSshCommand(sshCommand);
      setAddWorkspaceSshRemotePath(remotePath);
      setAddWorkspaceDisplayName(displayName);
      try {
        await addSshWorkspaceByCommand(sshCommand, displayName, remotePath);
        setAddWorkspaceOpen(false);
        setAddWorkspaceSshCommand('');
        setAddWorkspaceSshRemotePath('');
        setAddWorkspaceDisplayName('');
        setAddWorkspaceError(null);
      } catch (error) {
        const message = String(error);
        setAddWorkspaceError(message);
        pushToast(message, 'error');
      } finally {
        setAddingWorkspace(false);
      }
    },
    [addSshWorkspaceByCommand, pushToast]
  );

  const onNewThreadInWorkspace = useCallback(
    async (workspaceId: string, options?: CreateThreadOptions) => {
      if (creatingThreadByWorkspaceRef.current[workspaceId]) {
        return;
      }

      const resolvedOptions =
        typeof options?.fullAccess === 'boolean'
          ? options
          : settings.defaultNewThreadFullAccess
            ? { fullAccess: true }
            : undefined;

      setWorkspaceCreatingThread(workspaceId, true);

      try {
        const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
        if (workspace?.kind === 'local' && workspace.gitPullOnMasterForNewThreads) {
          try {
            const pullResult = await api.gitPullMasterForNewThread(workspace.path);
            if (pullResult.outcome === 'pulled') {
              pushToast(pullResult.message, 'info');
              if (selectedWorkspaceIdRef.current === workspaceId) {
                await refreshGitInfo();
              }
            } else {
              pushToast(pullResult.message, 'error');
            }
          } catch (error) {
            pushToast(`Git pull pre-step failed: ${String(error)}`, 'error');
          }
        }

        if (selectedWorkspaceIdRef.current !== workspaceId) {
          setSelectedWorkspace(workspaceId);
        }
        const thread = await createThread(workspaceId, resolvedOptions);
        markThreadUserInput(workspaceId, thread.id);
        delete deletedThreadIdsRef.current[thread.id];
        primeRemoteThreadStartupOnSelection(thread, workspace ?? null);
        setSelectedThread(thread.id);
        setTerminalFocusRequestId((current) => current + 1);
        await refreshThreadsForWorkspace(workspaceId);
      } finally {
        setWorkspaceCreatingThread(workspaceId, false);
      }
    },
    [
      createThread,
      markThreadUserInput,
      primeRemoteThreadStartupOnSelection,
      pushToast,
      refreshGitInfo,
      refreshThreadsForWorkspace,
      settings.defaultNewThreadFullAccess,
      setWorkspaceCreatingThread,
      setSelectedThread,
      setSelectedWorkspace,
      workspaces
    ]
  );

  const onSetWorkspaceGitPullOnMasterForNewThreads = useCallback(
    async (workspaceId: string, enabled: boolean) => {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? {
                ...workspace,
                gitPullOnMasterForNewThreads: enabled,
                updatedAt: new Date().toISOString()
              }
            : workspace
        )
      );
      try {
        const updatedWorkspace = await api.setWorkspaceGitPullOnMasterForNewThreads(workspaceId, enabled);
        setWorkspaces((current) =>
          current.map((workspace) => (workspace.id === updatedWorkspace.id ? updatedWorkspace : workspace))
        );
      } catch (error) {
        pushToast(`Workspace setting update failed: ${String(error)}`, 'error');
        await refreshWorkspaces();
      }
    },
    [pushToast, refreshWorkspaces]
  );

  const onReorderWorkspaces = useCallback(
    async (workspaceIds: string[]) => {
      setWorkspaces((current) => reorderWorkspacesByIds(current, workspaceIds));
      try {
        const reordered = await api.setWorkspaceOrder(workspaceIds);
        setWorkspaces(reordered);
      } catch (error) {
        pushToast(`Workspace reorder failed: ${String(error)}`, 'error');
        await refreshWorkspaces();
      }
    },
    [pushToast, refreshWorkspaces]
  );

  const onRenameThread = useCallback(
    async (workspaceId: string, threadId: string, title: string) => {
      try {
        await renameThread(workspaceId, threadId, title);
        await refreshThreadsForWorkspace(workspaceId);
      } catch (error) {
        pushToast(`Rename failed: ${String(error)}`, 'error');
      }
    },
    [pushToast, refreshThreadsForWorkspace, renameThread]
  );

  const onDeleteThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      deletedThreadIdsRef.current[threadId] = true;
      invalidatePendingSessionStart(threadId);
      clearThreadWorkingStopTimer(threadId);
      stopThreadWorking(threadId);
      const existingSessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? runStore.sessionForThread(threadId);
      if (existingSessionId) {
        try {
          await withTimeout(api.terminalSendSignal(existingSessionId, 'SIGINT'), 700);
        } catch {
          // best effort
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), 80);
        });
        try {
          await withTimeout(api.terminalKill(existingSessionId), 900);
        } catch {
          // best effort
        }
        finishSessionBinding(existingSessionId);
        clearTerminalSessionTracking(existingSessionId);
      }

      try {
        await deleteThread(workspaceId, threadId);
      } catch (error) {
        delete deletedThreadIdsRef.current[threadId];
        pushToast(`Delete failed: ${String(error)}`, 'error');
        return;
      }
      const deletedThread = (threadsByWorkspaceRef.current[workspaceId] ?? []).find((thread) => thread.id === threadId);
      if (deletedThread) {
        applyThreadUpdate({
          ...deletedThread,
          isArchived: true
        });
      }
      for (const [sessionId, meta] of Object.entries(sessionMetaBySessionIdRef.current)) {
        if (meta.threadId !== threadId) {
          continue;
        }
        clearTerminalSessionTracking(sessionId);
      }
      for (const [sessionId, pendingEvent] of Object.entries(pendingSshStartupAuthStatusBySessionIdRef.current)) {
        if (pendingEvent.threadId === threadId) {
          delete pendingSshStartupAuthStatusBySessionIdRef.current[sessionId];
        }
      }
      for (const [sessionId, mappedThreadId] of Object.entries(threadIdBySessionIdRef.current)) {
        if (mappedThreadId === threadId) {
          delete threadIdBySessionIdRef.current[sessionId];
        }
      }
      delete startingSessionByThreadRef.current[threadId];
      delete pendingInputByThreadRef.current[threadId];
      delete pendingSkillClearByThreadRef.current[threadId];
      delete inputBufferByThreadRef.current[threadId];
      delete inputControlCarryByThreadRef.current[threadId];
      delete forkResolutionByThreadRef.current[threadId];
      delete forkResolutionTimeoutNotifiedByThreadRef.current[threadId];
      delete allowFreshStartAfterForkFailureByThreadRef.current[threadId];
      delete threadTitleInitializedRef.current[threadId];
      delete hiddenInjectedPromptsByThreadRef.current[threadId];
      delete outputControlCarryByThreadRef.current[threadId];
      delete sessionStartRequestIdByThreadRef.current[threadId];
      delete threadWorkspaceKindByThreadIdRef.current[threadId];
      delete jsonlCompletionSeededSessionIdByThreadRef.current[threadId];
      delete draftAttachmentsByThreadRef.current[threadId];
      deleteThreadAttentionState(threadId);
      delete lastMeaningfulOutputByThreadRef.current[threadId];
      delete lastSessionStartAtMsByThreadRef.current[threadId];
      delete lastUserInputAtMsByThreadRef.current[threadId];
      delete sessionFailCountByThreadRef.current[threadId];
      delete runLifecycleByThreadRef.current[threadId];
      setSshStartupBlockedByThread((current) => removeRecordEntry(current, threadId));
      setSshStartupBlockModal((current) =>
        current && current.threadId === threadId ? null : current
      );
      setForkResolutionFailureBlockedByThread((current) => removeRecordEntry(current, threadId));
      setForkResolutionFailureModal((current) => (current?.threadId === threadId ? null : current));
      setResumeFailureBlockedByThread((current) => removeRecordEntry(current, threadId));
      setResumeFailureModal((current) => (current?.threadId === threadId ? null : current));
      setHasInteractedByThread((current) => removeThreadFlag(current, threadId));
      clearThreadTerminalStream(threadId);
      setDraftAttachmentsByThread((current) => removeRecordEntry(current, threadId));
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));

      if (selectedThreadIdRef.current === threadId) {
        setSelectedThread(undefined);
      }

      await refreshThreadsForWorkspace(workspaceId);
    },
    [
      applyThreadUpdate,
      deleteThread,
      finishSessionBinding,
      invalidatePendingSessionStart,
      pushToast,
      refreshThreadsForWorkspace,
      runStore,
      clearTerminalSessionTracking,
      clearThreadWorkingStopTimer,
      deleteThreadAttentionState,
      stopThreadWorking,
      setSelectedThread,
      setHasInteractedByThread,
      clearThreadTerminalStream
    ]
  );

  const stopThreadSession = useCallback(
    async (threadId: string) => {
      invalidatePendingSessionStart(threadId);
      const sessionId = activeRunsByThreadRef.current[threadId]?.sessionId ?? runStore.sessionForThread(threadId);
      if (!sessionId) {
        clearThreadRuntimeCwd(threadId);
        return;
      }

      ignoreSshAuthStatusSession(sessionId);
      try {
        const snapshot = await withTimeout(api.terminalReadOutput(sessionId), 350);
        if (snapshot?.text.length) {
          presentThreadTerminalSnapshot(threadId, snapshot, sessionId);
        }
      } catch {
        // best effort
      }

      try {
        await withTimeout(api.terminalSendSignal(sessionId, 'SIGINT'), 700);
      } catch {
        // best effort
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 120);
      });
      try {
        await withTimeout(api.terminalKill(sessionId), 900);
      } catch {
        // best effort
      }
      finishSessionBinding(sessionId);
      const endedAt = new Date().toISOString();
      setThreadRunState(threadId, 'Canceled', null, endedAt);
      clearThreadWorkingStopTimer(threadId);
      stopThreadWorking(threadId);
      completeTurn(threadId, 'Canceled');
      clearTerminalSessionTracking(sessionId);
      clearThreadRuntimeCwd(threadId);
      runLifecycleByThreadRef.current[threadId] = markRunExited();
      setStartingByThread((current) => removeThreadFlag(current, threadId));
      setReadyByThread((current) => removeThreadFlag(current, threadId));
      setHasInteractedByThread((current) => removeThreadFlag(current, threadId));
    },
    [
      completeTurn,
      finishSessionBinding,
      invalidatePendingSessionStart,
      presentThreadTerminalSnapshot,
      runStore,
      setThreadRunState,
      stopThreadWorking,
      clearTerminalSessionTracking,
      clearThreadRuntimeCwd,
      clearThreadWorkingStopTimer,
      ignoreSshAuthStatusSession,
      setHasInteractedByThread,
    ]
  );

  const switchToThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      recordThreadVisibleOutput(threadId, true, Date.now(), lastTerminalLogByThreadRef.current[threadId] ?? '');
      if (selectedWorkspaceIdRef.current !== workspaceId) {
        setSelectedWorkspace(workspaceId);
      }
      const thread = (threadsByWorkspaceRef.current[workspaceId] ?? []).find((item) => item.id === threadId);
      primeRemoteThreadStartupOnSelection(thread);
      setSelectedThread(threadId);
      setTerminalFocusRequestId((current) => current + 1);
    },
    [primeRemoteThreadStartupOnSelection, recordThreadVisibleOutput, setSelectedThread, setSelectedWorkspace]
  );

  const clearResumeFailureBlock = useCallback((threadId?: string | null) => {
    if (!threadId) {
      return;
    }
    setResumeFailureBlockedByThread((current) => removeRecordEntry(current, threadId));
  }, []);

  const clearForkResolutionFailureBlock = useCallback((threadId?: string | null) => {
    if (!threadId) {
      return;
    }
    setForkResolutionFailureBlockedByThread((current) => removeRecordEntry(current, threadId));
  }, []);

  const restartThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      clearResumeFailureBlock(thread.id);
      clearForkResolutionFailureBlock(thread.id);
      sessionFailCountByThreadRef.current[thread.id] = 0;
      await stopThreadSession(thread.id);
      if (selectedWorkspaceIdRef.current !== thread.workspaceId) {
        setSelectedWorkspace(thread.workspaceId);
      }
      primeRemoteThreadStartupOnSelection(thread);
      setSelectedThread(thread.id);
      setForkResolutionFailureModal(null);
      setResumeFailureModal(null);
      void ensureSessionForThread(thread).catch((error) => {
        pushToast(String(error), 'error');
      });
    },
    [
      clearResumeFailureBlock,
      clearForkResolutionFailureBlock,
      ensureSessionForThread,
      primeRemoteThreadStartupOnSelection,
      pushToast,
      setSelectedThread,
      setSelectedWorkspace,
      stopThreadSession
    ]
  );

  const retryBlockedSshStartup = useCallback(
    async (blocked: SshStartupBlockModalState) => {
      setSshStartupBlockModal(null);

      if (blocked.threadId) {
        setSshStartupBlockedByThread((current) => removeRecordEntry(current, blocked.threadId!));
        const thread = (threadsByWorkspaceRef.current[blocked.workspaceId] ?? []).find(
          (item) => item.id === blocked.threadId
        );
        if (!thread) {
          pushToast('Unable to locate the blocked thread for retry.', 'error');
          return;
        }
        await restartThreadSession(thread);
        return;
      }

      setSshStartupBlockedShellByWorkspace((current) => removeRecordEntry(current, blocked.workspaceId));
      const workspace = workspaces.find((item) => item.id === blocked.workspaceId);
      if (!workspace) {
        pushToast('Unable to locate the blocked workspace terminal for retry.', 'error');
        return;
      }
      if (selectedWorkspaceIdRef.current !== workspace.id) {
        setSelectedWorkspace(workspace.id);
      }
      setShellDrawerOpen(true);
      setShellTerminalFocusRequestId((current) => current + 1);
      await startWorkspaceShellSession(workspace);
    },
    [pushToast, restartThreadSession, setSelectedWorkspace, startWorkspaceShellSession, workspaces]
  );

  const dismissSshStartupBlockModal = useCallback((blocked: SshStartupBlockModalState | null) => {
    if (!blocked) {
      return;
    }

    if (blocked.threadId) {
      setSshStartupBlockedByThread((current) => removeRecordEntry(current, blocked.threadId!));
      setStartingByThread((current) => removeThreadFlag(current, blocked.threadId!));
      setReadyByThread((current) => removeThreadFlag(current, blocked.threadId!));
    } else {
      setSshStartupBlockedShellByWorkspace((current) => removeRecordEntry(current, blocked.workspaceId));
      setShellTerminalStarting(false);
    }

    setSshStartupBlockModal((current) => (current?.sessionId === blocked.sessionId ? null : current));
  }, []);

  const onStartFreshThreadSession = useCallback(
    async (thread: ThreadMetadata) => {
      try {
        clearResumeFailureBlock(thread.id);
        clearForkResolutionFailureBlock(thread.id);
        allowFreshStartAfterForkFailureByThreadRef.current[thread.id] = true;
        sessionFailCountByThreadRef.current[thread.id] = 0;
        const cleared = await api.clearThreadClaudeSession(thread.workspaceId, thread.id);
        applyThreadUpdate(cleared);
        await restartThreadSession(cleared);
      } catch (error) {
        delete allowFreshStartAfterForkFailureByThreadRef.current[thread.id];
        pushToast(`Failed to start a fresh session: ${String(error)}`, 'error');
      }
    },
    [applyThreadUpdate, clearForkResolutionFailureBlock, clearResumeFailureBlock, pushToast, restartThreadSession]
  );

  const stopSessionsForWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspaceThreads = threadsByWorkspaceRef.current[workspaceId] ?? [];
      const activeThreadIds = new Set(Object.values(runStore.activeRunsByThread).map((run) => run.threadId));
      for (const thread of workspaceThreads) {
        if (!activeThreadIds.has(thread.id)) {
          continue;
        }
        await stopThreadSession(thread.id);
      }
    },
    [runStore.activeRunsByThread, stopThreadSession]
  );

  const onLoadBranchSwitcher = useCallback(async (): Promise<{
    branches: GitBranchEntry[];
    status: GitWorkspaceStatus | null;
  }> => {
    if (!selectedWorkspace || !gitInfo || selectedWorkspace.kind !== 'local' || !selectedGitContextPath) {
      return { branches: [], status: null };
    }
    const [branches, status] = await Promise.all([
      api.gitListBranches(selectedGitContextPath),
      api.gitWorkspaceStatus(selectedGitContextPath)
    ]);
    return { branches, status };
  }, [gitInfo, selectedGitContextPath, selectedWorkspace]);

  const onCheckoutBranch = useCallback(
    async (branchName: string) => {
      if (!selectedWorkspace || selectedWorkspace.kind !== 'local' || !selectedGitContextPath) {
        return false;
      }
      const workspaceId = selectedWorkspace.id;
      suppressResumeFailureModalUntilByWorkspaceRef.current = {
        ...suppressResumeFailureModalUntilByWorkspaceRef.current,
        [workspaceId]: Date.now() + BRANCH_SWITCH_RESUME_FAILURE_SUPPRESS_MS
      };

      try {
        await api.gitCheckoutBranch(selectedGitContextPath, branchName);
        await refreshGitInfo();
        await refreshSkillsForWorkspace(selectedWorkspace);
        return true;
      } catch (error) {
        suppressResumeFailureModalUntilByWorkspaceRef.current = removeRecordEntry(
          suppressResumeFailureModalUntilByWorkspaceRef.current,
          workspaceId
        );
        pushToast(`Branch checkout failed: ${String(error)}`, 'error');
        throw error;
      }
    },
    [
      pushToast,
      refreshGitInfo,
      refreshSkillsForWorkspace,
      selectedGitContextPath,
      selectedWorkspace
    ]
  );

  useEffect(() => {
    const init = async () => {
      try {
        await api.getAppStorageRoot();
        await refreshWorkspaces();
        const savedSettings = normalizeSettings(await api.getSettings());
        setSettings(savedSettings);
        persistAppearanceMode(savedSettings.appearanceMode ?? 'system');
        const detected = await api.detectClaudeCliPath();
        setDetectedCliPath(detected);
        if (!detected && !savedSettings.claudeCliPath) {
          setBlockingError('Claude CLI is missing. Open Settings to configure the CLI path.');
        }
      } catch (error) {
        setBlockingError(String(error));
      }
    };

    void init();
  }, [refreshWorkspaces]);

  useEffect(() => {
    const appearanceMode = normalizeAppearanceMode(settings.appearanceMode);

    const syncAppearance = () => {
      const resolvedTheme = resolveAppearanceTheme(appearanceMode);
      applyAppearanceMode(appearanceMode);
      persistAppearanceMode(appearanceMode);
      void setAppTheme(appearanceMode === 'system' ? null : resolvedTheme).catch(() => undefined);
    };

    syncAppearance();

    if (appearanceMode !== 'system' || !window.matchMedia) {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      syncAppearance();
    };

    media.addEventListener?.('change', handleChange);
    return () => {
      media.removeEventListener?.('change', handleChange);
    };
  }, [settings.appearanceMode]);

  useEffect(() => {
    if (!settings.taskCompletionAlerts) {
      taskCompletionAlertBootstrapAttemptedRef.current = false;
      return;
    }
    if (taskCompletionAlertBootstrapAttemptedRef.current) {
      return;
    }
    if (window.localStorage.getItem(TASK_COMPLETION_ALERTS_BOOTSTRAP_KEY) === '1') {
      return;
    }

    taskCompletionAlertBootstrapAttemptedRef.current = true;
    void sendTaskCompletionAlertsEnabledConfirmation().then((sent) => {
      if (sent) {
        window.localStorage.setItem(TASK_COMPLETION_ALERTS_BOOTSTRAP_KEY, '1');
        return;
      }
      pushToast(
        'ATController could not queue a desktop notification. Check macOS notification settings after the first alert.',
        'info'
      );
    });
  }, [pushToast, settings.taskCompletionAlerts]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setSelectedThread(undefined);
      return;
    }

    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, selectedWorkspaceId);
    void refreshThreadsForWorkspace(selectedWorkspaceId);
  }, [refreshThreadsForWorkspace, selectedWorkspaceId, setSelectedThread]);

  useEffect(() => {
    if (workspaces.length === 0) {
      return;
    }

    void Promise.all(
      workspaces.map(async (workspace) => {
        try {
          await listThreads(workspace.id);
        } catch {
          // keep rendering other workspaces even if one fails to refresh
        }
      })
    );
  }, [listThreads, workspaces]);

  useEffect(() => {
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setSkillsByWorkspaceId((current) =>
      Object.fromEntries(Object.entries(current).filter(([workspaceId]) => workspaceIds.has(workspaceId)))
    );
    setSkillsLoadingByWorkspaceId((current) =>
      Object.fromEntries(Object.entries(current).filter(([workspaceId]) => workspaceIds.has(workspaceId)))
    );
    setSkillErrorsByWorkspaceId((current) =>
      Object.fromEntries(Object.entries(current).filter(([workspaceId]) => workspaceIds.has(workspaceId)))
    );
  }, [workspaces]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    void refreshSkillsForWorkspace(selectedWorkspace);
  }, [refreshSkillsForWorkspace, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) {
      gitInfoRequestIdRef.current += 1;
      setGitInfo(null);
      return;
    }

    void refreshGitInfo();
    const id = window.setInterval(() => {
      void refreshGitInfo();
    }, 10000);

    return () => window.clearInterval(id);
  }, [refreshGitInfo, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      return;
    }
    window.localStorage.setItem(threadSelectionKey(selectedWorkspaceId), selectedThreadId);
  }, [selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }
    if (isThreadVisibleToUser(selectedThreadId)) {
      markThreadJsonlCompletionSeen(selectedThreadId, true);
      recordThreadVisibleOutput(
        selectedThreadId,
        true,
        Date.now(),
        lastTerminalLogByThreadRef.current[selectedThreadId] ?? ''
      );
    }
  }, [isThreadVisibleToUser, markThreadJsonlCompletionSeen, recordThreadVisibleOutput, selectedThreadId]);

  useEffect(() => {
    const markSelectedThreadVisible = () => {
      const threadId = selectedThreadIdRef.current;
      if (!threadId || document.visibilityState !== 'visible') {
        return;
      }
      markThreadJsonlCompletionSeen(threadId, true);
      recordThreadVisibleOutput(threadId, true, Date.now(), lastTerminalLogByThreadRef.current[threadId] ?? '');
    };

    window.addEventListener('focus', markSelectedThreadVisible);
    document.addEventListener('visibilitychange', markSelectedThreadVisible);
    return () => {
      window.removeEventListener('focus', markSelectedThreadVisible);
      document.removeEventListener('visibilitychange', markSelectedThreadVisible);
    };
  }, [markThreadJsonlCompletionSeen, recordThreadVisibleOutput]);

  useEffect(() => {
    void api.setAppBadgeCount(unreadCompletedTurnCount > 0 ? unreadCompletedTurnCount : null).catch(() => undefined);
  }, [unreadCompletedTurnCount]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || selectedSessionId) {
      return;
    }
    if (startingByThread[selectedThreadId] || startingSessionByThreadRef.current[selectedThreadId]) {
      return;
    }
    let cancelled = false;
    void api
      .terminalGetLastLog(selectedWorkspaceId, selectedThreadId)
      .then((log) => {
        if (cancelled) {
          return;
        }
        if (
          activeRunsByThreadRef.current[selectedThreadId]?.sessionId ||
          startingSessionByThreadRef.current[selectedThreadId]
        ) {
          return;
        }
        presentThreadTerminalSnapshot(selectedThreadId, log);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        if (
          activeRunsByThreadRef.current[selectedThreadId]?.sessionId ||
          startingSessionByThreadRef.current[selectedThreadId]
        ) {
          return;
        }
        clearThreadTerminalStream(selectedThreadId);
      });
    return () => {
      cancelled = true;
    };
  }, [
    clearThreadTerminalStream,
    presentThreadTerminalSnapshot,
    selectedSessionId,
    selectedThreadId,
    selectedWorkspaceId,
    startingByThread
  ]);

  useEffect(() => {
    if (!selectedThread) {
      return;
    }
    if (
      !allowFreshStartAfterForkFailureByThreadRef.current[selectedThread.id] &&
      isThreadMissingClaimedForkSession(selectedThread)
    ) {
      setForkResolutionFailureBlockedByThread((current) =>
        current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
      );
      setForkResolutionFailureModal((current) =>
        current?.threadId === selectedThread.id
          ? current
          : {
              threadId: selectedThread.id,
              workspaceId: selectedThread.workspaceId
            }
      );
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
      return;
    }
    // Fork resolution runs in the background — don't block the terminal.
    // The user may need to send the first message before the child JSONL
    // appears (--fork-session clones), so input must stay enabled.
    if (selectedThreadAwaitingForkResolution) {
      return;
    }
    if (selectedThreadForkResolutionFailureBlocked) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
      return;
    }
    if (selectedThreadResumeFailureBlocked) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
      return;
    }
    if (selectedThreadSshStartupBlockReason) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));
      return;
    }
    if ((sessionFailCountByThreadRef.current[selectedThread.id] ?? 0) >= 3) {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      return;
    }
    const existingSessionId = selectedSessionId ?? activeRunsByThreadRef.current[selectedThread.id]?.sessionId ?? null;
    if (existingSessionId) {
      const existingSessionMeta = sessionMetaBySessionIdRef.current[existingSessionId];
      const requiresReadySignal = requiresExplicitSshReadySignal(
        existingSessionMeta?.workspaceKind ?? selectedWorkspace?.kind
      );
      if (!requiresReadySignal || readyByThreadRef.current[selectedThread.id]) {
        setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      } else {
        setStartingByThread((current) =>
          current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
        );
      }
      const stream = terminalStreamsByThreadRef.current[selectedThread.id];
      const shouldForceStatefulHydration =
        stream?.sessionId === existingSessionId &&
        stream.phase === 'ready' &&
        shouldPreserveRawTerminalPresentation(stream.text);
      const lastSentTerminalSize = lastSentTerminalSizeBySessionRef.current[existingSessionId];
      const shouldSuppressCachedStatefulStream =
        shouldForceStatefulHydration &&
        Boolean(
          lastSentTerminalSize &&
          (
            lastSentTerminalSize.cols !== terminalSize.cols ||
            lastSentTerminalSize.rows !== terminalSize.rows
          )
        );
      if (shouldForceStatefulHydration) {
        if (shouldSuppressCachedStatefulStream) {
          setSelectedStatefulHydrationSessionId((current) =>
            current === existingSessionId ? current : existingSessionId
          );
          setSelectedStatefulHydrationFailedSessionId((current) =>
            current === existingSessionId ? null : current
          );
        }
        if (!requiresReadySignal) {
          setReadyByThread((current) =>
            current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
          );
        }
        void hydrateSessionSnapshot(selectedThread.id, existingSessionId, {
          forceFreshReadySnapshot: true,
          keepSelectedStatefulHydrationOverlayOnFailure: shouldSuppressCachedStatefulStream,
          retryDelaysMs: shouldSuppressCachedStatefulStream ? STATEFUL_TERMINAL_REFRESH_RETRY_DELAYS_MS : []
        });
      } else if (stream?.sessionId === existingSessionId && stream.phase === 'ready' && !requiresReadySignal) {
        setReadyByThread((current) =>
          current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
        );
      } else {
        if (!requiresReadySignal) {
          setReadyByThread((current) =>
            current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
          );
        }
        void hydrateSessionSnapshot(selectedThread.id, existingSessionId);
      }
      return;
    }
    setStartingByThread((current) => ({
      ...current,
      [selectedThread.id]: true
    }));
    setReadyByThread((current) => removeThreadFlag(current, selectedThread.id));

    void ensureSessionForThread(selectedThread).catch((error) => {
      setStartingByThread((current) => removeThreadFlag(current, selectedThread.id));
      pushToast(`Failed to start Claude session: ${String(error)}`, 'error');
    });
  }, [
    ensureSessionForThread,
    hasCachedTerminalLog,
    hydrateSessionSnapshot,
    pushToast,
    selectedSessionId,
    terminalSize.cols,
    terminalSize.rows,
    updateThreadTerminalStream,
    selectedThreadForkResolutionFailureBlocked,
    selectedThreadAwaitingForkResolution,
    selectedThreadResumeFailureBlocked,
    selectedThreadSshStartupBlockReason,
    selectedWorkspace?.kind,
    selectedThread
  ]);

  useEffect(() => {
    if (!selectedThread || !selectedWorkspace || isRemoteWorkspaceKind(selectedWorkspace.kind)) {
      return;
    }
    if (!isUuidLike(selectedThread.pendingForkSourceClaudeSessionId?.trim() ?? '')) {
      return;
    }

    const activeSessionId =
      selectedSessionId ?? activeRunsByThreadRef.current[selectedThread.id]?.sessionId ?? null;
    if (!selectedThread.pendingForkLaunchConsumed && !activeSessionId) {
      return;
    }
    if (suppressAutoForkResolutionByThreadRef.current[selectedThread.id]) {
      return;
    }

    void resolvePendingThreadFork(selectedThread.id);
  }, [resolvePendingThreadFork, selectedSessionId, selectedThread, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace || !isRemoteWorkspaceKind(selectedWorkspace.kind)) {
      return;
    }

    const recover = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void attemptAutoRecoverSelectedThread();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      recover();
    };

    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [attemptAutoRecoverSelectedThread, selectedWorkspace]);

  const handleTerminalDataEvent = useCallback(
    (event: TerminalDataEvent) => {
      if (isIgnoredSshAuthStatusSession(event.sessionId)) {
        return;
      }

      if (shellTerminalSessionIdRef.current === event.sessionId && !event.threadId) {
        setShellTerminalStarting(false);
        setShellTerminalStream((current) => {
          const boundState =
            current.sessionId !== event.sessionId
              ? bindLiveTerminalSessionStream(current, event.sessionId)
              : current.phase === 'hydrating'
                ? hydrateTerminalSessionStream(
                    current,
                    event.sessionId,
                    {
                      text: '',
                      startPosition: 0,
                      endPosition: 0,
                      truncated: false
                    },
                    TERMINAL_LOG_BUFFER_CHARS
                  )
                : current;
          if (event.endPosition <= terminalSessionStreamKnownRawEndPosition(boundState)) {
            return boundState;
          }
          return appendTerminalStreamChunk(boundState, event, TERMINAL_LOG_BUFFER_CHARS);
        });
        return;
      }

      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      const threadId =
        event.threadId ??
        sessionMeta?.threadId ??
        threadIdBySessionIdRef.current[event.sessionId];
      if (!threadId) {
        return;
      }

      const workspaceKind =
        sessionMeta?.workspaceKind ??
        threadWorkspaceKindByThreadIdRef.current[threadId] ??
        (threadId === selectedThreadIdRef.current && selectedWorkspaceIdRef.current
          ? workspaces.find((workspace) => workspace.id === selectedWorkspaceIdRef.current)?.kind ?? null
          : null);
      const requiresReadySignal = requiresExplicitSshReadySignal(workspaceKind);

      const activeSessionIdForThread = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
      if (activeSessionIdForThread && activeSessionIdForThread !== event.sessionId) {
        const mappedThreadIdForEventSession = threadIdBySessionIdRef.current[event.sessionId] ?? sessionMeta?.threadId ?? null;
        if (mappedThreadIdForEventSession === threadId) {
          activeRunsByThreadRef.current = {
            ...activeRunsByThreadRef.current,
            [threadId]: {
              threadId,
              sessionId: event.sessionId,
              startedAt: activeRunsByThreadRef.current[threadId]?.startedAt ?? new Date().toISOString()
            }
          };
          runStore.bindSession(
            threadId,
            event.sessionId,
            activeRunsByThreadRef.current[threadId]?.startedAt ?? new Date().toISOString()
          );
        } else {
          if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
            console.debug('[terminal-data] dropped chunk for inactive session', {
              eventSessionId: event.sessionId,
              activeSessionId: activeSessionIdForThread,
              threadId
            });
          }
          return;
        }
      }

      const currentStream = terminalStreamsByThreadRef.current[threadId];
      if (
        currentStream &&
        currentStream.sessionId === event.sessionId &&
        event.endPosition <= terminalSessionStreamKnownRawEndPosition(currentStream)
      ) {
        return;
      }

      const visibleEventData = stripThreadHiddenInjectedPrompts(threadId, event.data);
      const hasMeaningfulOutput = noteTurnOutput(threadId, visibleEventData);
      const isSelectedThread = selectedThreadIdRef.current === threadId;
      const nowMs = Date.now();
      runLifecycleByThreadRef.current[threadId] = noteRunOutput(
        runLifecycleByThreadRef.current[threadId],
        hasMeaningfulOutput,
        nowMs
      );

      const maybeResolveStuckStreaming = () => {
        if (!workingByThreadRef.current[threadId]) {
          return;
        }
        if (!isStreamingStuck(runLifecycleByThreadRef.current[threadId], nowMs, THREAD_WORKING_STUCK_TIMEOUT_MS)) {
          return;
        }
        clearThreadWorkingStopTimer(threadId);
        stopThreadWorking(threadId);
      };

      if (isSelectedThread) {
        if (!requiresReadySignal) {
          setStartingByThread((current) => removeThreadFlag(current, threadId));
          setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
        }
      }
      const hasCompletedTurn = hasCompletedAttentionTurn(threadAttentionByThreadRef.current[threadId]);
      if (workingByThreadRef.current[threadId]) {
        scheduleThreadWorkingStop(threadId, THREAD_WORKING_IDLE_TIMEOUT_MS);
        if (!hasMeaningfulOutput) {
          maybeResolveStuckStreaming();
        }
      } else if (
        hasMeaningfulOutput &&
        activeRunsByThreadRef.current[threadId] &&
        hasUserSentMessageInCurrentSession(threadId) &&
        !(hasCompletedTurn && resolveThreadTurnCompletionMode(threadId) === 'jsonl')
      ) {
        // Session still alive but working timer expired — re-enter working state.
        clearThreadWorkingStopTimer(threadId);
        startThreadWorking(threadId);
        scheduleThreadWorkingStop(threadId, THREAD_WORKING_IDLE_TIMEOUT_MS);
      }
      appendTerminalLogChunk(threadId, {
        ...event,
        data: event.data
      });
    },
    [
      appendTerminalLogChunk,
      clearThreadWorkingStopTimer,
      hasUserSentMessageInCurrentSession,
      isIgnoredSshAuthStatusSession,
      noteTurnOutput,
      resolveThreadTurnCompletionMode,
      stripThreadHiddenInjectedPrompts,
      setShellTerminalStream,
      startThreadWorking,
      stopThreadWorking,
      scheduleThreadWorkingStop,
      workspaces
    ]
  );

  const handleTerminalReadyEvent = useCallback((event: TerminalReadyEvent) => {
    if (isIgnoredSshAuthStatusSession(event.sessionId)) {
      return;
    }

    if (shellTerminalSessionIdRef.current === event.sessionId && !event.threadId) {
      if (shellTerminalWorkspaceIdRef.current) {
        setSshStartupBlockedShellByWorkspace((current) =>
          removeRecordEntry(current, shellTerminalWorkspaceIdRef.current!)
        );
      }
      setSshStartupBlockModal((current) => (current?.sessionId === event.sessionId ? null : current));
      setShellTerminalStarting(false);
      return;
    }

    const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
    const threadId =
      event.threadId ??
      sessionMeta?.threadId ??
      threadIdBySessionIdRef.current[event.sessionId];
    if (!threadId) {
      return;
    }

    const activeSessionIdForThread = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
    if (activeSessionIdForThread && activeSessionIdForThread !== event.sessionId) {
      return;
    }

    runLifecycleByThreadRef.current[threadId] = markRunReady(runLifecycleByThreadRef.current[threadId]);
    setSshStartupBlockedByThread((current) => removeRecordEntry(current, threadId));
    setSshStartupBlockModal((current) => (current?.sessionId === event.sessionId ? null : current));
    setStartingByThread((current) => removeThreadFlag(current, threadId));
    setReadyByThread((current) => (current[threadId] ? current : { ...current, [threadId]: true }));
  }, [isIgnoredSshAuthStatusSession]);

  const handleTerminalSshAuthStatusEvent = useCallback(
    (event: TerminalSshAuthStatusEvent) => {
      if (isIgnoredSshAuthStatusSession(event.sessionId)) {
        return;
      }

      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      const threadId =
        event.threadId ??
        sessionMeta?.threadId ??
        threadIdBySessionIdRef.current[event.sessionId] ??
        null;

      if (threadId) {
        const activeSessionIdForThread = activeRunsByThreadRef.current[threadId]?.sessionId ?? null;
        if (activeSessionIdForThread && activeSessionIdForThread !== event.sessionId) {
          return;
        }
        if (!activeSessionIdForThread) {
          if (!startingSessionByThreadRef.current[threadId]) {
            return;
          }
          stagePendingSshStartupAuthStatus(event);
          ignoreSshAuthStatusSession(event.sessionId);
          void api.terminalKill(event.sessionId).catch(() => undefined);
          return;
        }

        ignoreSshAuthStatusSession(event.sessionId);
        applyThreadSshStartupBlock(threadId, event);
        void stopThreadSession(threadId).catch(() => undefined);
        return;
      }

      const activeShellSessionId =
        shellTerminalWorkspaceIdRef.current === event.workspaceId ? shellTerminalSessionIdRef.current : null;
      if (activeShellSessionId && activeShellSessionId !== event.sessionId) {
        return;
      }
      if (!activeShellSessionId) {
        if (pendingShellSessionStartRef.current?.workspaceId !== event.workspaceId) {
          return;
        }
        stagePendingSshStartupAuthStatus(event);
        ignoreSshAuthStatusSession(event.sessionId);
        void api.terminalKill(event.sessionId).catch(() => undefined);
        return;
      }

      ignoreSshAuthStatusSession(event.sessionId);
      applyWorkspaceShellSshStartupBlock(event);
      if (shellTerminalSessionIdRef.current === event.sessionId) {
        void stopShellSessionForWorkspace(event.workspaceId, { clearContent: false }).catch(() => undefined);
      } else {
        void api.terminalKill(event.sessionId).catch(() => undefined);
      }
    },
    [
      applyThreadSshStartupBlock,
      applyWorkspaceShellSshStartupBlock,
      isIgnoredSshAuthStatusSession,
      ignoreSshAuthStatusSession,
      stagePendingSshStartupAuthStatus,
      stopShellSessionForWorkspace,
      stopThreadSession
    ]
  );

  const handleTerminalTurnCompletedEvent = useCallback(
    (event: TerminalTurnCompletedEvent) => {
      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      const threadId =
        event.threadId ??
        sessionMeta?.threadId ??
        threadIdBySessionIdRef.current[event.sessionId];
      if (!threadId) {
        return;
      }

      const activeSessionIdForThread =
        activeRunsByThreadRef.current[threadId]?.sessionId ?? runStore.sessionForThread(threadId) ?? null;
      if (activeSessionIdForThread !== event.sessionId) {
        return;
      }

      const currentCwd = event.currentCwd?.trim() ?? '';
      if (currentCwd) {
        if (sessionMeta) {
          sessionMeta.currentCwd = currentCwd;
        }
        rememberThreadRuntimeCwd(threadId, currentCwd);
      }
      const jsonlAttentionContext = resolveJsonlCompletionAttentionContext(threadId, event.sessionId);
      if (!jsonlAttentionContext.usesJsonlAttention) {
        return;
      }

      clearThreadWorkingStopTimer(threadId);
      stopThreadWorking(threadId);
      const completionStatus: ThreadAttentionCompletionStatus = event.status === 'Failed' ? 'Failed' : 'Succeeded';
      const completedAtMs = event.completedAtMs ?? Date.now();
      const previousAttentionState = threadAttentionByThreadRef.current[threadId] ?? createThreadAttentionState();
      const shouldSeedMeaningfulOutput =
        event.hasMeaningfulOutput === true &&
        previousAttentionState.activeTurnId !== null &&
        previousAttentionState.activeTurnStatus === 'running';
      if (shouldSeedMeaningfulOutput) {
        commitThreadAttentionState(threadId, {
          ...previousAttentionState,
          activeTurnStatus: 'running',
          activeTurnHasMeaningfulOutput: true,
          activeTurnLastOutputAtMs: previousAttentionState.activeTurnLastOutputAtMs ?? completedAtMs
        });
        if (isThreadVisibleToUser(threadId)) {
          recordThreadVisibleOutput(threadId, false, completedAtMs, lastTerminalLogByThreadRef.current[threadId] ?? '');
        }
      }
      completeTurn(threadId, completionStatus, completedAtMs);
      const claudeSessionId = jsonlAttentionContext.claudeSessionId;
      const isQualifyingJsonlCompletion =
        event.completionIndex !== null &&
        event.completionIndex !== undefined &&
        (event.hasMeaningfulOutput === true || completionStatus === 'Failed');
      if (isQualifyingJsonlCompletion && claudeSessionId) {
        observeThreadJsonlCompletion(
          threadId,
          claudeSessionId,
          {
            claudeSessionId,
            completionIndex: event.completionIndex!,
            completedAtMs,
            status: completionStatus,
            hasMeaningfulOutput: event.hasMeaningfulOutput === true
          },
          { persistNow: true }
        );
      }
    },
    [
      clearThreadWorkingStopTimer,
      commitThreadAttentionState,
      completeTurn,
      isThreadVisibleToUser,
      observeThreadJsonlCompletion,
      recordThreadVisibleOutput,
      resolveJsonlCompletionAttentionContext,
      rememberThreadRuntimeCwd,
      runStore,
      stopThreadWorking
    ]
  );

  const handleTerminalExitEvent = useCallback(
    (event: TerminalExitEvent) => {
      const sessionMeta = sessionMetaBySessionIdRef.current[event.sessionId];
      ignoreSshAuthStatusSession(event.sessionId);

      if (shellTerminalSessionIdRef.current === event.sessionId) {
        clearTerminalSessionTracking(event.sessionId);
        invalidatePendingShellSessionStart(shellTerminalWorkspaceIdRef.current);
        setShellSessionBinding(null, shellTerminalWorkspaceIdRef.current);
        return;
      }

      const endedThreadId = finishSessionBinding(event.sessionId);
      clearTerminalSessionTracking(event.sessionId);
      if (!endedThreadId) {
        return;
      }
      runLifecycleByThreadRef.current[endedThreadId] = markRunExited();
      const exitStatus = statusFromExit(event);
      setStartingByThread((current) => removeThreadFlag(current, endedThreadId));
      setReadyByThread((current) => removeThreadFlag(current, endedThreadId));
      clearThreadWorkingStopTimer(endedThreadId);
      stopThreadWorking(endedThreadId);
      clearThreadRuntimeCwd(endedThreadId);

      const endedAt = new Date().toISOString();
      setThreadRunState(endedThreadId, exitStatus, null, endedAt);
      if (exitStatus === 'Succeeded') {
        sessionFailCountByThreadRef.current[endedThreadId] = 0;
      } else {
        sessionFailCountByThreadRef.current[endedThreadId] =
          (sessionFailCountByThreadRef.current[endedThreadId] ?? 0) + 1;
      }
      const previousAttentionState = threadAttentionByThreadRef.current[endedThreadId] ?? createThreadAttentionState();
      const completedAttentionState = completeTurn(endedThreadId, exitStatus);
      const shouldUseJsonlCompletionAttention = resolveJsonlCompletionAttentionContext(
        endedThreadId,
        event.sessionId
      ).usesJsonlAttention;
      if (
        !shouldUseJsonlCompletionAttention &&
        (
          completedAttentionState.lastCompletedTurnIdWithOutput > previousAttentionState.lastCompletedTurnIdWithOutput ||
          (
          completedAttentionState.lastCompletedTurnIdWithOutput === previousAttentionState.lastCompletedTurnIdWithOutput &&
          completedAttentionState.lastCompletedTurnStatus !== previousAttentionState.lastCompletedTurnStatus &&
          shouldNotifyAttentionTurn(completedAttentionState)
          )
        )
      ) {
        notifyCompletedTurnIfNeeded(endedThreadId, completedAttentionState);
      }

      const workspaceId =
        sessionMeta?.workspaceId ??
        Object.values(threadsByWorkspaceRef.current)
          .flat()
          .find((thread) => thread.id === endedThreadId)?.workspaceId;
      if (workspaceId) {
        void refreshThreadsForWorkspace(workspaceId);
      }

      if (sessionMeta?.mode !== 'resumed') {
        return;
      }

      const finalLog = lastTerminalLogByThreadRef.current[endedThreadId] ?? '';
      const elapsedMs = Date.now() - sessionMeta.startedAtMs;
      const failedCode = typeof event.code === 'number' && event.code !== 0 && event.code !== 130;
      const likelyResumeFailure =
        looksLikeResumeFailureOutput(finalLog) || (failedCode && elapsedMs < 15_000);
      if (!likelyResumeFailure || !workspaceId) {
        return;
      }
      const suppressModalUntil = suppressResumeFailureModalUntilByWorkspaceRef.current[workspaceId] ?? 0;
      if (suppressModalUntil > Date.now()) {
        sessionFailCountByThreadRef.current[endedThreadId] = Math.max(
          0,
          (sessionFailCountByThreadRef.current[endedThreadId] ?? 1) - 1
        );
        return;
      }

      setResumeFailureBlockedByThread((current) => addRecordFlag(current, endedThreadId));

      setResumeFailureModal({
        threadId: endedThreadId,
        workspaceId,
        log: finalLog,
        showLog: false
      });
    },
    [
      clearThreadRuntimeCwd,
      completeTurn,
      finishSessionBinding,
      invalidatePendingShellSessionStart,
      notifyCompletedTurnIfNeeded,
      refreshThreadsForWorkspace,
      resolveJsonlCompletionAttentionContext,
      setThreadRunState,
      setShellSessionBinding,
      stopThreadWorking,
      clearTerminalSessionTracking,
      clearThreadWorkingStopTimer,
      ignoreSshAuthStatusSession
    ]
  );

  const handleThreadUpdatedEvent = useCallback(
    (thread: ThreadMetadata) => {
      if (!thread || !thread.id || !thread.workspaceId) {
        return;
      }
      if (deletedThreadIdsRef.current[thread.id]) {
        return;
      }
      applyThreadUpdate(thread);
      const activeSessionId =
        activeRunsByThreadRef.current[thread.id]?.sessionId ?? runStore.sessionForThread(thread.id) ?? null;
      if (!activeSessionId) {
        return;
      }
      const sessionMeta = sessionMetaBySessionIdRef.current[activeSessionId];
      if (!sessionMeta) {
        return;
      }
      const claudeSessionId = thread.claudeSessionId?.trim() ?? '';
      if (!claudeSessionId || sessionMeta.claudeSessionId === claudeSessionId) {
        return;
      }
      sessionMeta.claudeSessionId = claudeSessionId;
      if (sessionMeta.turnCompletionMode === 'jsonl' && sessionMeta.workspaceKind === 'local') {
        resetThreadJsonlCompletionAttentionForSession(thread.id, claudeSessionId);
        const workspace = workspaces.find((candidate) => candidate.id === thread.workspaceId);
        if (workspace?.kind === 'local') {
          void reconcileThreadJsonlCompletionAttention(thread.id, workspace.path, claudeSessionId);
        }
      }
      void bootstrapThreadRuntimeCwdFromClaudeSession(thread.id, activeSessionId);
    },
    [
      applyThreadUpdate,
      bootstrapThreadRuntimeCwdFromClaudeSession,
      reconcileThreadJsonlCompletionAttention,
      resetThreadJsonlCompletionAttentionForSession,
      runStore,
      workspaces
    ]
  );

  terminalDataEventHandlerRef.current = handleTerminalDataEvent;
  terminalReadyEventHandlerRef.current = handleTerminalReadyEvent;
  terminalSshAuthStatusEventHandlerRef.current = handleTerminalSshAuthStatusEvent;
  terminalTurnCompletedEventHandlerRef.current = handleTerminalTurnCompletedEvent;
  terminalExitEventHandlerRef.current = handleTerminalExitEvent;
  threadUpdatedEventHandlerRef.current = handleThreadUpdatedEvent;

  useEffect(() => {
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    terminalDataListenerReadyRef.current = false;

    void onTerminalData((event) => {
      terminalDataEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          resolveTerminalDataListenerReady();
          return;
        }
        unlistenData = off;
        resolveTerminalDataListenerReady();
      })
      .catch(() => {
        resolveTerminalDataListenerReady();
      });

    return () => {
      cancelled = true;
      unlistenData?.();
    };
  }, [resolveTerminalDataListenerReady]);

  useEffect(() => {
    let cancelled = false;
    let unlistenReady: (() => void) | null = null;

    void onTerminalReady((event) => {
      terminalReadyEventHandlerRef.current(event);
      if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
        console.debug('[terminal:ready]', event);
      }
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenReady = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenReady?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenSshAuthStatus: (() => void) | null = null;

    void onTerminalSshAuthStatus((event) => {
      terminalSshAuthStatusEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenSshAuthStatus = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenSshAuthStatus?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenTurnCompleted: (() => void) | null = null;

    void onTerminalTurnCompleted((event: TerminalTurnCompletedEvent) => {
      terminalTurnCompletedEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenTurnCompleted = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenTurnCompleted?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenExit: (() => void) | null = null;

    void onTerminalExit((event: TerminalExitEvent) => {
      terminalExitEventHandlerRef.current(event);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenExit = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenExit?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenThreadUpdate: (() => void) | null = null;

    void onThreadUpdated((thread) => {
      threadUpdatedEventHandlerRef.current(thread);
    })
      .then((off) => {
        if (cancelled) {
          off();
          return;
        }
        unlistenThreadUpdate = off;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenThreadUpdate?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'f' && focusedTerminalKind) {
        event.preventDefault();
        if (focusedTerminalKind === 'shell') {
          setShellTerminalSearchToggleRequestId((current) => current + 1);
        } else {
          setTerminalSearchToggleRequestId((current) => current + 1);
        }
        return;
      }

      if (shouldIgnoreGlobalTerminalShortcutTarget(event.target)) {
        return;
      }

      const focusedSessionId =
        focusedTerminalKind === 'shell'
          ? shellTerminalSessionId
          : focusedTerminalKind === 'claude'
            ? selectedSessionId
            : null;

      if (focusedSessionId && event.ctrlKey && !event.metaKey && !event.altKey && key === 'c') {
        event.preventDefault();
        void api.terminalSendSignal(focusedSessionId, 'SIGINT');
        return;
      }

      if (event.key === 'Escape' && focusedSessionId) {
        event.preventDefault();
        const now = Date.now();
        if (
          escapeSignalRef.current &&
          escapeSignalRef.current.sessionId === focusedSessionId &&
          now - escapeSignalRef.current.at < 1500
        ) {
          void api.terminalKill(focusedSessionId);
          escapeSignalRef.current = null;
        } else {
          void api.terminalSendSignal(focusedSessionId, 'SIGINT');
          escapeSignalRef.current = { sessionId: focusedSessionId, at: now };
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedTerminalKind, selectedSessionId, shellTerminalSessionId]);

  const saveSettings = useCallback(
    async (nextSettings: {
      cliPath: string;
      appearanceMode: AppearanceMode;
      defaultNewThreadFullAccess: boolean;
      taskCompletionAlerts: boolean;
    }) => {
      const taskCompletionAlerts = nextSettings.taskCompletionAlerts;
      const alertsJustEnabled = !settings.taskCompletionAlerts && taskCompletionAlerts;
      if (alertsJustEnabled) {
        taskCompletionAlertBootstrapAttemptedRef.current = true;
      }

      const saved = normalizeSettings(
        await api.saveSettings({
          claudeCliPath: nextSettings.cliPath || null,
          appearanceMode: nextSettings.appearanceMode,
          defaultNewThreadFullAccess: nextSettings.defaultNewThreadFullAccess,
          taskCompletionAlerts
        })
      );
      setSettings(saved);
      const detected = await api.detectClaudeCliPath();
      setDetectedCliPath(detected);
      setSettingsOpen(false);
      if (detected || nextSettings.cliPath) {
        setBlockingError(null);
      }
      if (alertsJustEnabled && taskCompletionAlerts) {
        const sent = await sendTaskCompletionAlertsEnabledConfirmation();
        if (sent) {
          window.localStorage.setItem(TASK_COMPLETION_ALERTS_BOOTSTRAP_KEY, '1');
        } else {
          pushToast(
            'ATController could not queue a desktop notification. Check macOS notification settings after the first alert.',
            'info'
          );
        }
      }
    },
    [pushToast, settings.taskCompletionAlerts]
  );

  const sendTestAlert = useCallback(async () => {
    if (!settings.taskCompletionAlerts) {
      pushToast('Turn on Task completion alerts first.', 'info');
      return;
    }

    const sent = await sendTaskCompletionAlertsTestNotification();
    if (sent) {
      pushToast(
        'Queued a test alert. If you do not see a banner, check macOS notification style and sound settings.',
        'info'
      );
      return;
    }

    pushToast(
      'ATController could not queue a desktop notification. Check macOS notification settings after the first alert.',
      'info'
    );
  }, [pushToast, settings.taskCompletionAlerts]);

  const writeTextToClipboard = useCallback(async (value: string) => {
    try {
      await api.writeTextToClipboard(value);
      return;
    } catch (error) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      throw error;
    }
  }, []);

  const copyEnvDiagnostics = useCallback(async () => {
    if (!selectedWorkspace) {
      pushToast('Select a workspace first.', 'error');
      return;
    }
    if (selectedWorkspace.kind !== 'local') {
      pushToast('Diagnostics are only available for local workspaces.', 'info');
      return;
    }

    try {
      const diagnostics = await api.copyTerminalEnvDiagnostics(selectedWorkspace.path);
      await writeTextToClipboard(diagnostics);
      pushToast('Copied terminal environment diagnostics to clipboard.', 'info');
    } catch (error) {
      pushToast(`Failed to collect diagnostics: ${String(error)}`, 'error');
    }
  }, [pushToast, selectedWorkspace, writeTextToClipboard]);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const waitForRdevShellPrompt = useCallback(async (sessionId: string) => {
    for (let attempt = 0; attempt < RDEV_SHELL_PROMPT_MAX_POLLS; attempt += 1) {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), RDEV_SHELL_PROMPT_POLL_INTERVAL_MS);
      });
      const snapshot = await api.terminalReadOutput(sessionId).catch(() => null);
      if (hasShellPromptInSnapshot(snapshot?.text ?? '')) {
        return true;
      }
    }
    return false;
  }, []);

  const restartRdevClaudeInPlace = useCallback(
    async (thread: ThreadMetadata) => {
      const sessionId =
        activeRunsByThreadRef.current[thread.id]?.sessionId ?? runStore.sessionForThread(thread.id) ?? null;
      const resumeSessionId = thread.claudeSessionId?.trim() ?? '';
      if (!sessionId || !isUuidLike(resumeSessionId)) {
        return false;
      }

      const command = buildClaudeInPlaceRestartCommand(resumeSessionId, thread.fullAccess);

      await api.terminalSendSignal(sessionId, 'SIGINT').catch(() => undefined);
      let ready = await waitForRdevShellPrompt(sessionId);
      if (!ready) {
        await api.terminalWrite(sessionId, '/exit\r').catch(() => false);
        await new Promise<void>((resolve) => {
          window.setTimeout(() => resolve(), CLAUDE_IN_PLACE_RESTART_DELAY_MS);
        });
        ready = await waitForRdevShellPrompt(sessionId);
      }
      if (!ready) {
        return false;
      }

      const wrote = await api.terminalWrite(sessionId, `${command}\r`).catch(() => false);
      return wrote;
    },
    [runStore, waitForRdevShellPrompt]
  );

  const selectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      void switchToThread(workspaceId, threadId);
    },
    [switchToThread]
  );

  const toggleFullAccess = useCallback(async () => {
    if (!selectedThread || fullAccessUpdating) {
      return;
    }

    const workspace = workspaces.find((item) => item.id === selectedThread.workspaceId) ?? null;
    const activeSessionId =
      activeRunsByThreadRef.current[selectedThread.id]?.sessionId ?? runStore.sessionForThread(selectedThread.id) ?? null;
    const activeSessionMode = activeSessionId
      ? sessionMetaBySessionIdRef.current[activeSessionId]?.mode ?? null
      : null;
    const hasInteractedThisSession =
      (lastUserInputAtMsByThreadRef.current[selectedThread.id] ?? 0) >
      (lastSessionStartAtMsByThreadRef.current[selectedThread.id] ?? 0);
    if (
      workspace &&
      isRemoteWorkspaceKind(workspace.kind) &&
      (
        Boolean(startingByThread[selectedThread.id]) ||
        Boolean(startingSessionByThreadRef.current[selectedThread.id]) ||
        !hasInteractedThisSession
      )
    ) {
      pushToast(REMOTE_FULL_ACCESS_STARTUP_BLOCK_REASON, 'info');
      return;
    }
    const nextValue = !selectedThread.fullAccess;
    const draftInput = getThreadDraftInput(selectedThread.id);
    setFullAccessUpdating(true);
    try {
      let updatedThread = await setThreadFullAccess(selectedThread.workspaceId, selectedThread.id, nextValue);
      if (
        activeSessionMode === 'new' &&
        !hasInteractedThisSession &&
        isUuidLike(updatedThread.claudeSessionId?.trim() ?? '')
      ) {
        updatedThread = await api.clearThreadClaudeSession(updatedThread.workspaceId, updatedThread.id);
        applyThreadUpdate(updatedThread);
      }
      const canRestartRdevInPlace =
        workspace?.kind === 'rdev' && isUuidLike(updatedThread.claudeSessionId?.trim() ?? '');
      if (canRestartRdevInPlace) {
        const switchedInPlace = await restartRdevClaudeInPlace(updatedThread);
        if (switchedInPlace) {
          const sessionId =
            activeRunsByThreadRef.current[updatedThread.id]?.sessionId ?? runStore.sessionForThread(updatedThread.id) ?? null;
          await replayThreadDraftInput(sessionId, draftInput);
          if (selectedWorkspaceIdRef.current !== updatedThread.workspaceId) {
            setSelectedWorkspace(updatedThread.workspaceId);
          }
          setSelectedThread(updatedThread.id);
          pushToast(`Full access ${nextValue ? 'enabled' : 'disabled'} in-place.`, 'info');
          return;
        }
        pushToast('Could not switch in-place for remote workspace; reconnecting session.', 'info');
      }
      await stopThreadSession(updatedThread.id);
      if (selectedWorkspaceIdRef.current !== updatedThread.workspaceId) {
        setSelectedWorkspace(updatedThread.workspaceId);
      }
      primeRemoteThreadStartupOnSelection(updatedThread, workspace);
      setSelectedThread(updatedThread.id);
      const nextSessionId = await ensureSessionForThread(updatedThread);
      await waitForThreadReplayWindow(updatedThread.id, nextSessionId);
      await replayThreadDraftInput(nextSessionId, draftInput);
    } catch (error) {
      pushToast(`Failed to update Full access: ${String(error)}`, 'error');
    } finally {
      setFullAccessUpdating(false);
    }
  }, [
    activeRunsByThreadRef,
    applyThreadUpdate,
    ensureSessionForThread,
    fullAccessUpdating,
    getThreadDraftInput,
    lastSessionStartAtMsByThreadRef,
    lastUserInputAtMsByThreadRef,
    startingByThread,
    primeRemoteThreadStartupOnSelection,
    pushToast,
    replayThreadDraftInput,
    restartRdevClaudeInPlace,
    runStore,
    sessionMetaBySessionIdRef,
    selectedThread,
    setSelectedThread,
    setSelectedWorkspace,
    setThreadFullAccess,
    stopThreadSession,
    waitForThreadReplayWindow,
    workspaces
  ]);

  const openWorkspaceInFinder = useCallback(
    (workspace: Workspace) => {
      if (isRemoteWorkspaceKind(workspace.kind)) {
        pushToast('Remote workspaces do not map to a local Finder folder.', 'info');
        return;
      }
      void api.openInFinder(workspace.path);
    },
    [pushToast]
  );

  const launchWorkspaceInTerminal = useCallback(
    async (workspace: Workspace): Promise<boolean> => {
      if (isRemoteWorkspaceKind(workspace.kind)) {
        const command =
          workspace.kind === 'rdev' ? workspace.rdevSshCommand?.trim() : workspace.sshCommand?.trim();
        if (!command) {
          pushToast('Missing remote shell command for this workspace.', 'error');
          return false;
        }
        try {
          await api.openTerminalCommand(command);
          return true;
        } catch (error) {
          pushToast(`Failed to open terminal: ${String(error)}`, 'error');
          return false;
        }
      }
      try {
        await api.openInTerminal(workspace.path);
        return true;
      } catch (error) {
        pushToast(`Failed to open terminal: ${String(error)}`, 'error');
        return false;
      }
    },
    [pushToast]
  );

  const openWorkspaceInTerminal = useCallback(
    (workspace: Workspace) => {
      void launchWorkspaceInTerminal(workspace);
    },
    [launchWorkspaceInTerminal]
  );

  const popOutWorkspaceShellToTerminal = useCallback(async () => {
    if (!selectedWorkspace) {
      return;
    }
    const opened = await launchWorkspaceInTerminal(selectedWorkspace);
    if (opened) {
      closeWorkspaceShellDrawer();
    }
  }, [closeWorkspaceShellDrawer, launchWorkspaceInTerminal, selectedWorkspace]);

  const copyResumeCommand = useCallback(
    (thread: ThreadMetadata) => {
      const sessionId = thread.claudeSessionId?.trim();
      if (!sessionId) {
        pushToast('No Claude session ID available — start a session first.', 'error');
        return;
      }
      const command = `claude --resume ${sessionId}`;
      void writeTextToClipboard(command)
        .then(() => {
          pushToast('Resume command copied to clipboard.', 'info');
        })
        .catch((error) => {
          pushToast(`Failed to copy resume command: ${String(error)}`, 'error');
        });
    },
    [pushToast, writeTextToClipboard]
  );

  const copyWorkspaceCommand = useCallback(
    (workspace: Workspace) => {
      const command = (
        workspace.kind === 'rdev' ? workspace.rdevSshCommand : workspace.sshCommand
      )?.trim();
      if (!command) {
        pushToast('No remote command configured for this workspace.', 'error');
        return;
      }
      void writeTextToClipboard(command)
        .then(() => {
          pushToast('Remote command copied to clipboard.', 'info');
        })
        .catch((error) => {
          pushToast(`Failed to copy remote command: ${String(error)}`, 'error');
        });
    },
    [pushToast, writeTextToClipboard]
  );

  const onImportSession = useCallback((workspace: Workspace) => {
    setImportSessionWorkspace(workspace);
    setImportSessionError(null);
  }, []);

  const confirmImportSession = useCallback(
    async (claudeSessionId: string) => {
      if (!importSessionWorkspace) {
        return;
      }
      setImportingSession(true);
      setImportSessionError(null);
      try {
        const importableSession =
          importSessionWorkspace.kind === 'local'
            ? await api.getImportableClaudeSession(importSessionWorkspace.path, claudeSessionId)
            : null;
        if (importSessionWorkspace.kind === 'local') {
          await api.validateImportableClaudeSession(importSessionWorkspace.path, claudeSessionId);
        }
        const thread = await api.createThread(
          importSessionWorkspace.id,
          'claude-code',
          settings.defaultNewThreadFullAccess === true
        );
        let importedThread = await api.setThreadClaudeSessionId(
          importSessionWorkspace.id,
          thread.id,
          claudeSessionId
        );
        const sessionTitle =
          importableSession?.summary?.trim() ||
          importableSession?.firstPrompt?.trim() ||
          null;
        if (sessionTitle) {
          try {
            importedThread = await api.renameThread(importSessionWorkspace.id, importedThread.id, sessionTitle);
          } catch {
            // Non-fatal: thread was already created and linked successfully.
          }
        }
        applyThreadUpdate(importedThread);
        delete deletedThreadIdsRef.current[importedThread.id];
        if (selectedWorkspaceIdRef.current !== importSessionWorkspace.id) {
          setSelectedWorkspace(importSessionWorkspace.id);
        }
        primeRemoteThreadStartupOnSelection(importedThread, importSessionWorkspace);
        setSelectedThread(importedThread.id);
        setTerminalFocusRequestId((current) => current + 1);
        await refreshThreadsForWorkspace(importSessionWorkspace.id);
        setImportSessionWorkspace(null);
        pushToast('Session imported — opening thread.', 'info');
      } catch (error) {
        setImportSessionError(String(error));
      } finally {
        setImportingSession(false);
      }
    },
    [
      applyThreadUpdate,
      importSessionWorkspace,
      primeRemoteThreadStartupOnSelection,
      pushToast,
      refreshThreadsForWorkspace,
      settings.defaultNewThreadFullAccess,
      setSelectedThread,
      setSelectedWorkspace
    ]
  );

  const refreshImportableClaudeSessionsDiscovery = useCallback(async () => {
    setBulkImportLoading(true);
    setBulkImportError(null);
    try {
      const discovered = await api.discoverImportableClaudeSessions();
      setDiscoveredImportableClaudeProjects(discovered);
      const availableSessionIds = new Set(
        discovered.flatMap((project) => project.sessions.map((session) => session.sessionId))
      );
      setSelectedBulkImportSessionIds((current) => current.filter((sessionId) => availableSessionIds.has(sessionId)));
    } catch (error) {
      setBulkImportError(String(error));
    } finally {
      setBulkImportLoading(false);
    }
  }, []);

  const openBulkImportModal = useCallback(() => {
    setSettingsOpen(false);
    setAddWorkspaceOpen(false);
    setAddWorkspaceError(null);
    setAddWorkspaceSshCommand('');
    setAddWorkspaceSshRemotePath('');
    setBulkImportOpen(true);
    setBulkImportError(null);
    setSelectedBulkImportSessionIds([]);
    void refreshImportableClaudeSessionsDiscovery();
  }, [refreshImportableClaudeSessionsDiscovery]);

  const closeBulkImportModal = useCallback(() => {
    if (bulkImporting) {
      return;
    }
    setBulkImportOpen(false);
    setBulkImportError(null);
    setSelectedBulkImportSessionIds([]);
  }, [bulkImporting]);

  const toggleBulkImportSessionSelection = useCallback((sessionId: string, selected: boolean) => {
    setSelectedBulkImportSessionIds((current) => {
      if (selected) {
        return current.includes(sessionId) ? current : [...current, sessionId];
      }
      return current.filter((candidate) => candidate !== sessionId);
    });
  }, []);

  const toggleBulkImportProjectSelection = useCallback(
    (_project: ImportableClaudeProject, visibleImportableSessionIds: string[], selected: boolean) => {
      setSelectedBulkImportSessionIds((current) => {
        const next = new Set(current);
        if (selected) {
          visibleImportableSessionIds.forEach((sessionId) => next.add(sessionId));
        } else {
          visibleImportableSessionIds.forEach((sessionId) => next.delete(sessionId));
        }
        return Array.from(next);
      });
    },
    []
  );

  const confirmBulkImportClaudeSessions = useCallback(async () => {
    if (bulkImporting) {
      return;
    }

    const importedSessionIdSet = new Set(importedClaudeSessionIds);
    const sessionIdsToImport = selectedBulkImportSessionIds.filter((sessionId) => {
      const discovered = discoveredImportableClaudeSessionsById.get(sessionId);
      return Boolean(discovered?.project.pathExists) && !importedSessionIdSet.has(sessionId);
    });

    if (sessionIdsToImport.length === 0) {
      setBulkImportError('Select at least one Claude session that has not already been imported.');
      return;
    }

    setBulkImporting(true);
    setBulkImportError(null);

    try {
      const workspaceByProjectPath = new Map<string, Workspace>();
      const impactedWorkspaceIds = new Set<string>();
      const importedThreads: Array<{ workspace: Workspace; thread: ThreadMetadata }> = [];

      for (const sessionId of sessionIdsToImport) {
        const discovered = discoveredImportableClaudeSessionsById.get(sessionId);
        if (!discovered) {
          continue;
        }

        const { project } = discovered;
        let workspace =
          workspaceByProjectPath.get(project.path) ??
          workspaces.find(
            (candidate) =>
              candidate.id === project.workspaceId ||
              (candidate.kind === 'local' && candidate.path === project.path)
          );

        if (!workspace) {
          workspace = await ensureLocalWorkspaceByPath(project.path, { select: false });
        }
        workspaceByProjectPath.set(project.path, workspace);

        await api.validateImportableClaudeSession(workspace.path, sessionId);
        const thread = await api.createThread(
          workspace.id,
          'claude-code',
          settings.defaultNewThreadFullAccess === true
        );
        let importedThread = await api.setThreadClaudeSessionId(workspace.id, thread.id, sessionId);

        const sessionTitle =
          discovered.session.summary?.trim() ||
          discovered.session.firstPrompt?.trim() ||
          null;
        if (sessionTitle) {
          try {
            importedThread = await api.renameThread(workspace.id, importedThread.id, sessionTitle);
          } catch {
            // Non-fatal: thread was already created and linked successfully.
          }
        }

        applyThreadUpdate(importedThread);
        delete deletedThreadIdsRef.current[importedThread.id];
        impactedWorkspaceIds.add(workspace.id);
        importedThreads.push({ workspace, thread: importedThread });
      }

      await Promise.all(Array.from(impactedWorkspaceIds, (workspaceId) => refreshThreadsForWorkspace(workspaceId)));

      if (importedThreads.length === 1) {
        const [{ workspace, thread }] = importedThreads;
        if (selectedWorkspaceIdRef.current !== workspace.id) {
          setSelectedWorkspace(workspace.id);
        }
        setSelectedThread(thread.id);
        setTerminalFocusRequestId((current) => current + 1);
      }

      setBulkImportOpen(false);
      setSelectedBulkImportSessionIds([]);
      pushToast(
        importedThreads.length === 1
          ? 'Imported 1 Claude session.'
          : `Imported ${importedThreads.length} Claude sessions.`,
        'info'
      );
    } catch (error) {
      setBulkImportError(String(error));
    } finally {
      setBulkImporting(false);
    }
  }, [
    applyThreadUpdate,
    bulkImporting,
    discoveredImportableClaudeSessionsById,
    ensureLocalWorkspaceByPath,
    importedClaudeSessionIds,
    pushToast,
    refreshThreadsForWorkspace,
    selectedBulkImportSessionIds,
    settings.defaultNewThreadFullAccess,
    setSelectedThread,
    setSelectedWorkspace,
    workspaces
  ]);

  const installLatestUpdate = useCallback(async () => {
    if (installingUpdate) {
      return;
    }

    setInstallingUpdate(true);
    pushToast('Downloading and installing the latest ATController release…', 'info');
    try {
      await api.installLatestUpdate();
    } catch (error) {
      pushToast(`Update failed: ${String(error)}`, 'error');
    } finally {
      setInstallingUpdate(false);
    }
  }, [installingUpdate, pushToast]);

  const onRemoveWorkspace = useCallback(
    async (workspace: Workspace) => {
      const detail =
        isRemoteWorkspaceKind(workspace.kind)
          ? 'This removes its saved threads in ATController.'
          : 'This keeps your local folder intact but removes its saved threads in ATController.';
      const message = `Remove "${workspace.name}" from ATController?\n\n${detail}`;
      const confirmed = await confirm(message, {
        title: 'ATController',
        kind: 'warning',
        okLabel: 'OK',
        cancelLabel: 'Cancel'
      }).catch(() => window.confirm(message));
      if (!confirmed) {
        return;
      }

      const workspaceThreads = threadsByWorkspaceRef.current[workspace.id] ?? [];
      const threadIds = workspaceThreads.map((thread) => thread.id);
      const threadIdSet = new Set(threadIds);

      for (const threadId of threadIds) {
        invalidatePendingSessionStart(threadId);
        clearThreadWorkingStopTimer(threadId);
        stopThreadWorking(threadId);
      }
      await stopShellSessionForWorkspace(workspace.id, {
        closeDrawer: true,
        clearContent: true
      });
      await stopSessionsForWorkspace(workspace.id);

      const removed = await api.removeWorkspace(workspace.id);
      if (!removed) {
        pushToast(`Project "${workspace.name}" was already removed.`, 'info');
        await refreshWorkspaces();
        return;
      }

      window.localStorage.removeItem(threadSelectionKey(workspace.id));
      clearThreadUserInputTimestamps(threadIds);
      let removedAttentionState = false;
      let removedJsonlCompletionAttentionState = false;
      for (const threadId of threadIds) {
        delete deletedThreadIdsRef.current[threadId];
        delete startingSessionByThreadRef.current[threadId];
        delete pendingInputByThreadRef.current[threadId];
        delete pendingSkillClearByThreadRef.current[threadId];
        delete inputBufferByThreadRef.current[threadId];
        delete inputControlCarryByThreadRef.current[threadId];
        delete forkResolutionByThreadRef.current[threadId];
        delete forkResolutionTimeoutNotifiedByThreadRef.current[threadId];
        delete threadTitleInitializedRef.current[threadId];
        delete hiddenInjectedPromptsByThreadRef.current[threadId];
        delete outputControlCarryByThreadRef.current[threadId];
        delete sessionStartRequestIdByThreadRef.current[threadId];
        delete threadWorkspaceKindByThreadIdRef.current[threadId];
        delete draftAttachmentsByThreadRef.current[threadId];
        if (threadId in visibleOutputGuardByThreadRef.current) {
          delete visibleOutputGuardByThreadRef.current[threadId];
          visibleOutputGuardDirtyRef.current = true;
        }
        if (threadId in threadAttentionByThreadRef.current) {
          delete threadAttentionByThreadRef.current[threadId];
          removedAttentionState = true;
        }
        if (threadId in threadJsonlCompletionAttentionByThreadRef.current) {
          delete threadJsonlCompletionAttentionByThreadRef.current[threadId];
          removedJsonlCompletionAttentionState = true;
        }
        delete jsonlCompletionSeededSessionIdByThreadRef.current[threadId];
        delete jsonlCompletionReconcileRequestIdByThreadRef.current[threadId];
        delete lastMeaningfulOutputByThreadRef.current[threadId];
        delete lastSessionStartAtMsByThreadRef.current[threadId];
        delete lastUserInputAtMsByThreadRef.current[threadId];
        delete sessionFailCountByThreadRef.current[threadId];
        delete runLifecycleByThreadRef.current[threadId];
      }
      for (const [sessionId, meta] of Object.entries(sessionMetaBySessionIdRef.current)) {
        if (meta.workspaceId === workspace.id) {
          clearTerminalSessionTracking(sessionId);
        }
      }
      for (const [sessionId, pendingEvent] of Object.entries(pendingSshStartupAuthStatusBySessionIdRef.current)) {
        if (pendingEvent.workspaceId === workspace.id) {
          delete pendingSshStartupAuthStatusBySessionIdRef.current[sessionId];
        }
      }
      for (const [sessionId, mappedThreadId] of Object.entries(threadIdBySessionIdRef.current)) {
        if (threadIdSet.has(mappedThreadId)) {
          delete threadIdBySessionIdRef.current[sessionId];
        }
      }
      if (removedAttentionState) {
        threadAttentionDirtyRef.current = true;
      }
      if (removedJsonlCompletionAttentionState) {
        threadJsonlCompletionAttentionDirtyRef.current = true;
        setThreadJsonlCompletionAttentionVersion((current) => current + 1);
      }
      clearThreadTerminalStreams(threadIds);
      setDraftAttachmentsByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setSshStartupBlockedByThread((current) => {
        let next = current;
        for (const threadId of threadIds) {
          next = removeRecordEntry(next, threadId);
        }
        return next;
      });
      setSshStartupBlockedShellByWorkspace((current) => removeRecordEntry(current, workspace.id));
      setSshStartupBlockModal((current) =>
        current && current.workspaceId === workspace.id ? null : current
      );
      setResumeFailureBlockedByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setResumeFailureModal((current) =>
        current && current.workspaceId === workspace.id ? null : current
      );
      setStartingByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setReadyByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });
      setHasInteractedByThread((current) => {
        let changed = false;
        const next = { ...current };
        for (const threadId of threadIds) {
          if (!(threadId in next)) {
            continue;
          }
          delete next[threadId];
          changed = true;
        }
        return changed ? next : current;
      });

      if (threadIds.includes(selectedThreadIdRef.current ?? '')) {
        setSelectedThread(undefined);
      }

      await refreshWorkspaces();
      pushToast(`Removed project "${workspace.name}".`, 'info');
    },
    [
      clearThreadUserInputTimestamps,
      invalidatePendingSessionStart,
      pushToast,
      refreshWorkspaces,
      clearThreadWorkingStopTimer,
      setSelectedThread,
      setHasInteractedByThread,
      stopShellSessionForWorkspace,
      stopThreadWorking,
      stopSessionsForWorkspace,
      clearThreadTerminalStreams,
      clearTerminalSessionTracking
    ]
  );

  const getSearchTextForThread = useCallback((threadId: string) => {
    return lastTerminalLogByThreadRef.current[threadId] ?? '';
  }, []);


  const appShellStyle = useMemo(
    () =>
      ({
        '--sidebar-width': `${sidebarWidth}px`
      }) as CSSProperties,
    [sidebarWidth]
  );

  // Keep terminal callback refs in sync with the latest closures on every render.
  // The stable callbacks (stableTerminalOnData / stableTerminalOnResize) delegate
  // to these refs, so TerminalPanel receives identity-stable props while always
  // invoking the most recent handler logic.
  terminalOnDataHandlerRef.current = (data: string) => {
    if (!selectedThread) {
      return;
    }
    if (
      selectedWorkspace?.kind === 'ssh' &&
      (!isSelectedThreadReady || Boolean(selectedThreadSshStartupBlockReason))
    ) {
      return;
    }

    const parsed = extractSubmittedInputLines(
      inputBufferByThreadRef.current[selectedThread.id] ?? '',
      inputControlCarryByThreadRef.current[selectedThread.id] ?? '',
      data
    );
    inputBufferByThreadRef.current[selectedThread.id] = parsed.nextBuffer;
    inputControlCarryByThreadRef.current[selectedThread.id] = parsed.nextControlCarry;
    const submittedLines = parsed.submittedLines;
    const nativeForkCommand =
      selectedWorkspace && !isRemoteWorkspaceKind(selectedWorkspace.kind)
        ? detectNativeForkCommand(submittedLines)
        : null;

    if (
      submittedLines.length > 0 &&
      !nativeForkCommand &&
      isSelectedThreadReady &&
      isDefaultThreadTitle(selectedThread.title) &&
      !threadTitleInitializedRef.current[selectedThread.id]
    ) {
      const firstLine = submittedLines.map((line) => line.trim()).find((line) => line.length > 0);
      if (firstLine) {
        threadTitleInitializedRef.current[selectedThread.id] = true;
        void onRenameThread(selectedThread.workspaceId, selectedThread.id, firstLine.slice(0, 50));
      }
    }

    if (submittedLines.length > 0) {
      const submittedAtMs = Date.now();
      recordThreadVisibleOutput(
        selectedThread.id,
        true,
        submittedAtMs,
        lastTerminalLogByThreadRef.current[selectedThread.id] ?? ''
      );
      markThreadUserInput(selectedThread.workspaceId, selectedThread.id);
      lastUserInputAtMsByThreadRef.current[selectedThread.id] = submittedAtMs;
      sessionFailCountByThreadRef.current[selectedThread.id] = 0;
      setHasInteractedByThread((current) =>
        current[selectedThread.id] ? current : { ...current, [selectedThread.id]: true }
      );
      beginTurn(selectedThread.id);
    }

    if (submittedLines.length > 0) {
      const isObservedForkCommand = Boolean(nativeForkCommand);
      const attachmentDraft = isObservedForkCommand
        ? []
        : draftAttachmentsByThreadRef.current[selectedThread.id] ?? [];
      if (!isObservedForkCommand) {
        clearAttachmentDraftForThread(selectedThread.id);
      }
      const activeSkills = isObservedForkCommand ? [] : selectedInjectableSkills;

      // Determine the live session id now (before any async work).
      const sessionId = (!isSelectedThreadStarting && selectedSessionId)
        ? runStore.sessionForThread(selectedThread.id)
        : null;

      const skillPromptText = activeSkills.length > 0
        ? buildSkillPrompt(activeSkills)
        : '';
      if (skillPromptText) {
        if (selectedWorkspace) {
          setSkillUsageMap((current) =>
            recordSkillUsage(
              current,
              selectedWorkspace.path,
              activeSkills.map((skill) => skill.id)
            )
          );
        }
      }
      const shouldClearSkills = activeSkills.length > 0;

      const attachmentPromptText = attachmentDraft.length > 0
        ? buildAttachmentPrompt(attachmentDraft)
        : '';
      const hiddenPromptBlocks = [skillPromptText, attachmentPromptText]
        .filter((prompt): prompt is string => prompt.length > 0)
        .map((prompt) => `\n\n${prompt}`);
      for (const block of hiddenPromptBlocks) {
        registerHiddenInjectedPrompt(selectedThread.id, block);
      }

      void (async () => {
        const submitIndex = data.lastIndexOf('\r');
        const outboundData =
          hiddenPromptBlocks.length === 0
            ? data
            : submitIndex >= 0
              ? `${data.slice(0, submitIndex)}${hiddenPromptBlocks.join('')}${data.slice(submitIndex)}`
              : `${data}${hiddenPromptBlocks.join('')}`;

        if (isSelectedThreadStarting || !sessionId) {
          if (shouldClearSkills) {
            pendingSkillClearByThreadRef.current[selectedThread.id] = true;
          }
          pendingInputByThreadRef.current[selectedThread.id] =
            `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${outboundData}`;
          void ensureSessionForThread(selectedThread);
          return;
        }

        if (sessionId) {
            clearThreadWorkingStopTimer(selectedThread.id);
            startThreadWorking(selectedThread.id);
            scheduleThreadWorkingStop(selectedThread.id, THREAD_WORKING_STUCK_TIMEOUT_MS);
            let preparedNativeFork: PreparedNativeFork | null = null;
          if (nativeForkCommand && selectedWorkspace && !isRemoteWorkspaceKind(selectedWorkspace.kind)) {
            try {
              preparedNativeFork = await api.prepareThreadNativeFork(
                selectedThread.workspaceId,
                selectedThread.id,
                sessionId
              );
            } catch (error) {
              pushToast(`Fork tracking failed: ${String(error)}`, 'error');
            }
          }
          const wrote = await api.terminalWrite(sessionId, outboundData).catch(() => false);
          if (wrote && shouldClearSkills) {
            void clearThreadSkillsAfterSend(selectedThread.id);
          }
          if (wrote && preparedNativeFork) {
            suppressAutoForkResolutionByThreadRef.current[selectedThread.id] = true;
            try {
              const consumedThread = await api.commitPreparedThreadPendingFork(
                selectedThread.workspaceId,
                selectedThread.id,
                preparedNativeFork
              );
              applyThreadUpdate(consumedThread);
              const wsId = consumedThread.workspaceId;
              const wsThreads = threadsByWorkspaceRef.current[wsId] ?? [];
              threadsByWorkspaceRef.current = {
                ...threadsByWorkspaceRef.current,
                [wsId]: wsThreads.map(
                  (t) => (t.id === consumedThread.id ? consumedThread : t)
                ),
              };
              await refreshThreadsForWorkspace(consumedThread.workspaceId);
              delete suppressAutoForkResolutionByThreadRef.current[selectedThread.id];
              void resolvePendingThreadFork(selectedThread.id, { notifyOnTimeout: true });
            } catch (error) {
              delete suppressAutoForkResolutionByThreadRef.current[selectedThread.id];
              pushToast(`Fork tracking failed: ${String(error)}`, 'error');
            }
          }
          return;
        }

        // Session vanished between the start of onData and now.
        if (shouldClearSkills) {
          pendingSkillClearByThreadRef.current[selectedThread.id] = true;
        }
        pendingInputByThreadRef.current[selectedThread.id] =
          `${pendingInputByThreadRef.current[selectedThread.id] ?? ''}${outboundData}`;
        void ensureSessionForThread(selectedThread);
      })();

      return;
    }

    // No submitted lines — just forward raw keystrokes.
    const outboundData = data;

    if (isSelectedThreadStarting || !selectedSessionId) {
      return;
    }

    const sessionId = runStore.sessionForThread(selectedThread.id);
    if (sessionId) {
      void api.terminalWrite(sessionId, outboundData);
      return;
    }
  };

  terminalOnResizeHandlerRef.current = (cols: number, rows: number) => {
    setTerminalSize((current) =>
      current.cols === cols && current.rows === rows ? current : { cols, rows }
    );
    if (!selectedSessionId) {
      return;
    }
    scheduleTerminalResize(selectedSessionId, cols, rows);
  };

  return (
    <div className={isSidebarResizing ? 'app-shell sidebar-resizing' : 'app-shell'} style={appShellStyle}>
      <LeftRail
        sidebarWidth={sidebarWidth}
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedThreadId={selectedThreadId}
        threadSearch={threadSearch}
        defaultNewThreadFullAccess={settings.defaultNewThreadFullAccess === true}
        creatingThreadByWorkspace={creatingThreadByWorkspace}
        onOpenWorkspacePicker={openWorkspacePicker}
        onOpenSettings={openSettings}
        onNewThreadInWorkspace={onNewThreadInWorkspace}
        onThreadSearchChange={setThreadSearch}
        onSelectThread={selectThread}
        onRenameThread={onRenameThread}
        onDeleteThread={onDeleteThread}
        onOpenWorkspaceInFinder={openWorkspaceInFinder}
        onOpenWorkspaceInTerminal={openWorkspaceInTerminal}
        onSetWorkspaceGitPullOnMasterForNewThreads={onSetWorkspaceGitPullOnMasterForNewThreads}
        onReorderWorkspaces={onReorderWorkspaces}
        onRemoveWorkspace={onRemoveWorkspace}
        isThreadWorking={isThreadWorking}
        unreadCompletedTurnByThread={unreadCompletedTurnByThread}
        getThreadDisplayTimestampMs={threadStore.getThreadDisplayTimestampMs}
        getSearchTextForThread={getSearchTextForThread}
        onCopyResumeCommand={copyResumeCommand}
        onCopyWorkspaceCommand={copyWorkspaceCommand}
        onImportSession={onImportSession}
      />
      <div
        className="sidebar-resizer"
        data-testid="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={startSidebarResize}
        onMouseDown={startSidebarResizeWithMouse}
      />

      <main className={blockingError ? 'main-panel has-blocking-error' : 'main-panel'} data-testid="main-panel">
        <HeaderBar
          workspace={selectedWorkspace}
          selectedThread={selectedThread}
          gitInfo={gitInfo}
          updateAvailable={Boolean(appUpdateInfo?.updateAvailable)}
          updateVersionLabel={appUpdateInfo?.latestVersion ?? undefined}
          updating={installingUpdate}
          onInstallUpdate={installLatestUpdate}
          onOpenWorkspace={() => {
            if (selectedWorkspace) {
              openWorkspaceInFinder(selectedWorkspace);
            }
          }}
          onOpenTerminal={() => {
            toggleWorkspaceShellDrawer();
          }}
          terminalOpen={shellDrawerOpen}
        />

        {blockingError ? (
          <div className="blocking-error">
            <span>{blockingError}</span>
            <button type="button" className="ghost-button" onClick={() => setSettingsOpen(true)}>
              Open Settings
            </button>
          </div>
        ) : null}

        <section className="terminal-region">
          {selectedThread ? (
            <TerminalPanel
              key={selectedThread.id}
              sessionId={selectedSessionId}
              streamState={selectedTerminalRenderStream}
              contentLimitChars={TERMINAL_LOG_BUFFER_CHARS}
              readOnly={false}
              inputEnabled={
                Boolean(selectedSessionId) &&
                isSelectedThreadReady &&
                !isSelectedThreadStarting &&
                !selectedThreadSshStartupBlockReason
              }
              cursorVisible={false}
              overlayMessage={
                selectedThreadSshStartupBlockReason
                  ? sshStartupBlockOverlayMessage(selectedThreadSshStartupBlockReason)
                  : selectedThreadForkResolutionFailureBlocked
                  ? 'Forked session could not be confirmed. Start fresh to continue.'
                  : selectedThreadResumeFailureBlocked
                  ? 'Session resume failed. Start fresh to continue.'
                  : selectedStatefulHydrationFailedSessionId === selectedSessionId && Boolean(selectedSessionId)
                  ? 'Could not refresh Claude screen yet. Waiting for new output...'
                  : selectedStatefulHydrationSessionId === selectedSessionId && Boolean(selectedSessionId)
                  ? 'Refreshing Claude screen...'
                  : !selectedSessionId || (isSelectedThreadStarting && !hasSelectedTerminalContent)
                  ? 'Starting Claude session...'
                  : undefined
              }
              preferLiveRedrawOnMount={selectedTerminalPrefersLiveRedraw}
              focusRequestId={terminalFocusRequestId}
              searchToggleRequestId={terminalSearchToggleRequestId}
              onData={stableTerminalOnData}
              onResize={stableTerminalOnResize}
              onFocusChange={handleClaudeTerminalFocusChange}
              onStatefulRedrawRequest={requestSelectedStatefulTerminalRepair}
              onFollowOutputPausedChange={handleSelectedTerminalFollowPausedChange}
            />
          ) : (
            <div className="terminal-empty">Select a thread to start Claude.</div>
          )}
        </section>
        <BottomBar
          workspace={selectedWorkspace}
          selectedThread={selectedThread}
          skillsControl={
            selectedThread ? (
              <ThreadSkillsPopover
                workspace={selectedWorkspace}
                thread={selectedThread}
                skills={selectedWorkspaceSkills}
                loading={selectedWorkspaceSkillsLoading}
                error={selectedWorkspaceSkillError}
                usageMap={skillUsageMap}
                saving={skillsUpdating}
                onToggleSkill={toggleSelectedThreadSkill}
                onRemoveMissingSkill={removeMissingSelectedThreadSkill}
                onTogglePinned={togglePinnedSkillForSelectedWorkspace}
                onRefresh={async () => {
                  if (!selectedWorkspace) {
                    return;
                  }
                  await refreshSkillsForWorkspace(selectedWorkspace);
                }}
              />
            ) : null
          }
          attachmentDraftPaths={selectedThreadDraftAttachments}
          attachmentsEnabled={Boolean(selectedThread)}
          fullAccessUpdating={fullAccessUpdating}
          gitInfo={gitInfo}
          onPickAttachments={pickAttachmentFiles}
          onAddAttachmentPaths={addAttachmentPathsFromDrop}
          onRemoveAttachmentPath={removeSelectedThreadAttachmentPath}
          onClearAttachmentPaths={clearSelectedThreadAttachmentDraft}
          onToggleFullAccess={toggleFullAccess}
          fullAccessToggleBlockedReason={fullAccessToggleBlockedReason}
          onLoadBranchSwitcher={onLoadBranchSwitcher}
          onCheckoutBranch={onCheckoutBranch}
        />
        <WorkspaceShellDrawer
          open={shellDrawerOpen}
          workspace={selectedWorkspace}
          sessionId={shellTerminalSessionId}
          streamState={shellTerminalStream}
          height={shellDrawerHeight}
          starting={shellTerminalStarting}
          blockedMessage={
            selectedShellSshStartupBlockReason
              ? sshStartupBlockOverlayMessage(selectedShellSshStartupBlockReason)
              : undefined
          }
          focusRequestId={shellTerminalFocusRequestId}
          searchToggleRequestId={shellTerminalSearchToggleRequestId}
          onClose={closeWorkspaceShellDrawer}
          onStartResize={beginShellDrawerResize}
          onOpenInTerminal={popOutWorkspaceShellToTerminal}
          onData={handleShellTerminalData}
          onResize={handleShellTerminalResize}
          onFocusChange={handleShellTerminalFocusChange}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        initialCliPath={settings.claudeCliPath ?? ''}
        initialAppearanceMode={normalizeAppearanceMode(settings.appearanceMode)}
        initialDefaultNewThreadFullAccess={settings.defaultNewThreadFullAccess === true}
        initialTaskCompletionAlerts={settings.taskCompletionAlerts === true}
        detectedCliPath={detectedCliPath}
        copyEnvDiagnosticsDisabled={!selectedWorkspace || selectedWorkspace.kind !== 'local'}
        onClose={() => setSettingsOpen(false)}
        onSave={(nextSettings) => void saveSettings(nextSettings)}
        onCopyEnvDiagnostics={() => void copyEnvDiagnostics()}
        onSendTestAlert={() => void sendTestAlert()}
      />

      <AddWorkspaceModal
        open={addWorkspaceOpen}
        initialMode={addWorkspaceMode}
        initialPath={addWorkspacePath}
        initialRdevCommand={addWorkspaceRdevCommand}
        initialSshCommand={addWorkspaceSshCommand}
        initialSshRemotePath={addWorkspaceSshRemotePath}
        initialDisplayName={addWorkspaceDisplayName}
        error={addWorkspaceError}
        saving={addingWorkspace}
        onClose={() => {
          setAddWorkspaceOpen(false);
          setAddWorkspaceError(null);
          setAddWorkspaceRdevCommand('');
          setAddWorkspaceSshCommand('');
          setAddWorkspaceSshRemotePath('');
        }}
        onPickDirectory={() => void pickWorkspaceDirectory()}
        onConfirmLocal={(path) => void confirmManualWorkspace(path)}
        onConfirmRdev={(command, displayName) => void confirmRdevWorkspace(command, displayName)}
        onConfirmSsh={(command, displayName, remotePath) =>
          void confirmSshWorkspace(command, displayName, remotePath)
        }
        onOpenBulkImport={openBulkImportModal}
      />

      <ImportSessionModal
        open={Boolean(importSessionWorkspace)}
        workspaceName={importSessionWorkspace?.name ?? ''}
        error={importSessionError}
        saving={importingSession}
        onClose={() => {
          setImportSessionWorkspace(null);
          setImportSessionError(null);
        }}
        onConfirm={(claudeSessionId) => void confirmImportSession(claudeSessionId)}
      />

      <BulkImportClaudeSessionsModal
        open={bulkImportOpen}
        loading={bulkImportLoading}
        importing={bulkImporting}
        projects={discoveredImportableClaudeProjects}
        selectedSessionIds={selectedBulkImportSessionIds}
        alreadyImportedSessionIds={importedClaudeSessionIds}
        error={bulkImportError}
        onClose={closeBulkImportModal}
        onToggleSession={toggleBulkImportSessionSelection}
        onToggleProject={toggleBulkImportProjectSelection}
        onImport={() => void confirmBulkImportClaudeSessions()}
      />

      {resumeFailureModal ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h3>Failed to resume session. Start fresh?</h3>
            <p>Claude could not resume this thread&apos;s saved session id.</p>
            {resumeFailureModal.showLog ? <pre>{resumeFailureModal.log || '(No logs captured)'}</pre> : null}
            <footer className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  clearResumeFailureBlock(resumeFailureModal.threadId);
                  sessionFailCountByThreadRef.current[resumeFailureModal.threadId] = 0;
                  setResumeFailureModal(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setResumeFailureModal((current) =>
                    current
                      ? {
                          ...current,
                          showLog: !current.showLog
                        }
                      : null
                  );
                }}
              >
                View logs
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const thread = (threadsByWorkspace[resumeFailureModal.workspaceId] ?? []).find(
                    (item) => item.id === resumeFailureModal.threadId
                  );
                  if (thread) {
                    void onStartFreshThreadSession(thread);
                  } else {
                    pushToast('Unable to locate thread metadata for fresh restart.', 'error');
                  }
                  setResumeFailureModal(null);
                }}
              >
                Start fresh
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {forkResolutionFailureModal ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h3>Failed to confirm forked session. Start fresh?</h3>
            <p>ATController could not confirm the child session for this forked thread.</p>
            <footer className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setForkResolutionFailureModal(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const thread = (threadsByWorkspace[forkResolutionFailureModal.workspaceId] ?? []).find(
                    (item) => item.id === forkResolutionFailureModal.threadId
                  );
                  if (thread) {
                    void onStartFreshThreadSession(thread);
                  } else {
                    pushToast('Unable to locate thread metadata for fresh restart.', 'error');
                  }
                  setForkResolutionFailureModal(null);
                }}
              >
                Start fresh
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {sshStartupBlockModal ? (
        <div className="modal-backdrop">
          <section className="modal">
            <h3>{sshStartupBlockHeading(sshStartupBlockModal.reason)}</h3>
            <p>{sshStartupBlockBody(sshStartupBlockModal.reason)}</p>
            <p className="muted">
              ATController only supports key-based SSH here. Expected macOS SSH config:{' '}
              <code>AddKeysToAgent yes</code> <code>UseKeychain yes</code>
            </p>
            <footer className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  dismissSshStartupBlockModal(sshStartupBlockModal);
                }}
              >
                Close
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void retryBlockedSshStartup(sshStartupBlockModal).catch((error) => {
                    pushToast(String(error), 'error');
                  });
                }}
              >
                Retry
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <ToastRegion toasts={toasts} />
    </div>
  );
}
