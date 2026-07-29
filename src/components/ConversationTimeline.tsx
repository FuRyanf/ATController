import { memo, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CodexApprovalRequest,
  CodexFileChange,
  CodexItem,
  CodexThread,
  CodexTokenUsage,
  CodexTurn
} from '../types';
import { AppIcon } from './AppIcon';

interface ConversationTimelineProps {
  thread: CodexThread;
  approvals: CodexApprovalRequest[];
  usage?: CodexTokenUsage;
  onRespondToApproval: (
    approval: CodexApprovalRequest,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ) => void;
  onRespondToUserInput: (
    approval: CodexApprovalRequest,
    answers: Record<string, string[]>
  ) => void;
  onCopy: (value: string, label: string) => void;
  onOpenFile: (path: string) => void;
  onRevealPath: (path: string) => void;
  onRevertFile: (path: string) => void;
  onOpenTerminal: (path: string) => void;
}

function formatDuration(durationMs?: number | null): string {
  if (durationMs == null) return '';
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1_000)}s`;
}

function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

function readableKind(kind: string): string {
  return kind
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function TextContent({ text }: { text: string }) {
  return (
    <div className="timeline-prose">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
      ))}
    </div>
  );
}

function UserMessage({ item }: { item: CodexItem }) {
  const text = item.content
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n');
  const attachments = item.content.filter(
    (part) => !part.text && (part.path || part.url || part.name)
  );
  return (
    <article className="timeline-user-message" data-item-id={item.id}>
      <TextContent text={text || item.text || 'Message'} />
      {attachments.length ? (
        <div className="timeline-message-attachments">
          {attachments.map((part, index) => (
            <span key={`${part.kind}-${part.path ?? part.name ?? index}`}>
              <AppIcon
                name={part.kind.toLocaleLowerCase().includes('image') ? 'attachment' : 'file'}
              />
              {part.name ??
                part.path?.split('/').pop() ??
                (part.url?.startsWith('data:') ? 'Pasted image' : 'Attached resource')}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ReasoningItem({ item }: { item: CodexItem }) {
  const [expanded, setExpanded] = useState(false);
  const summary = item.summary.join('\n') || 'Codex is reasoning about the next step.';
  const reasoning = expanded ? item.reasoning.join('\n') : '';
  return (
    <details className="activity-disclosure reasoning-card" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className={`activity-pulse ${item.status === 'inProgress' ? 'live' : ''}`} />
        <span>{summary}</span>
        <span className="disclosure-action">{expanded ? 'Hide reasoning' : 'Show reasoning'}</span>
      </summary>
      {reasoning ? <pre className="reasoning-detail">{reasoning}</pre> : <p className="muted">No additional reasoning detail was supplied.</p>}
    </details>
  );
}

function PlanItem({ item }: { item: CodexItem }) {
  const details =
    item.details && typeof item.details === 'object'
      ? (item.details as Record<string, unknown>)
      : null;
  const steps = Array.isArray(details?.plan)
    ? details.plan.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const step = candidate as Record<string, unknown>;
        if (typeof step.step !== 'string' || typeof step.status !== 'string') return [];
        return [{ label: step.step, status: step.status }];
      })
    : [];
  return (
    <article className="plan-card" data-item-id={item.id}>
      <header>
        <span className="activity-icon"><AppIcon name="check" /></span>
        <div>
          <strong>Plan</strong>
          {item.text ? <span>{item.text}</span> : null}
        </div>
      </header>
      {steps.length ? (
        <ol>
          {steps.map((step, index) => (
            <li key={`${index}-${step.label}`} className={step.status}>
              <i aria-hidden="true" />
              <span>{step.label}</span>
              <small>{readableKind(step.status)}</small>
            </li>
          ))}
        </ol>
      ) : (
        <TextContent text={item.text || 'Plan updated'} />
      )}
    </article>
  );
}

function CommandItem({
  item,
  onCopy,
  onOpenTerminal
}: {
  item: CodexItem;
  onCopy: ConversationTimelineProps['onCopy'];
  onOpenTerminal: ConversationTimelineProps['onOpenTerminal'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullCommand, setFullCommand] = useState(false);
  const running = item.status === 'inProgress';
  const output = item.output ?? '';
  const displayedOutput =
    !expanded && output.length > 12_000
      ? `… earlier output hidden …\n${output.slice(-12_000)}`
      : output;
  const command = item.command || 'Command details unavailable';
  const commandIsLong = command.length > 160 || command.includes('\n');
  return (
    <article className={`activity-card command-card ${running ? 'running' : ''}`} data-item-id={item.id}>
      <header>
        <span className="activity-icon"><AppIcon name="terminal" /></span>
        <div className="activity-heading">
          <strong>{running ? 'Running command' : item.exitCode === 0 ? 'Command completed' : 'Command'}</strong>
          <code className={commandIsLong && !fullCommand ? 'command-condensed' : ''}>
            {command}
          </code>
        </div>
        <div className="activity-meta">
          {running ? <span className="live-label">Running</span> : null}
          {item.durationMs != null ? <span>{formatDuration(item.durationMs)}</span> : null}
          {item.exitCode != null ? (
            <span className={item.exitCode === 0 ? 'success-label' : 'error-label'}>exit {item.exitCode}</span>
          ) : null}
        </div>
      </header>
      {item.cwd ? <p className="activity-cwd">{item.cwd}</p> : null}
      {output ? (
        <>
          <pre className={`command-output ${expanded ? 'expanded' : ''}`}>{displayedOutput}</pre>
          <footer className="activity-actions">
            <button type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Collapse output' : 'Show output'}
            </button>
            {commandIsLong ? (
              <button type="button" onClick={() => setFullCommand((value) => !value)}>
                {fullCommand ? 'Condense command' : 'Show full command'}
              </button>
            ) : null}
            <button type="button" onClick={() => onCopy(item.command ?? '', 'Command')}>Copy command</button>
            <button type="button" onClick={() => onCopy(output, 'Command output')}>Copy output</button>
            {item.cwd ? <button type="button" onClick={() => onOpenTerminal(item.cwd!)}>Open directory in Terminal</button> : null}
          </footer>
        </>
      ) : (
        <footer className="activity-actions">
          {commandIsLong ? (
            <button type="button" onClick={() => setFullCommand((value) => !value)}>
              {fullCommand ? 'Condense command' : 'Show full command'}
            </button>
          ) : null}
          <button type="button" onClick={() => onCopy(item.command ?? '', 'Command')}>Copy command</button>
          {item.cwd ? <button type="button" onClick={() => onOpenTerminal(item.cwd!)}>Open directory in Terminal</button> : null}
        </footer>
      )}
    </article>
  );
}

function DiffPreview({ change }: { change: CodexFileChange }) {
  const [full, setFull] = useState(false);
  const lines = change.diff.split('\n');
  const visibleLines = full ? lines : lines.slice(0, 80);
  return (
    <>
      <pre className={`diff-preview ${full ? 'expanded' : ''}`}>
        {visibleLines.map((line, index) => (
          <span
            key={`${index}-${line.slice(0, 24)}`}
            className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : 'diff-context'}
          >
            {line}
            {'\n'}
          </span>
        ))}
        {!full && lines.length > 80 ? (
          <span className="diff-omitted">… {lines.length - 80} more lines</span>
        ) : null}
      </pre>
      {lines.length > 80 ? (
        <button type="button" className="diff-expand-button" onClick={() => setFull((value) => !value)}>
          {full ? 'Collapse diff' : 'Show full diff'}
        </button>
      ) : null}
    </>
  );
}

function FileChangeItem({
  item,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile
}: {
  item: CodexItem;
  onCopy: ConversationTimelineProps['onCopy'];
  onOpenFile: ConversationTimelineProps['onOpenFile'];
  onRevealPath: ConversationTimelineProps['onRevealPath'];
  onRevertFile: ConversationTimelineProps['onRevertFile'];
}) {
  const [expandedChanges, setExpandedChanges] = useState<Record<string, boolean>>({});
  return (
    <article className="activity-card file-change-card" data-item-id={item.id}>
      <header>
        <span className="activity-icon"><AppIcon name="file" /></span>
        <div className="activity-heading">
          <strong>{item.changes.length === 1 ? 'Changed file' : `Changed ${item.changes.length} files`}</strong>
          <span>{item.status === 'inProgress' ? 'Applying edits…' : 'Working tree updated'}</span>
        </div>
      </header>
      <div className="file-change-list">
        {item.changes.map((change, index) => {
          const counts = diffCounts(change.diff);
          const changeKey = `${index}-${change.path}-${change.kind}`;
          const expanded = expandedChanges[changeKey] === true;
          return (
            <details
              key={changeKey}
              className="file-change"
              open={expanded}
              onToggle={(event) =>
                setExpandedChanges((current) => ({
                  ...current,
                  [changeKey]: event.currentTarget.open
                }))
              }
            >
              <summary>
                <span className="file-change-kind">{change.kind || 'update'}</span>
                <code>{change.path}</code>
                <span className="diff-counts">
                  {counts.added ? <span className="added">+{counts.added}</span> : null}
                  {counts.removed ? <span className="removed">−{counts.removed}</span> : null}
                </span>
                <span className="show-diff-label">Show diff</span>
              </summary>
              {expanded ? (
                <>
                  {change.diff ? <DiffPreview change={change} /> : <p className="muted">Codex did not include an inline patch for this event.</p>}
                  <footer className="activity-actions">
                    <button type="button" onClick={() => onOpenFile(change.path)}>Open file</button>
                    <button type="button" onClick={() => onRevealPath(change.path)}>Reveal in Finder</button>
                    <button type="button" onClick={() => onCopy(change.path, 'File path')}>Copy path</button>
                    {change.diff ? <button type="button" onClick={() => onCopy(change.diff, 'Patch')}>Copy patch</button> : null}
                    <button type="button" className="danger-action" onClick={() => onRevertFile(change.path)}>Revert file…</button>
                  </footer>
                </>
              ) : null}
            </details>
          );
        })}
      </div>
    </article>
  );
}

function ToolItem({ item }: { item: CodexItem }) {
  const [expanded, setExpanded] = useState(false);
  const title = item.toolName || readableKind(item.kind);
  return (
    <details className="activity-disclosure tool-card" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="activity-icon"><AppIcon name="code" /></span>
        <span>
          <strong>{title}</strong>
          {item.toolServer ? <small>{item.toolServer}</small> : null}
        </span>
        <span className="disclosure-action">{expanded ? 'Hide details' : 'Show details'}</span>
      </summary>
      {expanded ? (
        <pre>{JSON.stringify(item.toolResult ?? item.details ?? item.toolArguments, null, 2)}</pre>
      ) : null}
    </details>
  );
}

function ApprovalCard({
  approval,
  onRespond,
  onRespondToUserInput
}: {
  approval: CodexApprovalRequest;
  onRespond: ConversationTimelineProps['onRespondToApproval'];
  onRespondToUserInput: ConversationTimelineProps['onRespondToUserInput'];
}) {
  if (approval.approvalType === 'userInput') {
    return (
      <UserInputCard
        approval={approval}
        onSubmit={(answers) => onRespondToUserInput(approval, answers)}
        onCancel={() => onRespond(approval, 'cancel')}
      />
    );
  }
  const isCommand = approval.approvalType === 'commandExecution';
  return (
    <article className="approval-card" data-request-id={String(approval.requestId)}>
      <header>
        <span className="approval-icon"><AppIcon name="warning" /></span>
        <div>
          <strong>{isCommand ? 'Command needs approval' : `${readableKind(approval.approvalType)} needs approval`}</strong>
          <p>{approval.reason || 'Codex is waiting for permission before it can continue.'}</p>
        </div>
      </header>
      {approval.command ? <pre>{approval.command}</pre> : null}
      {approval.cwd ? <p className="activity-cwd">{approval.cwd}</p> : null}
      {approval.networkHost ? (
        <p className="approval-scope">Network: {approval.networkProtocol ? `${approval.networkProtocol}://` : ''}{approval.networkHost}</p>
      ) : null}
      {approval.grantRoot ? (
        <p className="approval-scope">Filesystem scope: {approval.grantRoot}</p>
      ) : null}
      {approval.requestedPermissions ? (
        <details className="approval-permissions">
          <summary>Show requested permissions</summary>
          <pre>{JSON.stringify(approval.requestedPermissions, null, 2)}</pre>
        </details>
      ) : null}
      {approval.threadId || approval.turnId ? (
        <p className="approval-association">
          {approval.threadId ? `Thread ${approval.threadId}` : ''}
          {approval.threadId && approval.turnId ? ' · ' : ''}
          {approval.turnId ? `Turn ${approval.turnId}` : ''}
        </p>
      ) : null}
      <footer>
        {approval.availableDecisions.includes('accept') || approval.availableDecisions.includes('grant') ? (
          <button type="button" className="primary-action" onClick={() => onRespond(approval, 'accept')}>Approve once</button>
        ) : null}
        {approval.availableDecisions.includes('acceptForSession') ? (
          <button type="button" onClick={() => onRespond(approval, 'acceptForSession')}>Approve for session</button>
        ) : null}
        <button type="button" className="danger-action" onClick={() => onRespond(approval, 'decline')}>Deny</button>
      </footer>
    </article>
  );
}

