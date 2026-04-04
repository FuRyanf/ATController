import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import type { CreateThreadOptions, RunStatus, ThreadMetadata } from '../types';

const LAST_USER_INPUT_AT_STORAGE_KEY = 'atcontroller:last-user-input-at';

function parseIsoTimestampMs(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseThreadTimestampMap(raw: string | null): Record<string, number> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, number> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId) {
        continue;
      }
      const timestamp = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        continue;
      }
      normalized[threadId] = Math.trunc(timestamp);
    }
    return normalized;
  } catch {
    return {};
  }
}

function loadThreadTimestampMap(storageKey: string): Record<string, number> {
  if (typeof window === 'undefined') {
    return {};
  }
  return parseThreadTimestampMap(window.localStorage.getItem(storageKey));
}

function persistThreadTimestampMap(storageKey: string, map: Record<string, number>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const entries = Object.entries(map).filter(([, value]) => Number.isFinite(value) && value > 0);
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best effort
  }
}

function threadActivityTimestampMs(thread: ThreadMetadata): number {
  // Only use lastRunEndedAt (Claude finished) and createdAt (new-thread fallback).
  // updatedAt and lastRunStartedAt are set on every session start (every click), so
  // including them would bump sort order on mere thread selection with no real work done.
  return Math.max(
    parseIsoTimestampMs(thread.lastRunEndedAt),
    parseIsoTimestampMs(thread.createdAt)
  );
}

function sortThreads(threads: ThreadMetadata[], lastUserInputAtByThread: Record<string, number>): ThreadMetadata[] {
  return [...threads].sort((a, b) => {
    const aActivity = threadActivityTimestampMs(a);
    const bActivity = threadActivityTimestampMs(b);
    const aInputOverride = Number.isFinite(lastUserInputAtByThread[a.id]) ? lastUserInputAtByThread[a.id] : 0;
    const bInputOverride = Number.isFinite(lastUserInputAtByThread[b.id]) ? lastUserInputAtByThread[b.id] : 0;
    const aSortTimestamp = Math.max(aActivity, aInputOverride);
    const bSortTimestamp = Math.max(bActivity, bInputOverride);

    if (aSortTimestamp !== bSortTimestamp) {
      return bSortTimestamp - aSortTimestamp;
    }

    if (aActivity !== bActivity) {
      return bActivity - aActivity;
    }

    return a.id.localeCompare(b.id);
  });
}

function upsertThread(
  map: Record<string, ThreadMetadata[]>,
  lastUserInputAtByThread: Record<string, number>,
  thread?: ThreadMetadata | null
) {
  if (!thread || !thread.id || !thread.workspaceId) {
    return map;
  }

  const existing = map[thread.workspaceId] ?? [];
  if (thread.isArchived) {
    return {
      ...map,
      [thread.workspaceId]: existing.filter((item) => item.id !== thread.id)
    };
  }

  const filtered = existing.filter((item) => item.id !== thread.id);
  return {
    ...map,
    [thread.workspaceId]: sortThreads([thread, ...filtered], lastUserInputAtByThread)
  };
}

