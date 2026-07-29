import { useSyncExternalStore } from 'react';

import type {
  CodexApprovalRequest,
  CodexDiagnostics,
  CodexEvent,
  CodexItem,
  CodexThread,
  CodexThreadSession,
  CodexTokenUsage,
  CodexTurn
} from '../types';

export interface CodexStoreSnapshot {
  threads: Readonly<Record<string, CodexThread>>;
  sessions: Readonly<Record<string, CodexThreadSession>>;
  approvals: Readonly<Record<string, CodexApprovalRequest>>;
  usage: Readonly<Record<string, CodexTokenUsage>>;
  activeThreadId: string | null;
  diagnostics: CodexDiagnostics | null;
  lastSequence: number;
  unseenEvents: number;
}

type Listener = () => void;
const MAX_EVENTS_PER_FRAME = 2_048;
const MAX_RENDERED_COMMAND_OUTPUT_CHARACTERS = 1_000_000;
const OUTPUT_TRUNCATION_MARKER = '[Earlier command output truncated]\n';

const EMPTY_SNAPSHOT: CodexStoreSnapshot = {
  threads: {},
  sessions: {},
  approvals: {},
  usage: {},
  activeThreadId: null,
  diagnostics: null,
  lastSequence: 0,
  unseenEvents: 0
};

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function approvalKey(requestId: string | number): string {
  return String(requestId);
}

function emptyTurn(id: string): CodexTurn {
  return {
    id,
    status: 'inProgress',
    items: [],
    itemsView: 'full'
  };
}

function boundedCommandOutput(value: string | null | undefined): string | undefined {
  if (value == null || value.length <= MAX_RENDERED_COMMAND_OUTPUT_CHARACTERS) {
    return value ?? undefined;
  }
  return `${OUTPUT_TRUNCATION_MARKER}${value.slice(
    -MAX_RENDERED_COMMAND_OUTPUT_CHARACTERS
  )}`;
}

function boundedItem(item: CodexItem): CodexItem {
  return item.output != null
    ? { ...item, output: boundedCommandOutput(item.output) }
    : item;
}

function mergeItem(existing: CodexItem | undefined, incoming: CodexItem): CodexItem {
  if (!existing) {
    return boundedItem(incoming);
  }
  return {
    ...existing,
    ...incoming,
    text: incoming.text ?? existing.text,
    output: boundedCommandOutput(incoming.output ?? existing.output),
    summary: incoming.summary.length > 0 ? incoming.summary : existing.summary,
    reasoning: incoming.reasoning.length > 0 ? incoming.reasoning : existing.reasoning,
    content: incoming.content.length > 0 ? incoming.content : existing.content,
    changes: incoming.changes.length > 0 ? incoming.changes : existing.changes,
    details: incoming.details ?? existing.details
  };
}

function upsertItem(turn: CodexTurn, item: CodexItem): CodexTurn {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    return { ...turn, items: [...turn.items, boundedItem(item)] };
  }
  const items = [...turn.items];
  items[index] = mergeItem(items[index], item);
  return { ...turn, items };
}

function appendItemDelta(turn: CodexTurn, event: CodexEvent): CodexTurn {
  if (!event.itemId || event.delta == null) {
    return turn;
  }
  let index = turn.items.findIndex((item) => item.id === event.itemId);
  let items = turn.items;
  if (index < 0) {
    const kind =
      event.kind === 'commandOutputDelta'
        ? 'commandExecution'
        : event.kind.startsWith('reasoning')
          ? 'reasoning'
          : event.kind === 'planDelta'
            ? 'plan'
            : event.method.startsWith('item/fileChange/')
              ? 'fileChange'
              : 'agentMessage';
    items = [
      ...turn.items,
      {
        id: event.itemId,
        kind,
        summary: [],
        reasoning: [],
        content: [],
        changes: []
      }
    ];
    index = items.length - 1;
  } else {
    items = [...items];
  }

  const item = { ...items[index] };
  if (event.kind === 'commandOutputDelta') {
    item.output = boundedCommandOutput(`${item.output ?? ''}${event.delta}`);
  } else if (event.kind === 'reasoningSummaryPartAdded') {
    item.summary = [...item.summary, ''];
  } else if (event.kind === 'reasoningSummaryDelta') {
    const summary = [...item.summary];
    if (summary.length === 0) {
      summary.push(event.delta);
    } else {
      summary[summary.length - 1] += event.delta;
    }
    item.summary = summary;
  } else if (event.kind === 'reasoningDelta') {
    const reasoning = [...item.reasoning];
    if (reasoning.length === 0) {
      reasoning.push(event.delta);
    } else {
      reasoning[reasoning.length - 1] += event.delta;
    }
    item.reasoning = reasoning;
  } else {
    item.text = `${item.text ?? ''}${event.delta}`;
  }
  items[index] = item;
  return { ...turn, items };
}