interface UserInputOption {
  label: string;
  description: string;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

function userInputQuestions(payload: unknown): UserInputQuestion[] {
  if (!payload || typeof payload !== 'object') return [];
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.question !== 'string') return [];
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const typed = option as Record<string, unknown>;
          if (typeof typed.label !== 'string') return [];
          return [{
            label: typed.label,
            description: typeof typed.description === 'string' ? typed.description : ''
          }];
        })
      : null;
    return [{
      id: value.id,
      header: typeof value.header === 'string' ? value.header : 'Input requested',
      question: value.question,
      isOther: value.isOther === true,
      isSecret: value.isSecret === true,
      options
    }];
  });
}

function UserInputCard({
  approval,
  onSubmit,
  onCancel
}: {
  approval: CodexApprovalRequest;
  onSubmit: (answers: Record<string, string[]>) => void;
  onCancel: () => void;
}) {
  const questions = useMemo(() => userInputQuestions(approval.payload), [approval.payload]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = questions.length > 0 && questions.every((question) => Boolean(answers[question.id]?.trim()));
  return (
    <form
      className="approval-card user-input-card"
      data-request-id={String(approval.requestId)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete) return;
        onSubmit(
          Object.fromEntries(
            questions.map((question) => [question.id, [answers[question.id].trim()]])
          )
        );
      }}
    >
      <header>
        <span className="approval-icon"><AppIcon name="info" /></span>
        <div>
          <strong>Codex needs your input</strong>
          <p>Answer the question below so the active turn can continue.</p>
        </div>
      </header>
      {questions.length ? (
        <div className="approval-questions">
          {questions.map((question) => (
            <fieldset key={question.id}>
              <legend>
                <small>{question.header}</small>
                <span>{question.question}</span>
              </legend>
              {question.options?.length ? (
                <div className="approval-options">
                  {question.options.map((option) => (
                    <label key={option.label}>
                      <input
                        type="radio"
                        name={`${approval.requestId}-${question.id}`}
                        value={option.label}
                        checked={answers[question.id] === option.label}
                        onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                      />
                      <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                    </label>
                  ))}
                  {question.isOther ? (
                    <input
                      type={question.isSecret ? 'password' : 'text'}
                      aria-label={`${question.header} other answer`}
                      placeholder="Another answer…"
                      onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                    />
                  ) : null}
                </div>
              ) : (
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  value={answers[question.id] ?? ''}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                  autoComplete={question.isSecret ? 'off' : undefined}
                />
              )}
            </fieldset>
          ))}
        </div>
      ) : (
        <p className="timeline-error">Codex sent an input request that this version cannot display safely.</p>
      )}
      <footer>
        <button type="submit" className="primary-action" disabled={!complete}>Continue</button>
        <button type="button" className="danger-action" onClick={onCancel}>Cancel turn</button>
      </footer>
    </form>
  );
}

