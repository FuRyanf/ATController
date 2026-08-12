// A dormant subscription can retain a full set of configured MCP processes.
// Keep only selected and actively running threads warm; reopening an idle
// thread is cheaper than carrying its browser and plugin processes forever.
export const MAX_RETAINED_IDLE_SESSIONS = 0;

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
