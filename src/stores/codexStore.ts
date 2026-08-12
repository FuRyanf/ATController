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
// Keep each reducer pass comfortably below a frame budget. A large history can
// release thousands of buffered notifications at once; reducing all of them in
// one callback makes WebKit stop servicing pointer and paint events.
const MAX_EVENTS_PER_FRAME = 128;
const MAX_RENDERED_COMMAND_OUTPUT_CHARACTERS = 128_000;
const OUTPUT_TRUNCATION_MARKER = '[Earlier command output truncated]\n';
const COALESCIBLE_DELTA_KINDS = new Set([
  'agentMessageDelta',
  'commandOutputDelta',
  'fileChangeOutputDelta',
  'planDelta',
  'reasoningDelta',
  'reasoningSummaryDelta'
]);

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
    return incoming.items.length > 0
      ? { ...incoming, items: incoming.items.map(boundedItem) }
      : incoming;
  }
  return {
    ...existing,
    ...incoming,
    items:
      incoming.items.length === 0
        ? existing.items
        : incoming.items.map(boundedItem)
  };
}

function mergeTurnStartResponse(
  existing: CodexTurn | undefined,
  incoming: CodexTurn
): CodexTurn {
  if (!existing) {
    return mergeTurn(undefined, incoming);
  }
  const existingById = new Map(existing.items.map((item) => [item.id, item]));
  const responseItemIds = new Set(incoming.items.map((item) => item.id));
  return {
    ...existing,
    ...incoming,
    items: [
      ...incoming.items.map((item) =>
        existingById.has(item.id)
          ? mergeItem(item, existingById.get(item.id)!)
          : boundedItem(item)
      ),
      ...existing.items.filter((item) => !responseItemIds.has(item.id))
    ]
  };
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
  if (incoming.turns.length === 0) {
    return { ...existing, ...incoming, turns: existing.turns };
  }

  const turns = [...existing.turns];
  const turnIndexes = new Map(
    turns.map((turn, index) => [turn.id, index] as const)
  );
  for (const incomingTurn of incoming.turns) {
    const index = turnIndexes.get(incomingTurn.id);
    if (index == null) {
      turnIndexes.set(incomingTurn.id, turns.length);
      turns.push(mergeTurn(undefined, incomingTurn));
    } else {
      turns[index] = mergeTurn(turns[index], incomingTurn);
    }
  }
  return {
    ...existing,
    ...incoming,
    turns
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
  let approvals: Readonly<Record<string, CodexApprovalRequest>> =
    snapshot.approvals;
  let usage: Readonly<Record<string, CodexTokenUsage>> = snapshot.usage;
  const threadId = event.threadId ?? event.thread?.id ?? null;

  if (threadId) {
    const existingThread = threads[threadId];
    let thread = event.thread
      ? mergeThread(existingThread, event.thread)
      : existingThread ?? placeholderThread(threadId);
    let threadChanged = Boolean(event.thread) || !existingThread;
    if (event.turn) {
      thread = upsertTurn(thread, event.turn);
      threadChanged = true;
    }
    if (event.turnId && event.item) {
      thread = updateTurn(thread, event.turnId, (turn) => upsertItem(turn, event.item!));
      threadChanged = true;
    }
    if (event.turnId && event.delta != null) {
      thread = updateTurn(thread, event.turnId, (turn) => appendItemDelta(turn, event));
      threadChanged = true;
    }
    if (event.kind === 'threadStatusChanged' && event.status) {
      thread = { ...thread, status: event.status };
      threadChanged = true;
    }
    if (event.kind === 'threadNameUpdated') {
      const name = dataIdentifier(event.data, 'name');
      if (name) {
        thread = { ...thread, title: name };
        threadChanged = true;
      }
    }
    if (event.kind === 'threadArchived') {
      thread = { ...thread, archived: true };
      threadChanged = true;
    }
    if (event.kind === 'threadUnarchived') {
      thread = { ...thread, archived: false };
      threadChanged = true;
    }
    if (event.kind === 'threadDeleted') {
      const next = { ...threads };
      delete next[threadId];
      threads = next;
    } else if (threadChanged) {
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
    if (requestId && Object.prototype.hasOwnProperty.call(approvals, requestId)) {
      const nextApprovals = { ...approvals };
      delete nextApprovals[requestId];
      approvals = nextApprovals;
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

function canCoalesceDelta(previous: CodexEvent, next: CodexEvent): boolean {
  return (
    previous.delta != null &&
    next.delta != null &&
    COALESCIBLE_DELTA_KINDS.has(previous.kind) &&
    previous.kind === next.kind &&
    previous.method === next.method &&
    previous.threadId === next.threadId &&
    previous.turnId === next.turnId &&
    previous.itemId === next.itemId &&
    !previous.thread &&
    !previous.turn &&
    !previous.item &&
    !previous.approval &&
    !previous.tokenUsage &&
    !previous.error &&
    !next.thread &&
    !next.turn &&
    !next.item &&
    !next.approval &&
    !next.tokenUsage &&
    !next.error
  );
}

export function coalesceCodexEvents(events: CodexEvent[]): CodexEvent[] {
  const result: CodexEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous && canCoalesceDelta(previous, event)) {
      result[result.length - 1] = {
        ...event,
        delta: `${previous.delta ?? ''}${event.delta ?? ''}`
      };
    } else {
      result.push(event);
    }
  }
  return result;
}

export class CodexStore {
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
    const previous = this.pendingEvents[this.pendingEvents.length - 1];
    if (previous && canCoalesceDelta(previous, event)) {
      this.pendingEvents[this.pendingEvents.length - 1] = {
        ...event,
        delta: `${previous.delta ?? ''}${event.delta ?? ''}`
      };
    } else {
      this.pendingEvents.push(event);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.frame != null) return;
    this.frame = requestFrame(() => {
      this.frame = null;
      this.flushEvents();
    });
  }

  flushEvents() {
    if (this.pendingEvents.length === 0) {
      return;
    }
    const events = this.pendingEvents.splice(0, MAX_EVENTS_PER_FRAME);
    const next = coalesceCodexEvents(
      events.sort((left, right) => left.sequence - right.sequence)
    )
      .reduce(reduceCodexEvent, this.snapshot);
    this.publish(next);
    if (this.pendingEvents.length > 0) {
      this.scheduleFlush();
    }
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

  removeThread(threadId: string) {
    this.pendingEvents = this.pendingEvents.filter(
      (event) => event.threadId !== threadId && event.thread?.id !== threadId
    );
    const threads = { ...this.snapshot.threads };
    const sessions = { ...this.snapshot.sessions };
    const usage = { ...this.snapshot.usage };
    delete threads[threadId];
    delete sessions[threadId];
    delete usage[threadId];
    const approvals = Object.fromEntries(
      Object.entries(this.snapshot.approvals).filter(
        ([, approval]) => approval.threadId !== threadId
      )
    );
    this.publish({
      ...this.snapshot,
      threads,
      sessions,
      approvals,
      usage,
      activeThreadId:
        this.snapshot.activeThreadId === threadId ? null : this.snapshot.activeThreadId
    });
  }

  upsertThreads(incoming: CodexThread[]) {
    if (incoming.length === 0) return;
    const threads = { ...this.snapshot.threads };
    for (const thread of incoming) {
      threads[thread.id] = mergeThread(threads[thread.id], thread);
    }
    this.publish({ ...this.snapshot, threads });
  }

  mergeTurnStartResponse(threadId: string, turn: CodexTurn) {
    const thread = this.snapshot.threads[threadId] ?? placeholderThread(threadId);
    const existing = thread.turns.find((candidate) => candidate.id === turn.id);
    const merged = mergeTurnStartResponse(existing, turn);
    this.publish({
      ...this.snapshot,
      threads: {
        ...this.snapshot.threads,
        [threadId]: upsertTurn(thread, merged)
      }
    });
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

  clearSession(threadId: string, discardHistory = false) {
    const hasSession = Object.prototype.hasOwnProperty.call(
      this.snapshot.sessions,
      threadId
    );
    const thread = this.snapshot.threads[threadId];
    if (!hasSession && (!discardHistory || !thread?.turns.length)) return;
    const sessions = { ...this.snapshot.sessions };
    delete sessions[threadId];
    const threads =
      discardHistory && thread?.turns.length
        ? {
            ...this.snapshot.threads,
            [threadId]: { ...thread, turns: [] }
          }
        : this.snapshot.threads;
    this.publish({ ...this.snapshot, sessions, threads });
  }

  clearSessions(discardHistory = false) {
    const hasSessions = Object.keys(this.snapshot.sessions).length > 0;
    const hasHistory =
      discardHistory &&
      Object.values(this.snapshot.threads).some((thread) => thread.turns.length > 0);
    if (!hasSessions && !hasHistory) return;
    const threads = discardHistory
      ? Object.fromEntries(
          Object.entries(this.snapshot.threads).map(([threadId, thread]) => [
            threadId,
            thread.turns.length ? { ...thread, turns: [] } : thread
          ])
        )
      : this.snapshot.threads;
    this.publish({ ...this.snapshot, sessions: {}, threads });
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