function GenericItem({ item }: { item: CodexItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="activity-disclosure generic-card"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="activity-icon"><AppIcon name="info" /></span>
        <strong>{readableKind(item.kind)}</strong>
        <span className="disclosure-action">Show details</span>
      </summary>
      {expanded ? <pre>{JSON.stringify(item.details ?? item, null, 2)}</pre> : null}
    </details>
  );
}

function TimelineItem({
  item,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal
}: Pick<
  ConversationTimelineProps,
  'onCopy' | 'onOpenFile' | 'onRevealPath' | 'onRevertFile' | 'onOpenTerminal'
> & { item: CodexItem }) {
  switch (item.kind) {
    case 'userMessage':
      return <UserMessage item={item} />;
    case 'agentMessage':
      return (
        <article className={`timeline-agent-message ${item.status === 'inProgress' ? 'streaming' : ''}`} data-item-id={item.id}>
          <TextContent text={item.text || '…'} />
        </article>
      );
    case 'reasoning':
      return <ReasoningItem item={item} />;
    case 'plan':
      return <PlanItem item={item} />;
    case 'commandExecution':
      return <CommandItem item={item} onCopy={onCopy} onOpenTerminal={onOpenTerminal} />;
    case 'fileChange':
      return (
        <FileChangeItem
          item={item}
          onCopy={onCopy}
          onOpenFile={onOpenFile}
          onRevealPath={onRevealPath}
          onRevertFile={onRevertFile}
        />
      );
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return <ToolItem item={item} />;
    default:
      return item.error ? (
        <article className="timeline-error"><AppIcon name="warning" /><span>{item.error}</span></article>
      ) : (
        <GenericItem item={item} />
      );
  }
}

