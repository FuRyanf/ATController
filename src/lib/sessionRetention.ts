// A dormant subscription can retain a full set of configured MCP processes.
// Keep only selected and actively running threads warm; reopening an idle
// thread is cheaper than carrying its browser and plugin processes forever.
export const MAX_RETAINED_IDLE_SESSIONS = 0;

/**
 * Codex allows only one live turn per thread. Historical rollouts can contain
 * an unterminated turn after a crash or forced shutdown, so scanning every
 * turn for `inProgress` can keep an otherwise idle subscription (and its MCP
 * processes) alive forever. Only the latest turn describes current activity.
 */
export function currentRunningTurn<T extends { status: string }>(
  thread?: { turns: T[] }
): T | undefined {
  if (!thread?.turns.length) return undefined;
  const latest = thread.turns[thread.turns.length - 1];
  return latest.status === 'inProgress' ? latest : undefined;
}

export function isThreadRunning(
  thread?: { status?: string; turns: Array<{ status: string }> }
): boolean {
  return thread?.status === 'active' || Boolean(currentRunningTurn(thread));
}

/**
 * A turn completion can arrive before the thread's later `idle` status. Run
 * retention for both lifecycle edges so that race cannot pin a completed,
 * non-selected thread and its MCP processes indefinitely.
 */
export function shouldSweepSessionRetention(
  eventKind: string,
  status?: string | null
): boolean {
  return (
    eventKind === 'turnCompleted' ||
    (eventKind === 'threadStatusChanged' && status === 'idle')
  );
}

export interface SessionRetentionInput {
  sessionThreadIds: string[];
  activeThreadId: string | null;
  runningThreadIds: ReadonlySet<string>;
  lastUsedAt: Readonly<Record<string, number>>;
  maxIdleSessions?: number;
}

/**
 * Returns oldest idle sessions that can be safely unsubscribed. The selected
 * thread and every running turn are always retained, so concurrent work keeps
 * streaming while dormant MCP stacks are allowed to age out.
 */
export function idleSessionsToRelease({
  sessionThreadIds,
  activeThreadId,
  runningThreadIds,
  lastUsedAt,
  maxIdleSessions = MAX_RETAINED_IDLE_SESSIONS
}: SessionRetentionInput): string[] {
  const idle = sessionThreadIds
    .filter(
      (threadId) =>
        threadId !== activeThreadId && !runningThreadIds.has(threadId)
    )
    .sort(
      (left, right) =>
        (lastUsedAt[left] ?? 0) - (lastUsedAt[right] ?? 0)
    );
  return idle.slice(0, Math.max(0, idle.length - Math.max(0, maxIdleSessions)));
}