export interface ThreadStore {
  threadsByWorkspace: Record<string, ThreadMetadata[]>;
  selectedWorkspaceId?: string;
  selectedThreadId?: string;
  listThreads: (workspaceId: string) => Promise<ThreadMetadata[]>;
  createThread: (workspaceId: string, options?: CreateThreadOptions) => Promise<ThreadMetadata>;
  setThreadFullAccess: (workspaceId: string, threadId: string, fullAccess: boolean) => Promise<ThreadMetadata>;
  setThreadSkills: (workspaceId: string, threadId: string, enabledSkills: string[]) => Promise<ThreadMetadata>;
  renameThread: (workspaceId: string, threadId: string, title: string) => Promise<ThreadMetadata>;
  archiveThread: (workspaceId: string, threadId: string) => Promise<void>;
  deleteThread: (workspaceId: string, threadId: string) => Promise<void>;
  setSelectedWorkspace: (workspaceId?: string) => void;
  setSelectedThread: (threadId?: string) => void;
  setThreadRunState: (
    threadId: string,
    status: RunStatus,
    startedAt?: string | null,
    endedAt?: string | null
  ) => void;
  applyThreadUpdate: (thread: ThreadMetadata) => void;
  setThreadLastOutputAt: (threadId: string, timestampMs?: number) => void;
  clearThreadLastOutputAt: (threadId: string) => void;
  threadLastOutputAt: (threadId?: string) => number | null;
  subscribeThreadOutput: (listener: (threadId: string) => void) => () => void;
  markThreadUserInput: (workspaceId: string, threadId: string, timestampMs?: number) => void;
  clearThreadUserInputTimestamps: (threadIds: string[]) => void;
  getThreadDisplayTimestampMs: (thread: ThreadMetadata) => number;
}

