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
  /**
   * Lightweight thread records for navigation chrome. Turn items are omitted
   * and the map remains referentially stable while only streamed content
   * changes, so the application shell does not rerender for every delta.
   */
  navigationThreads: Readonly<Record<string, CodexThread>>;
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
const MAX_PENDING_EVENTS = 2_048;
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
  navigationThreads: {},
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
  if (item.output == null) return item;
  const output = boundedCommandOutput(item.output);
  return output === item.output ? item : { ...item, output };
}

function boundedItems(items: CodexItem[]): CodexItem[] {
  let result: CodexItem[] | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = boundedItem(items[index]);
    if (item === items[index]) continue;
    result ??= [...items];
    result[index] = item;
  }
  return result ?? items;
}

function boundedTurn(turn: CodexTurn): CodexTurn {
  const items = boundedItems(turn.items);
  return items === turn.items ? turn : { ...turn, items };
}

function boundedThread(thread: CodexThread): CodexThread {
  let turns: CodexTurn[] | null = null;
  for (let index = 0; index < thread.turns.length; index += 1) {
    const turn = boundedTurn(thread.turns[index]);
    if (turn === thread.turns[index]) continue;
    turns ??= [...thread.turns];
    turns[index] = turn;
  }
  return turns ? { ...thread, turns } : thread;
}

function itemIndex(items: CodexItem[], itemId: string): number {
  const lastIndex = items.length - 1;
  if (lastIndex >= 0 && items[lastIndex].id === itemId) return lastIndex;
  return items.findIndex((item) => item.id === itemId);
}

function turnIndex(turns: CodexTurn[], turnId: string): number {
  const lastIndex = turns.length - 1;
  if (lastIndex >= 0 && turns[lastIndex].id === turnId) return lastIndex;
  return turns.findIndex((turn) => turn.id === turnId);
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
  const index = itemIndex(turn.items, item.id);
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
  let index = itemIndex(turn.items, event.itemId);
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
    return boundedTurn(incoming);
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
  const index = turnIndex(thread.turns, incoming.id);
  if (index < 0) {
    return { ...thread, turns: [...thread.turns, mergeTurn(undefined, incoming)] };
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
  const index = turnIndex(thread.turns, turnId);
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

function lastTurn(thread: CodexThread): CodexTurn | undefined {
  return thread.turns[thread.turns.length - 1];
}

function threadMetadataMatches(left: CodexThread, right: CodexThread): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.forkedFromId === right.forkedFromId &&
    left.parentThreadId === right.parentThreadId &&
    left.title === right.title &&
    left.preview === right.preview &&
    left.cwd === right.cwd &&
    left.modelProvider === right.modelProvider &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.recencyAt === right.recencyAt &&
    left.status === right.status &&
    left.source === right.source &&
    left.cliVersion === right.cliVersion &&
    left.archived === right.archived
  );
}

function navigationThreadMatches(
  navigation: CodexThread | undefined,
  thread: CodexThread
): boolean {
  if (!navigation) return false;
  const navigationTurn = lastTurn(navigation);
  const threadTurn = lastTurn(thread);
  return (
    threadMetadataMatches(navigation, thread) &&
    navigationTurn?.id === threadTurn?.id &&
    navigationTurn?.status === threadTurn?.status
  );
}

function projectNavigationThread(thread: CodexThread): CodexThread {
  const turn = lastTurn(thread);
  return {
    ...thread,
    turns: turn
      ? [
          {
            id: turn.id,
            status: turn.status,
            items: [],
            itemsView: turn.itemsView
          }
        ]
      : []
  };
}

function upsertNavigationThread(
  navigationThreads: Readonly<Record<string, CodexThread>>,
  thread: CodexThread
): Readonly<Record<string, CodexThread>> {
  if (navigationThreadMatches(navigationThreads[thread.id], thread)) {
    return navigationThreads;
  }
  return {
    ...navigationThreads,
    [thread.id]: projectNavigationThread(thread)
  };
}