function TurnBlockComponent({
  turn,
  approvals,
  onRespondToApproval,
  onRespondToUserInput,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal
}: Omit<ConversationTimelineProps, 'thread' | 'usage'> & {
  turn: CodexTurn;
}) {
  const itemApprovals = new Map(
    approvals.filter((approval) => approval.itemId).map((approval) => [approval.itemId!, approval])
  );
  const remainingApprovals = approvals.filter(
    (approval) => !approval.itemId || !turn.items.some((item) => item.id === approval.itemId)
  );
  return (
    <section className={`turn-block ${turn.status}`} data-turn-id={turn.id}>
      {turn.items.map((item) => (
        <div className="timeline-item-wrap" key={item.id}>
          <TimelineItem
            item={item}
            onCopy={onCopy}
            onOpenFile={onOpenFile}
            onRevealPath={onRevealPath}
            onRevertFile={onRevertFile}
            onOpenTerminal={onOpenTerminal}
          />
          {itemApprovals.has(item.id) ? (
            <ApprovalCard
              approval={itemApprovals.get(item.id)!}
              onRespond={onRespondToApproval}
              onRespondToUserInput={onRespondToUserInput}
            />
          ) : null}
        </div>
      ))}
      {remainingApprovals.map((approval) => (
        <ApprovalCard
          key={String(approval.requestId)}
          approval={approval}
          onRespond={onRespondToApproval}
          onRespondToUserInput={onRespondToUserInput}
        />
      ))}
      {turn.error ? (
        <article className="timeline-error">
          <AppIcon name="warning" />
          <div><strong>Turn failed</strong><p>{turn.error.message}</p></div>
        </article>
      ) : null}
      {turn.status !== 'inProgress' ? (
        <div className={`turn-completion ${turn.status}`}>
          <span />
          <span>{turn.status === 'completed' ? 'Completed' : readableKind(turn.status)}</span>
          {turn.durationMs != null ? <time>{formatDuration(turn.durationMs)}</time> : null}
        </div>
      ) : null}
    </section>
  );
}

