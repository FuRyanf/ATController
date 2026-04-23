import type { TerminalSessionStreamState } from './terminalSessionStream';

export interface TerminalStreamCacheEntry {
  threadId: string;
  stream: TerminalSessionStreamState;
  lastAccessedAtMs: number;
  isProtected: boolean;
}

export interface TerminalStreamCacheLimits {
  maxThreads: number;
  maxChars: number;
}

export function estimateTerminalStreamCacheChars(stream: TerminalSessionStreamState): number {
  return stream.text.length + stream.chunks.reduce((total, chunk) => total + chunk.data.length, 0);
}

export function selectTerminalStreamCacheEvictions(
  entries: TerminalStreamCacheEntry[],
  limits: TerminalStreamCacheLimits
): string[] {
  const maxThreads = Math.max(0, Math.floor(limits.maxThreads));
  const maxChars = Math.max(0, Math.floor(limits.maxChars));
  const retained = entries.map((entry) => ({
    ...entry,
    estimatedChars: estimateTerminalStreamCacheChars(entry.stream)
  }));
  const evictionCandidates = retained
    .filter((entry) => !entry.isProtected)
    .sort((left, right) => {
      if (left.lastAccessedAtMs !== right.lastAccessedAtMs) {
        return left.lastAccessedAtMs - right.lastAccessedAtMs;
      }
      return left.threadId.localeCompare(right.threadId);
    });

  const evicted = new Set<string>();
  let retainedCount = retained.length;
  let retainedChars = retained.reduce((total, entry) => total + entry.estimatedChars, 0);

  for (const entry of evictionCandidates) {
    if (retainedCount <= maxThreads && retainedChars <= maxChars) {
      break;
    }
    evicted.add(entry.threadId);
    retainedCount -= 1;
    retainedChars = Math.max(0, retainedChars - entry.estimatedChars);
  }

  return Array.from(evicted);
}