function mergeThread(existing: CodexThread | undefined, incoming: CodexThread): CodexThread {
  if (!existing) {
    return boundedThread(incoming);
  }
  if (incoming.turns.length === 0) {
    if (threadMetadataMatches(existing, incoming)) return existing;
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
  let navigationThreads = snapshot.navigationThreads;
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
    let navigationChanged = threadChanged;
    if (event.turn) {
      thread = upsertTurn(thread, event.turn);
      threadChanged = true;
      navigationChanged = true;
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
      navigationChanged = true;
    }
    if (event.kind === 'threadNameUpdated') {
      const name = dataIdentifier(event.data, 'name');
      if (name) {
        thread = { ...thread, title: name };
        threadChanged = true;
        navigationChanged = true;
      }
    }
    if (event.kind === 'threadArchived') {
      thread = { ...thread, archived: true };
      threadChanged = true;
      navigationChanged = true;
    }
    if (event.kind === 'threadUnarchived') {
      thread = { ...thread, archived: false };
      threadChanged = true;
      navigationChanged = true;
    }
    if (event.kind === 'threadDeleted') {
      const next = { ...threads };
      delete next[threadId];
      threads = next;
      if (Object.prototype.hasOwnProperty.call(navigationThreads, threadId)) {
        const nextNavigation = { ...navigationThreads };
        delete nextNavigation[threadId];
        navigationThreads = nextNavigation;
      }
    } else if (threadChanged) {
      threads = { ...threads, [threadId]: thread };
      if (navigationChanged) {
        navigationThreads = upsertNavigationThread(navigationThreads, thread);
      }
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
    navigationThreads,
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
    previous.sequence < next.sequence &&
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

function prepareQueuedEvents(events: CodexEvent[]): CodexEvent[] {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].sequence > events[index].sequence) {
      return coalesceCodexEvents(
        events.sort((left, right) => left.sequence - right.sequence)
      );
    }
  }
  // queueEvent already coalesces adjacent deltas. The native bridge normally
  // delivers monotonically increasing sequences, so this path avoids another
  // array allocation and O(n log n) sort on every animation-frame reducer pass.
  return events;
}