export function useThreadStore(): ThreadStore {
  const [threadsByWorkspace, setThreadsByWorkspace] = useState<Record<string, ThreadMetadata[]>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const listRequestIdByWorkspaceRef = useRef<Record<string, number>>({});
  const removedThreadIdsRef = useRef<Record<string, true>>({});
  const lastOutputAtByThreadRef = useRef<Record<string, number>>({});
  const lastUserInputAtByThreadRef = useRef<Record<string, number>>(
    loadThreadTimestampMap(LAST_USER_INPUT_AT_STORAGE_KEY)
  );
  const threadOutputListenersRef = useRef(new Set<(threadId: string) => void>());

  const listThreads = useCallback(async (workspaceId: string) => {
    const requestId = (listRequestIdByWorkspaceRef.current[workspaceId] ?? 0) + 1;
    listRequestIdByWorkspaceRef.current[workspaceId] = requestId;
    const threads = await api.listThreads(workspaceId);
    const visibleThreads = threads.filter((thread) => !removedThreadIdsRef.current[thread.id]);
    const sortedVisibleThreads = sortThreads(visibleThreads, lastUserInputAtByThreadRef.current);
    if (listRequestIdByWorkspaceRef.current[workspaceId] !== requestId) {
      return sortedVisibleThreads;
    }
    setThreadsByWorkspace((current) => ({
      ...current,
      [workspaceId]: sortedVisibleThreads
    }));
    return sortedVisibleThreads;
  }, []);

  const createThread = useCallback(async (workspaceId: string, options?: CreateThreadOptions) => {
    const thread =
      options?.fullAccess === true
        ? await api.createThread(workspaceId, 'claude-code', true)
        : await api.createThread(workspaceId, 'claude-code');
    delete removedThreadIdsRef.current[thread.id];
    setThreadsByWorkspace((current) => upsertThread(current, lastUserInputAtByThreadRef.current, thread));
    setSelectedThreadId(thread.id);
    return thread;
  }, []);

  const setThreadFullAccess = useCallback(async (workspaceId: string, threadId: string, fullAccess: boolean) => {
    const thread = await api.setThreadFullAccess(workspaceId, threadId, fullAccess);
    setThreadsByWorkspace((current) => upsertThread(current, lastUserInputAtByThreadRef.current, thread));
    return thread;
  }, []);

  const setThreadSkills = useCallback(async (workspaceId: string, threadId: string, enabledSkills: string[]) => {
    const thread = await api.setThreadSkills(workspaceId, threadId, enabledSkills);
    setThreadsByWorkspace((current) => upsertThread(current, lastUserInputAtByThreadRef.current, thread));
    return thread;
  }, []);

  const renameThread = useCallback(async (workspaceId: string, threadId: string, title: string) => {
    const thread = await api.renameThread(workspaceId, threadId, title);
    setThreadsByWorkspace((current) => upsertThread(current, lastUserInputAtByThreadRef.current, thread));
    return thread;
  }, []);

  const archiveThread = useCallback(async (workspaceId: string, threadId: string) => {
    removedThreadIdsRef.current[threadId] = true;
    try {
      await api.archiveThread(workspaceId, threadId);
    } catch (error) {
      delete removedThreadIdsRef.current[threadId];
      throw error;
    }
    setThreadsByWorkspace((current) => {
      const existing = current[workspaceId] ?? [];
      return {
        ...current,
        [workspaceId]: existing.filter((thread) => thread.id !== threadId)
      };
    });
    delete lastOutputAtByThreadRef.current[threadId];
    if (threadId in lastUserInputAtByThreadRef.current) {
      const next = { ...lastUserInputAtByThreadRef.current };
      delete next[threadId];
      lastUserInputAtByThreadRef.current = next;
      persistThreadTimestampMap(LAST_USER_INPUT_AT_STORAGE_KEY, next);
    }
  }, []);

  const deleteThread = useCallback(async (workspaceId: string, threadId: string) => {
    removedThreadIdsRef.current[threadId] = true;
    try {
      await api.deleteThread(workspaceId, threadId);
    } catch (error) {
      delete removedThreadIdsRef.current[threadId];
      throw error;
    }
    setThreadsByWorkspace((current) => {
      const existing = current[workspaceId] ?? [];
      return {
        ...current,
        [workspaceId]: existing.filter((thread) => thread.id !== threadId)
      };
    });
    delete lastOutputAtByThreadRef.current[threadId];
    if (threadId in lastUserInputAtByThreadRef.current) {
      const next = { ...lastUserInputAtByThreadRef.current };
      delete next[threadId];
      lastUserInputAtByThreadRef.current = next;
      persistThreadTimestampMap(LAST_USER_INPUT_AT_STORAGE_KEY, next);
    }
  }, []);

  const applyThreadUpdate = useCallback((thread: ThreadMetadata) => {
    if (removedThreadIdsRef.current[thread.id]) {
      return;
    }
    setThreadsByWorkspace((current) => upsertThread(current, lastUserInputAtByThreadRef.current, thread));
  }, []);

  const setThreadRunState = useCallback(
    (threadId: string, status: RunStatus, startedAt?: string | null, endedAt?: string | null) => {
      setThreadsByWorkspace((current) => {
        let anyChanged = false;
        const next: Record<string, ThreadMetadata[]> = {};
        for (const [workspaceId, threads] of Object.entries(current)) {
          let workspaceChanged = false;
          const updatedThreads = threads.map((thread) => {
            if (thread.id !== threadId) {
              return thread;
            }
            workspaceChanged = true;
            anyChanged = true;

            return {
              ...thread,
              lastRunStatus: status,
              lastRunStartedAt: startedAt ?? thread.lastRunStartedAt,
              lastRunEndedAt: endedAt ?? thread.lastRunEndedAt,
              updatedAt: new Date().toISOString()
            };
          });
          next[workspaceId] = workspaceChanged
            ? sortThreads(updatedThreads, lastUserInputAtByThreadRef.current)
            : updatedThreads;
        }
        if (!anyChanged) {
          return current;
        }
        return next;
      });
    },
    []
  );

  const setThreadLastOutputAt = useCallback((threadId: string, timestampMs = Date.now()) => {
    if (!threadId) {
      return;
    }
    const current = lastOutputAtByThreadRef.current[threadId];
    if (current === timestampMs) {
      return;
    }
    lastOutputAtByThreadRef.current[threadId] = timestampMs;
    for (const listener of threadOutputListenersRef.current) {
      listener(threadId);
    }
  }, []);

  const clearThreadLastOutputAt = useCallback((threadId: string) => {
    if (!threadId || !(threadId in lastOutputAtByThreadRef.current)) {
      return;
    }
    delete lastOutputAtByThreadRef.current[threadId];
    for (const listener of threadOutputListenersRef.current) {
      listener(threadId);
    }
  }, []);

  const threadLastOutputAt = useCallback((threadId?: string) => {
    if (!threadId) {
      return null;
    }
    return lastOutputAtByThreadRef.current[threadId] ?? null;
  }, []);

  const subscribeThreadOutput = useCallback((listener: (threadId: string) => void) => {
    threadOutputListenersRef.current.add(listener);
    return () => {
      threadOutputListenersRef.current.delete(listener);
    };
  }, []);

  const markThreadUserInput = useCallback((workspaceId: string, threadId: string, timestampMs = Date.now()) => {
    if (!workspaceId || !threadId) {
      return;
    }

    if (lastUserInputAtByThreadRef.current[threadId] === timestampMs) {
      return;
    }

    const next = {
      ...lastUserInputAtByThreadRef.current,
      [threadId]: timestampMs
    };
    lastUserInputAtByThreadRef.current = next;
    persistThreadTimestampMap(LAST_USER_INPUT_AT_STORAGE_KEY, next);

    setThreadsByWorkspace((threadsCurrent) => {
      const workspaceThreads = threadsCurrent[workspaceId];
      if (!workspaceThreads) {
        return threadsCurrent;
      }
      return {
        ...threadsCurrent,
        [workspaceId]: sortThreads(workspaceThreads, next)
      };
    });
  }, []);

  const clearThreadUserInputTimestamps = useCallback((threadIds: string[]) => {
    if (!threadIds || threadIds.length === 0) {
      return;
    }
    let changed = false;
    const next = { ...lastUserInputAtByThreadRef.current };
    for (const threadId of threadIds) {
      if (!threadId || !(threadId in next)) {
        continue;
      }
      delete next[threadId];
      changed = true;
    }
    if (!changed) {
      return;
    }
    lastUserInputAtByThreadRef.current = next;
    persistThreadTimestampMap(LAST_USER_INPUT_AT_STORAGE_KEY, next);
  }, []);

  const getThreadDisplayTimestampMs = useCallback((thread: ThreadMetadata): number => {
    // Exclude updatedAt/lastRunStartedAt — both can change for non-activity metadata/session churn.
    // lastUserInputAtByThreadRef is persisted in localStorage so recency survives app relaunch.
    const lastRunEndedMs = parseIsoTimestampMs(thread.lastRunEndedAt);
    const createdAtMs = parseIsoTimestampMs(thread.createdAt);
    const inputOverride = lastUserInputAtByThreadRef.current[thread.id] ?? 0;
    return Math.max(lastRunEndedMs, createdAtMs, inputOverride);
  }, []);

  return useMemo(
    () => ({
      threadsByWorkspace,
      selectedWorkspaceId,
      selectedThreadId,
      listThreads,
      createThread,
      setThreadFullAccess,
      setThreadSkills,
      renameThread,
      archiveThread,
      deleteThread,
      setSelectedWorkspace: setSelectedWorkspaceId,
      setSelectedThread: setSelectedThreadId,
      setThreadRunState,
      applyThreadUpdate,
      setThreadLastOutputAt,
      clearThreadLastOutputAt,
      threadLastOutputAt,
      subscribeThreadOutput,
      markThreadUserInput,
      clearThreadUserInputTimestamps,
      getThreadDisplayTimestampMs
    }),
    [
      applyThreadUpdate,
      clearThreadLastOutputAt,
      createThread,
      setThreadFullAccess,
      setThreadSkills,
      listThreads,
      renameThread,
      archiveThread,
      deleteThread,
      selectedThreadId,
      selectedWorkspaceId,
      setThreadLastOutputAt,
      setThreadRunState,
      subscribeThreadOutput,
      markThreadUserInput,
      clearThreadUserInputTimestamps,
      getThreadDisplayTimestampMs,
      threadLastOutputAt,
      threadsByWorkspace
    ]
  );
}