function mergeTurn(existing: CodexTurn | undefined, incoming: CodexTurn): CodexTurn {
  if (!existing) {
    return incoming;
  }
  let next = { ...existing, ...incoming };
  if (incoming.items.length === 0) {
    next.items = existing.items;
  } else {
    next = incoming.items.reduce<CodexTurn>(
      (turn, item) => upsertItem(turn, item),
      next
    );
  }
  return next;
}

function upsertTurn(thread: CodexThread, incoming: CodexTurn): CodexThread {
  const index = thread.turns.findIndex((turn) => turn.id === incoming.id);
  if (index < 0) {
    return { ...thread, turns: [...thread.turns, incoming] };
  }
  const turns = [...thread.turns];
  turns[index] = mergeTurn(turns[index], incoming);
  return { ...thread, turns };
}

function updateTurn(
  thread: CodexThread,
  turnId: string,
  update: (turn: CodexTurn) => CodexTurn
): CodexThread {
  const index = thread.turns.findIndex((turn) => turn.id === turnId);
  const turns = [...thread.turns];
  if (index < 0) {
    turns.push(update(emptyTurn(turnId)));
  } else {
    turns[index] = update(turns[index]);
  }
  return { ...thread, turns };
}

function placeholderThread(threadId: string): CodexThread {
  return {
    id: threadId,
    sessionId: threadId,
    title: 'New thread',
    preview: '',
    cwd: '',
    modelProvider: '',
    createdAt: 0,
    updatedAt: 0,
    status: 'active',
    source: 'appServer',
    cliVersion: '',
    archived: false,
    turns: []
  };
}

function mergeThread(existing: CodexThread | undefined, incoming: CodexThread): CodexThread {
  if (!existing) {
    return incoming;
  }
  return {
    ...existing,
    ...incoming,
    turns:
      incoming.turns.length === 0
        ? existing.turns
        : incoming.turns.reduce(upsertTurn, existing).turns
  };
}

function dataIdentifier(data: unknown, key: string): string | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

export function reduceCodexEvent(
  snapshot: CodexStoreSnapshot,
  event: CodexEvent
): CodexStoreSnapshot {
  if (event.sequence <= snapshot.lastSequence) {
    return snapshot;
  }

  let threads = snapshot.threads;
  let approvals: Record<string, CodexApprovalRequest> = { ...snapshot.approvals };
  let usage: Record<string, CodexTokenUsage> = { ...snapshot.usage };
  const threadId = event.threadId ?? event.thread?.id ?? null;

  const writeThread = (thread: CodexThread) => {
    threads = {
      ...threads,
      [thread.id]: mergeThread(threads[thread.id], thread)
    };
  };

  if (event.thread) {
    writeThread(event.thread);
  }

  if (threadId) {
    let thread = threads[threadId] ?? placeholderThread(threadId);
    if (event.turn) {
      thread = upsertTurn(thread, event.turn);
    }
    if (event.turnId && event.item) {
      thread = updateTurn(thread, event.turnId, (turn) => upsertItem(turn, event.item!));
    }
    if (event.turnId && event.delta != null) {
      thread = updateTurn(thread, event.turnId, (turn) => appendItemDelta(turn, event));
    }
    if (event.kind === 'threadStatusChanged' && event.status) {
      thread = { ...thread, status: event.status };
    }
    if (event.kind === 'threadNameUpdated') {
      const name = dataIdentifier(event.data, 'name');
      if (name) {
        thread = { ...thread, title: name };
      }
    }
    if (event.kind === 'threadArchived') {
      thread = { ...thread, archived: true };
    }
    if (event.kind === 'threadUnarchived') {
      thread = { ...thread, archived: false };
    }
    if (event.kind === 'threadDeleted') {
      const next = { ...threads };
      delete next[threadId];
      threads = next;
    } else {
      threads = { ...threads, [threadId]: thread };
    }
  }

  if (event.approval) {
    approvals = {
      ...approvals,
      [approvalKey(event.approval.requestId)]: event.approval
    };
  }
  if (event.kind === 'approvalResolved') {
    const requestId = dataIdentifier(event.data, 'requestId');
    if (requestId) {
      approvals = { ...approvals };
      delete approvals[requestId];
    }
  }
  if (threadId && event.tokenUsage) {
    usage = { ...usage, [threadId]: event.tokenUsage };
  }

  return {
    ...snapshot,
    threads,
    approvals,
    usage,
    lastSequence: event.sequence,
    unseenEvents:
      snapshot.activeThreadId && snapshot.activeThreadId === threadId
        ? snapshot.unseenEvents
        : snapshot.unseenEvents + 1
  };
}

