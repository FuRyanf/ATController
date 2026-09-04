import type {
  CodexEvent,
  CodexItem,
  CodexThread,
  CodexTurn,
  ComposerInput,
  PendingSubmissionResource,
  PendingUserSubmission
} from '../types';

export type PendingSubmissionsByThread = Record<string, PendingUserSubmission[]>;

function pathName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function previewResource(input: ComposerInput): PendingSubmissionResource | null {
  switch (input.type) {
    case 'image':
      return { kind: 'image', label: 'Pasted image' };
    case 'localImage':
      return { kind: 'image', label: pathName(input.path) || 'Image' };
    case 'file':
      return { kind: 'file', label: input.name || pathName(input.path) || 'File' };
    case 'skill':
      return { kind: 'skill', label: input.name };
    case 'plugin':
      return { kind: 'plugin', label: input.name };
    default:
      return null;
  }
}

export function createPendingSubmission(
  threadId: string,
  clientId: string,
  mode: PendingUserSubmission['mode'],
  inputs: ComposerInput[],
  submittedAt = Date.now()
): PendingUserSubmission {
  return {
    clientId,
    threadId,
    mode,
    status: 'sending',
    text: inputs
      .filter((input): input is Extract<ComposerInput, { type: 'text' }> => input.type === 'text')
      .map((input) => input.text)
      .join('\n'),
    resources: inputs
      .map(previewResource)
      .filter((resource): resource is PendingSubmissionResource => resource != null),
    submittedAt
  };
}

function normalizedMessageText(item: CodexItem): string {
  return (
    item.content
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n') ||
    item.text ||
    ''
  ).trim();
}

function eventUserMessages(event: CodexEvent): CodexItem[] {
  const result: CodexItem[] = [];
  const seen = new Set<string>();
  const add = (item: CodexItem) => {
    if (item.kind !== 'userMessage' || seen.has(item.id)) return;
    seen.add(item.id);
    result.push(item);
  };
  if (event.item) add(event.item);
  if (event.turn) {
    event.turn.items.forEach(add);
  }
  return result;
}

function eventTurnId(event: CodexEvent): string | null {
  return event.turnId ?? event.turn?.id ?? null;
}

export function eventAcknowledgesSubmission(
  event: CodexEvent,
  submission: PendingUserSubmission
): boolean {
  if (event.threadId !== submission.threadId) return false;
  const messages = eventUserMessages(event);
  if (messages.some((item) => item.clientId === submission.clientId)) return true;
  if (submission.turnId && submission.turnId !== eventTurnId(event)) return false;

  // Older compatible runtimes may omit the echoed client id. Restrict the
  // fallback to the new turn/item payload and the same thread so repeated
  // history hydration cannot consume an optimistic submission.
  const expectedText = submission.text.trim();
  if (expectedText) {
    return messages.some(
      (item) => !item.clientId && normalizedMessageText(item) === expectedText
    );
  }
  return messages.length === 1 && !messages[0].clientId;
}

export function reconcilePendingSubmissions(
  current: PendingSubmissionsByThread,
  event: CodexEvent
): PendingSubmissionsByThread {
  const threadId = event.threadId;
  if (!threadId || !current[threadId]?.length) return current;

  let changed = false;
  let submissions = current[threadId];
  const messages = eventUserMessages(event);
  if (messages.length) {
    const matchedSubmissions = new Set<number>();
    const matchedMessages = new Set<number>();

    // Prefer the protocol's correlation key. A single event must never consume
    // two repeated optimistic messages.
    messages.forEach((message, messageIndex) => {
      if (!message.clientId) return;
      const submissionIndex = submissions.findIndex(
        (submission, index) =>
          !matchedSubmissions.has(index) &&
          submission.clientId === message.clientId
      );
      if (submissionIndex < 0) return;
      matchedSubmissions.add(submissionIndex);
      matchedMessages.add(messageIndex);
    });

    // Older runtimes persist user items without clientId. Match those in FIFO
    // order by exact content, keeping repeated prompts one-to-one.
    messages.forEach((message, messageIndex) => {
      if (matchedMessages.has(messageIndex) || message.clientId) return;
      const messageText = normalizedMessageText(message);
      const submissionIndex = submissions.findIndex(
        (submission, index) =>
          !matchedSubmissions.has(index) &&
          (!submission.turnId || submission.turnId === eventTurnId(event)) &&
          (submission.text.trim()
            ? submission.text.trim() === messageText
            : messageText === '')
      );
      if (submissionIndex < 0) return;
      matchedSubmissions.add(submissionIndex);
      matchedMessages.add(messageIndex);
    });

    if (matchedSubmissions.size) {
      submissions = submissions.filter(
        (_submission, index) => !matchedSubmissions.has(index)
      );
      changed = true;
    }
  }

  const turnId = eventTurnId(event);
  if ((event.kind === 'turnStarted' || event.kind === 'turnCompleted') && turnId) {
    // turn/started may arrive before the response, or be omitted altogether.
    // Bind the oldest request so its local copy stays with the correct turn.
    const unboundIndex = submissions.findIndex(
      (submission) =>
        submission.mode === 'turn' && !submission.turnId && submission.status !== 'failed'
    );
    if (unboundIndex >= 0) {
      submissions = submissions.map((submission, index) =>
        index === unboundIndex ? { ...submission, turnId } : submission
      );
      changed = true;
    }
  }

  // Turn completion (or a later turn) says nothing about whether the UI has
  // received the user's message. Keep its local copy until a matching item
  // can replace it, including for accepted steers.

  if (!changed) return current;
  const next = { ...current };
  if (submissions.length) next[threadId] = submissions;
  else delete next[threadId];
  return next;
}

