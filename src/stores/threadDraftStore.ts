import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

/**
 * Draft text changes far more often than the rest of ATController's persisted
 * thread metadata. Keeping them in a narrow external store lets only the
 * active composer rerender while a user types.
 */
export class ThreadDraftStore {
  private drafts = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();

  get(threadId: string): string | undefined {
    return this.drafts.get(threadId);
  }

  set(threadId: string, value: string) {
    if (this.drafts.get(threadId) === value && this.drafts.has(threadId)) return;
    this.drafts.set(threadId, value);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }

  delete(threadId: string) {
    if (!this.drafts.delete(threadId)) return;
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }

  clear() {
    const changedThreadIds = [...this.drafts.keys()];
    this.drafts.clear();
    for (const threadId of changedThreadIds) {
      for (const listener of this.listeners.get(threadId) ?? []) listener();
    }
  }

  subscribe(threadId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }
}

export const threadDraftStore = new ThreadDraftStore();

export function useThreadDraft(threadId: string, persistedDraft: string): string {
  const subscribe = useCallback(
    (listener: Listener) => threadDraftStore.subscribe(threadId, listener),
    [threadId]
  );
  const getSnapshot = useCallback(
    () => threadDraftStore.get(threadId) ?? persistedDraft,
    [persistedDraft, threadId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