const TurnBlock = memo(
  TurnBlockComponent,
  (previous, next) =>
    previous.turn === next.turn &&
    previous.approvals.length === next.approvals.length &&
    previous.approvals.every((approval, index) => approval === next.approvals[index])
);

export function ConversationTimeline({
  thread,
  approvals,
  usage,
  onRespondToApproval,
  onRespondToUserInput,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal
}: ConversationTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [unseenBelow, setUnseenBelow] = useState(false);
  const latestTurn = thread.turns.length ? thread.turns[thread.turns.length - 1] : undefined;
  const contentSignature = useMemo(
    () =>
      `${thread.turns.length}:${
        latestTurn?.items.reduce(
          (total, item) =>
            total +
            (item.text?.length ?? 0) +
            (item.output?.length ?? 0) +
            item.changes.length,
          latestTurn.items.length
        ) ?? 0
      }`,
    [latestTurn, thread.turns.length]
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (following) {
      element.scrollTop = element.scrollHeight;
      setUnseenBelow(false);
    } else {
      setUnseenBelow(true);
    }
  }, [contentSignature, following]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setUnseenBelow(false);
  }, [thread.id]);

  const threadApprovals = approvals.filter((approval) => approval.threadId === thread.id);
  const knownTurnIds = new Set(thread.turns.map((turn) => turn.id));
  const unassociatedApprovals = threadApprovals.filter(
    (approval) => !approval.turnId || !knownTurnIds.has(approval.turnId)
  );
  const runningItems =
    latestTurn?.status === 'inProgress'
      ? latestTurn.items.filter((item) => item.status === 'inProgress')
      : [];
  const runningItem = runningItems.length ? runningItems[runningItems.length - 1] : undefined;

  return (
    <div className="conversation-timeline-shell">
      <div
        ref={scrollRef}
        className="conversation-timeline"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          setFollowing(atBottom);
          if (atBottom) setUnseenBelow(false);
        }}
      >
        <div className="conversation-column">
          {thread.turns.length === 0 ? (
            <div className="timeline-empty">
              <span className="empty-kicker">Ready</span>
              <h2>Start with a task</h2>
              <p>Ask Codex to explore this project, change code, run tests, or explain what it finds.</p>
            </div>
          ) : (
            thread.turns.map((turn) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                approvals={threadApprovals.filter((approval) => approval.turnId === turn.id)}
                onRespondToApproval={onRespondToApproval}
                onRespondToUserInput={onRespondToUserInput}
                onCopy={onCopy}
                onOpenFile={onOpenFile}
                onRevealPath={onRevealPath}
                onRevertFile={onRevertFile}
                onOpenTerminal={onOpenTerminal}
              />
            ))
          )}
          {unassociatedApprovals.map((approval) => (
            <ApprovalCard
              key={String(approval.requestId)}
              approval={approval}
              onRespond={onRespondToApproval}
              onRespondToUserInput={onRespondToUserInput}
            />
          ))}
          {usage ? (
            <div className="token-usage">
              {usage.totalTokens.toLocaleString()} tokens
              {usage.modelContextWindow ? ` · ${Math.round((usage.totalTokens / usage.modelContextWindow) * 100)}% context` : ''}
            </div>
          ) : null}
        </div>
      </div>
      {runningItem ? (
        <div className="current-action">
          <span className="activity-pulse live" />
          <span>
            {runningItem.kind === 'commandExecution'
              ? runningItem.command || 'Running command'
              : readableKind(runningItem.kind)}
          </span>
        </div>
      ) : null}
      {unseenBelow ? (
        <button
          type="button"
          className="jump-to-latest"
          onClick={() => {
            const element = scrollRef.current;
            if (element) element.scrollTop = element.scrollHeight;
            setFollowing(true);
            setUnseenBelow(false);
          }}
        >
          <AppIcon name="arrowDown" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