class CodexStore {
  private snapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<Listener>();
  private pendingEvents: CodexEvent[] = [];
  private frame: number | null = null;

  getSnapshot = (): CodexStoreSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: CodexStoreSnapshot) {
    if (snapshot === this.snapshot) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  queueEvent(event: CodexEvent) {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length >= MAX_EVENTS_PER_FRAME) {
      this.flushEvents();
      return;
    }
    if (this.frame == null) {
      this.frame = requestFrame(() => this.flushEvents());
    }
  }

  flushEvents() {
    this.frame = null;
    if (this.pendingEvents.length === 0) {
      return;
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const next = events
      .sort((left, right) => left.sequence - right.sequence)
      .reduce(reduceCodexEvent, this.snapshot);
    this.publish(next);
  }

  setDiagnostics(diagnostics: CodexDiagnostics) {
    this.publish({ ...this.snapshot, diagnostics });
  }

  setActiveThread(threadId: string | null) {
    this.publish({
      ...this.snapshot,
      activeThreadId: threadId,
      unseenEvents: 0
    });
  }

  upsertThreads(incoming: CodexThread[]) {
    let threads = this.snapshot.threads;
    for (const thread of incoming) {
      threads = {
        ...threads,
        [thread.id]: mergeThread(threads[thread.id], thread)
      };
    }
    this.publish({ ...this.snapshot, threads });
  }

  replaceWorkspaceThreads(workspacePath: string, archived: boolean, incoming: CodexThread[]) {
    const incomingIds = new Set(incoming.map((thread) => thread.id));
    const threads = Object.fromEntries(
      Object.entries(this.snapshot.threads).filter(
        ([threadId, thread]) =>
          thread.cwd !== workspacePath || thread.archived !== archived || incomingIds.has(threadId)
      )
    );
    for (const thread of incoming) {
      threads[thread.id] = mergeThread(this.snapshot.threads[thread.id], thread);
    }
    this.publish({ ...this.snapshot, threads });
  }

  setSession(session: CodexThreadSession) {
    this.publish({
      ...this.snapshot,
      threads: {
        ...this.snapshot.threads,
        [session.thread.id]: mergeThread(this.snapshot.threads[session.thread.id], session.thread)
      },
      sessions: {
        ...this.snapshot.sessions,
        [session.thread.id]: session
      }
    });
  }

  dismissApproval(requestId: string | number) {
    const approvals = { ...this.snapshot.approvals };
    delete approvals[approvalKey(requestId)];
    this.publish({ ...this.snapshot, approvals });
  }
}

export const codexStore = new CodexStore();

export function useCodexStore<T>(selector: (snapshot: CodexStoreSnapshot) => T): T {
  return useSyncExternalStore(
    codexStore.subscribe,
    () => selector(codexStore.getSnapshot()),
    () => selector(codexStore.getSnapshot())
  );
}