/** Exclude local copies only when their actual user items are in the timeline. */
export function unacknowledgedSubmissions(
  submissions: PendingUserSubmission[],
  thread: CodexThread
): PendingUserSubmission[] {
  if (!submissions.length) return submissions;
  let current: PendingSubmissionsByThread = { [thread.id]: submissions };
  for (const turn of thread.turns) {
    if (!current[thread.id].length) break;
    const eligible = current[thread.id]?.filter(
      (submission) =>
        submission.turnId
          ? submission.turnId === turn.id
          : turn.items.some((item) => item.clientId === submission.clientId)
    );
    if (!eligible?.length) continue;
    const remaining = reconcilePendingSubmissions({ [thread.id]: eligible }, {
      sequence: 0,
      kind: 'historyLoaded',
      method: 'thread/read',
      threadId: thread.id,
      turnId: turn.id,
      turn
    })[thread.id] ?? [];
    if (remaining.length === eligible.length) continue;
    const acknowledged = new Set(eligible
      .filter((submission) => !remaining.includes(submission))
      .map((submission) => submission.clientId));
    current = { [thread.id]: current[thread.id].filter(
      (submission) => !acknowledged.has(submission.clientId)
    ) };
  }
  return current[thread.id];
}

export function acceptPendingSubmission(
  current: PendingSubmissionsByThread,
  threadId: string,
  clientId: string,
  turnId: string
): PendingSubmissionsByThread {
  const submissions = current[threadId];
  if (!submissions?.some((submission) => submission.clientId === clientId)) {
    return current;
  }
  return {
    ...current,
    [threadId]: submissions.map((submission) =>
      submission.clientId === clientId
        ? { ...submission, status: 'accepted', error: null, turnId }
        : submission
    )
  };
}

export function reconcileTurnStartResponse(
  current: PendingSubmissionsByThread,
  threadId: string,
  clientId: string,
  turn: CodexTurn
): PendingSubmissionsByThread {
  // This response belongs to this exact request, so any returned user item is
  // authoritative even when an older runtime omits or rewrites clientId.
  if (turn.items.some((item) => item.kind === 'userMessage')) {
    return removePendingSubmission(current, threadId, clientId);
  }
  return acceptPendingSubmission(current, threadId, clientId, turn.id);
}

export function updatePendingSubmissionStatus(
  current: PendingSubmissionsByThread,
  threadId: string,
  clientId: string,
  status: PendingUserSubmission['status'],
  error?: string | null
): PendingSubmissionsByThread {
  const submissions = current[threadId];
  if (!submissions?.some((submission) => submission.clientId === clientId)) {
    return current;
  }
  return {
    ...current,
    [threadId]: submissions.map((submission) =>
      submission.clientId === clientId
        ? { ...submission, status, error: error ?? null }
        : submission
    )
  };
}

export function removePendingSubmission(
  current: PendingSubmissionsByThread,
  threadId: string,
  clientId: string
): PendingSubmissionsByThread {
  const submissions = current[threadId];
  if (!submissions?.some((submission) => submission.clientId === clientId)) {
    return current;
  }
  const remaining = submissions.filter(
    (submission) => submission.clientId !== clientId
  );
  const next = { ...current };
  if (remaining.length) next[threadId] = remaining;
  else delete next[threadId];
  return next;
}