export class CodexStore {
  private snapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<Listener>();
  private pendingEvents: CodexEvent[] = [];
  private pendingEventHead = 0;
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
    if (this.pendingEvents.length - this.pendingEventHead >= MAX_PENDING_EVENTS) {
      // Tauri can deliver a native batch faster than WebKit can paint. Apply
      // one bounded reducer slice immediately at the high-water mark so the
      // JS queue cannot grow without limit while preserving every event.
      this.flushEvents();
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
    const pendingCount = this.pendingEvents.length - this.pendingEventHead;
    if (pendingCount === 0) {
      this.pendingEvents = [];
      this.pendingEventHead = 0;
      return;
    }
    const end = Math.min(
      this.pendingEvents.length,
      this.pendingEventHead + MAX_EVENTS_PER_FRAME
    );
    const events = this.pendingEvents.slice(this.pendingEventHead, end);
    this.pendingEventHead = end;
    if (this.pendingEventHead === this.pendingEvents.length) {
      this.pendingEvents = [];
      this.pendingEventHead = 0;
    } else if (
      this.pendingEventHead >= 4_096 &&
      this.pendingEventHead * 2 >= this.pendingEvents.length
    ) {
      // Avoid O(n) front-splices for large history bursts while periodically
      // releasing consumed references once compaction is worthwhile.
      this.pendingEvents = this.pendingEvents.slice(this.pendingEventHead);
      this.pendingEventHead = 0;
    }
    const next = prepareQueuedEvents(events).reduce(
      reduceCodexEvent,
      this.snapshot
    );
    this.publish(next);
    if (this.pendingEvents.length - this.pendingEventHead > 0) {
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
    this.pendingEvents = this.pendingEvents.slice(this.pendingEventHead).filter(
      (event) => event.threadId !== threadId && event.thread?.id !== threadId
    );
    this.pendingEventHead = 0;
    const threads = { ...this.snapshot.threads };
    const navigationThreads = { ...this.snapshot.navigationThreads };
    const sessions = { ...this.snapshot.sessions };
    const usage = { ...this.snapshot.usage };
    delete threads[threadId];
    delete navigationThreads[threadId];
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
      navigationThreads,
      sessions,
      approvals,
      usage,
      activeThreadId:
        this.snapshot.activeThreadId === threadId ? null : this.snapshot.activeThreadId
    });
  }

  upsertThreads(incoming: CodexThread[]) {
    if (incoming.length === 0) return;
    let mutableThreads: Record<string, CodexThread> | null = null;
    let navigationThreads = this.snapshot.navigationThreads;
    for (const incomingThread of incoming) {
      const threads = mutableThreads ?? this.snapshot.threads;
      const existing = threads[incomingThread.id];
      const thread = mergeThread(existing, incomingThread);
      if (thread === existing) continue;
      mutableThreads ??= { ...this.snapshot.threads };
      mutableThreads[incomingThread.id] = thread;
      navigationThreads = upsertNavigationThread(
        navigationThreads,
        thread
      );
    }
    if (
      mutableThreads == null &&
      navigationThreads === this.snapshot.navigationThreads
    ) {
      return;
    }
    this.publish({
      ...this.snapshot,
      threads: mutableThreads ?? this.snapshot.threads,
      navigationThreads
    });
  }

  mergeTurnStartResponse(threadId: string, turn: CodexTurn) {
    const thread = this.snapshot.threads[threadId] ?? placeholderThread(threadId);
    const existing = thread.turns.find((candidate) => candidate.id === turn.id);
    const merged = mergeTurnStartResponse(existing, turn);
    const nextThread = upsertTurn(thread, merged);
    this.publish({
      ...this.snapshot,
      threads: {
        ...this.snapshot.threads,
        [threadId]: nextThread
      },
      navigationThreads: upsertNavigationThread(
        this.snapshot.navigationThreads,
        nextThread
      )
    });
  }

  replaceWorkspaceThreads(workspacePath: string, archived: boolean, incoming: CodexThread[]) {
    const incomingIds = new Set(incoming.map((thread) => thread.id));
    let mutableThreads: Record<string, CodexThread> | null = null;
    let mutableNavigationThreads: Record<string, CodexThread> | null = null;
    let navigationThreads = this.snapshot.navigationThreads;
    for (const [threadId, thread] of Object.entries(this.snapshot.threads)) {
      if (
        thread.cwd === workspacePath &&
        thread.archived === archived &&
        !incomingIds.has(threadId)
      ) {
        mutableThreads ??= { ...this.snapshot.threads };
        delete mutableThreads[threadId];
        if (Object.prototype.hasOwnProperty.call(navigationThreads, threadId)) {
          mutableNavigationThreads ??= { ...navigationThreads };
          delete mutableNavigationThreads[threadId];
          navigationThreads = mutableNavigationThreads;
        }
      }
    }
    for (const incomingThread of incoming) {
      const threads = mutableThreads ?? this.snapshot.threads;
      const existing = threads[incomingThread.id];
      const thread = mergeThread(existing, incomingThread);
      if (thread === existing) continue;
      mutableThreads ??= { ...this.snapshot.threads };
      mutableThreads[incomingThread.id] = thread;
      navigationThreads = upsertNavigationThread(
        navigationThreads,
        thread
      );
    }
    if (
      mutableThreads == null &&
      navigationThreads === this.snapshot.navigationThreads
    ) {
      return;
    }
    this.publish({
      ...this.snapshot,
      threads: mutableThreads ?? this.snapshot.threads,
      navigationThreads
    });
  }

  setSession(session: CodexThreadSession) {
    const thread = mergeThread(
      this.snapshot.threads[session.thread.id],
      session.thread
    );
    // Session presence and effective settings are the only session fields the
    // UI consumes. Keeping the resume response's full thread here retains a
    // second root to every historical item and streamed output, preventing an
    // inactive thread from being collected when its canonical history is
    // discarded.
    const lightweightSession = session.thread.turns.length
      ? {
          ...session,
          thread: { ...session.thread, turns: [] }
        }
      : session;
    this.publish({
      ...this.snapshot,
      threads: {
        ...this.snapshot.threads,
        [session.thread.id]: thread
      },
      navigationThreads: upsertNavigationThread(
        this.snapshot.navigationThreads,
        thread
      ),
      sessions: {
        ...this.snapshot.sessions,
        [session.thread.id]: lightweightSession
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
