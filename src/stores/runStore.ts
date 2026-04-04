import { useMemo, useState } from 'react';

interface ActiveThreadRun {
  threadId: string;
  sessionId: string;
  startedAt: string;
}

interface WorkingThreadState {
  startedAt: string;
}

export interface RunStore {
  activeRunsByThread: Record<string, ActiveThreadRun>;
  workingByThread: Record<string, WorkingThreadState>;
  bindSession: (threadId: string, sessionId: string, startedAt?: string) => void;
  finishSession: (sessionId: string) => string | null;
  sessionForThread: (threadId?: string) => string | null;
  startWorking: (threadId: string, startedAt?: string) => void;
  stopWorking: (threadId: string) => void;
  isThreadWorking: (threadId?: string) => boolean;
  workingStartedAtForThread: (threadId?: string) => string | null;
}

export function useRunStore(): RunStore {
  const [activeRunsByThread, setActiveRunsByThread] = useState<Record<string, ActiveThreadRun>>({});
  const [workingByThread, setWorkingByThread] = useState<Record<string, WorkingThreadState>>({});

  return useMemo(
    () => ({
      activeRunsByThread,
      workingByThread,
      bindSession: (threadId: string, sessionId: string, startedAt = new Date().toISOString()) => {
        setActiveRunsByThread((current) => ({
          ...current,
          [threadId]: {
            threadId,
            sessionId,
            startedAt
          }
        }));
      },
      finishSession: (sessionId: string) => {
        let removedThreadId: string | null = null;
        setActiveRunsByThread((current) => {
          const next: Record<string, ActiveThreadRun> = {};
          for (const [threadId, run] of Object.entries(current)) {
            if (run.sessionId === sessionId) {
              removedThreadId = threadId;
              continue;
            }
            next[threadId] = run;
          }
          return next;
        });
        if (removedThreadId) {
          setWorkingByThread((current) => {
            const next = { ...current };
            delete next[removedThreadId as string];
            return next;
          });
        }
        return removedThreadId;
      },
      sessionForThread: (threadId?: string) => {
        if (!threadId) {
          return null;
        }
        return activeRunsByThread[threadId]?.sessionId ?? null;
      },
      startWorking: (threadId: string, startedAt = new Date().toISOString()) => {
        setWorkingByThread((current) => {
          if (current[threadId]) {
            return current;
          }
          return {
            ...current,
            [threadId]: { startedAt }
          };
        });
      },
      stopWorking: (threadId: string) => {
        setWorkingByThread((current) => {
          if (!current[threadId]) {
            return current;
          }
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      },
      isThreadWorking: (threadId?: string) => {
        if (!threadId) {
          return false;
        }
        return Boolean(workingByThread[threadId]);
      },
      workingStartedAtForThread: (threadId?: string) => {
        if (!threadId) {
          return null;
        }
        return workingByThread[threadId]?.startedAt ?? null;
      }
    }),
    [activeRunsByThread, workingByThread]
  );
}
