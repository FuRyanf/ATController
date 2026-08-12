import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api } from '../lib/api';
import type {
  BrowserActivity,
  CodexApprovalRequest,
  CodexFileChange,
  CodexItem,
  PendingUserSubmission,
  CodexThread,
  CodexTokenUsage,
  CodexTurn
} from '../types';
import { AppIcon } from './AppIcon';

interface ConversationTimelineProps {
  thread: CodexThread;
  approvals: CodexApprovalRequest[];
  pendingSubmissions?: PendingUserSubmission[];
  usage?: CodexTokenUsage;
  recovering?: boolean;
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
  onOpenBrowser?: (url: string) => void;
}

const INITIAL_VISIBLE_TURNS = 24;
const EARLIER_TURN_PAGE_SIZE = 24;
const THREAD_FIND_HIGHLIGHT = 'atcontroller-thread-find';
const THREAD_FIND_ACTIVE_HIGHLIGHT = 'atcontroller-thread-find-active';
const MAX_THREAD_FIND_MATCHES = 2_000;
const LOCAL_DEVELOPMENT_URL =
  /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi;

export function findLocalDevelopmentUrl(text: string): string | null {
  for (const match of text.matchAll(LOCAL_DEVELOPMENT_URL)) {
    const candidate = match[0].replace(/[),.;:\]}]+$/g, '');
    try {
      const url = new URL(candidate);
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
      return url.toString();
    } catch {
      // Keep scanning bounded command output for another valid local URL.
    }
  }
  return null;
}

export function tokenUsagePresentation(usage: CodexTokenUsage): {
  label: string;
  title: string;
} {
  const cumulativeTokens = Math.max(0, usage.totalTokens);
  const contextTokens = Math.max(0, usage.lastTotalTokens);
  const contextWindow =
    usage.modelContextWindow && usage.modelContextWindow > 0
      ? usage.modelContextWindow
      : null;

  if (contextTokens > 0 && contextWindow) {
    const percentage = Math.min(
      100,
      Math.max(0, Math.round((contextTokens / contextWindow) * 100))
    );
    return {
      label: `${contextTokens.toLocaleString()} tokens · ${percentage}% context`,
      title:
        `Current context: ${contextTokens.toLocaleString()} of ` +
        `${contextWindow.toLocaleString()} tokens. ` +
        `Thread cumulative: ${cumulativeTokens.toLocaleString()} tokens.`
    };
  }

  if (contextTokens > 0) {
    return {
      label: `${contextTokens.toLocaleString()} tokens in current context`,
      title: `Thread cumulative: ${cumulativeTokens.toLocaleString()} tokens.`
    };
  }

  return {
    label: `${cumulativeTokens.toLocaleString()} cumulative tokens`,
    title: 'The runtime has not reported current context usage yet.'
  };
}

interface WritableHighlightRegistry {
  set: (name: string, highlight: Highlight) => void;
  delete: (name: string) => boolean;
}

function threadFindHighlightRegistry(): WritableHighlightRegistry | null {
  if (typeof CSS === 'undefined') return null;
  const registry = (
    CSS as unknown as { highlights?: Partial<WritableHighlightRegistry> }
  ).highlights;
  return typeof registry?.set === 'function' &&
    typeof registry.delete === 'function'
    ? (registry as WritableHighlightRegistry)
    : null;
}

function clearThreadFindHighlights(root?: HTMLElement | null): void {
  const registry = threadFindHighlightRegistry();
  registry?.delete(THREAD_FIND_HIGHLIGHT);
  registry?.delete(THREAD_FIND_ACTIVE_HIGHLIGHT);
  const selection = window.getSelection?.();
  if (
    root &&
    selection?.anchorNode &&
    root.contains(selection.anchorNode)
  ) {
    selection.removeAllRanges();
  }
}

export function findThreadTextRanges(
  root: HTMLElement,
  query: string,
  limit = MAX_THREAD_FIND_MATCHES
): Range[] {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = new RegExp(
    needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'giu'
  );
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !node.nodeValue ||
          !parent ||
          parent.closest(
            'button, input, textarea, select, script, style, [aria-hidden="true"], [data-thread-find-ignore]'
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let node = walker.nextNode();
  while (node && ranges.length < limit) {
    const value = node.nodeValue ?? '';
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match && ranges.length < limit) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
      if (match[0].length === 0) pattern.lastIndex += 1;
      match = pattern.exec(value);
    }
    node = walker.nextNode();
  }
  return ranges;
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

function markdownText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(markdownText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return markdownText(node.props.children);
  }
  return '';
}

export function normalizeAgentMarkdown(text: string): string {
  const trimmed = text.trim();
  const writingBlock = trimmed.match(
    /^:::writing(?:\{[^}\r\n]*\})?[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*:::[ \t]*$/i
  );
  return writingBlock ? writingBlock[1].trim() : text;
}

export type MarkdownLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'projectFile'; path: string }
  | { kind: 'unsupported' };

export function classifyMarkdownLink(href?: string): MarkdownLinkTarget {
  if (!href) return { kind: 'unsupported' };
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? { kind: 'external', url: url.toString() }
        : { kind: 'unsupported' };
    } catch {
      return { kind: 'unsupported' };
    }
  }
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
        return { kind: 'unsupported' };
      }
      return { kind: 'projectFile', path: decodeURIComponent(url.pathname) };
    } catch {
      return { kind: 'unsupported' };
    }
  }
  if (
    href.startsWith('#') ||
    href.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    return { kind: 'unsupported' };
  }
  const path = href.split(/[?#]/, 1)[0];
  if (!path) return { kind: 'unsupported' };
  try {
    return { kind: 'projectFile', path: decodeURIComponent(path) };
  } catch {
    return { kind: 'unsupported' };
  }
}

function MarkdownContent({
  text,
  onCopy,
  onOpenFile
}: {
  text: string;
  onCopy: ConversationTimelineProps['onCopy'];
  onOpenFile: ConversationTimelineProps['onOpenFile'];
}) {
  const components = useMemo<Components>(
    () => ({
      a({ children, href, node: _node, ...props }) {
        const target = classifyMarkdownLink(href);
        const clickable = target.kind !== 'unsupported';
        return (
          <a
            {...props}
            href={target.kind === 'external' ? target.url : clickable ? '#' : undefined}
            rel={target.kind === 'external' ? 'noreferrer' : undefined}
            aria-disabled={!clickable || undefined}
            title={
              props.title ??
              (target.kind === 'projectFile'
                ? `${target.path} · Click or Command-click to open`
                : target.kind === 'unsupported' && href
                  ? `${href} (unsupported link type)`
                  : undefined)
            }
            onClick={(event) => {
              event.preventDefault();
              if (target.kind === 'external') {
                void api.openExternalUrl(target.url).catch(() => undefined);
              } else if (target.kind === 'projectFile') {
                onOpenFile(target.path);
              }
            }}
          >
            {children}
          </a>
        );
      },
      img({ alt }) {
        return (
          <span className="markdown-image-reference">
            <AppIcon name="attachment" size={13} />
            {alt || 'Image'}
          </span>
        );
      },
      pre({ children }) {
        const child = Children.toArray(children)[0];
        const className = isValidElement<{ className?: string }>(child)
          ? child.props.className
          : undefined;
        const language = className?.match(/language-([^\s]+)/)?.[1];
        const code = markdownText(children).replace(/\n$/, '');
        return (
          <div className="markdown-code-block">
            <header>
              <span>{language || 'Code'}</span>
              <button
                type="button"
                aria-label="Copy code"
                onClick={() => onCopy(code, 'Code block')}
              >
                <AppIcon name="copy" size={12} />
                Copy
              </button>
            </header>
            <pre>{children}</pre>
          </div>
        );
      }
    }),
    [onCopy, onOpenFile]
  );

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        skipHtml
      >
        {normalizeAgentMarkdown(text)}
      </ReactMarkdown>
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

function PendingUserMessage({
  submission
}: {
  submission: PendingUserSubmission;
}) {
  const statusLabel =
    submission.status === 'failed'
      ? 'Delivery not confirmed'
      : submission.status === 'accepted'
        ? submission.mode === 'steer'
          ? 'Steer queued'
          : 'Sent to Codex'
        : submission.mode === 'steer'
          ? 'Queueing steer…'
          : 'Sending to Codex…';
  return (
    <article
      className={`timeline-user-message pending-submission ${submission.status}`}
      data-client-message-id={submission.clientId}
    >
      {submission.text ? <TextContent text={submission.text} /> : null}
      {submission.resources.length ? (
        <div className="timeline-message-attachments">
          {submission.resources.map((resource, index) => (
            <span key={`${resource.kind}-${resource.label}-${index}`}>
              <AppIcon
                name={
                  resource.kind === 'image' || resource.kind === 'file'
                    ? 'attachment'
                    : 'code'
                }
              />
              {resource.label}
            </span>
          ))}
        </div>
      ) : null}
      <footer
        className="pending-submission-status"
        role="status"
        aria-live="polite"
        title={submission.error || undefined}
      >
        <span aria-hidden="true" />
        {statusLabel}
      </footer>
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
  onOpenTerminal,
  onOpenBrowser
}: {
  item: CodexItem;
  onCopy: ConversationTimelineProps['onCopy'];
  onOpenTerminal: ConversationTimelineProps['onOpenTerminal'];
  onOpenBrowser: ConversationTimelineProps['onOpenBrowser'];
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
  const localDevelopmentUrl = findLocalDevelopmentUrl(`${output}\n${command}`);
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
            {localDevelopmentUrl && onOpenBrowser ? (
              <button type="button" onClick={() => onOpenBrowser(localDevelopmentUrl)}>
                Open in Browser
              </button>
            ) : null}
            {item.cwd ? <button type="button" onClick={() => onOpenTerminal(item.cwd!)}>Open in Project Terminal</button> : null}
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
          {localDevelopmentUrl && onOpenBrowser ? (
            <button type="button" onClick={() => onOpenBrowser(localDevelopmentUrl)}>
              Open in Browser
            </button>
          ) : null}
          {item.cwd ? <button type="button" onClick={() => onOpenTerminal(item.cwd!)}>Open in Project Terminal</button> : null}
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

function BrowserActivityCard({
  activity,
  onCopy
}: {
  activity: BrowserActivity;
  onCopy: ConversationTimelineProps['onCopy'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState('');
  const failed = activity.status === 'failed' || Boolean(activity.error);
  const running = activity.status === 'inProgress';

  useEffect(() => {
    if (
      !expanded ||
      !activity.screenshotReference ||
      !activity.threadId ||
      screenshot ||
      screenshotError
    ) {
      return;
    }
    let cancelled = false;
    void api
      .readBrowserScreenshot(activity.threadId, activity.screenshotReference)
      .then((result) => {
        if (!cancelled) setScreenshot(result.dataUrl);
      })
      .catch((error) => {
        if (!cancelled) setScreenshotError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    activity.screenshotReference,
    activity.threadId,
    expanded,
    screenshot,
    screenshotError
  ]);

  return (
    <article
      className={`activity-card browser-activity-card ${failed ? 'failed' : running ? 'running' : 'completed'}`}
      data-item-id={activity.id}
      data-browser-activity={activity.activityType}
    >
      <header>
        <span className="activity-icon"><AppIcon name={activity.activityType === 'screenshot' ? 'camera' : 'browser'} /></span>
        <div className="activity-heading">
          <strong>{activity.label}</strong>
          <span>
            {activity.pageTitle || activity.url || (running ? 'Codex is using the browser…' : 'Playwright')}
          </span>
        </div>
        <span className={`browser-activity-state ${failed ? 'failed' : running ? 'running' : 'completed'}`}>
          {failed ? 'Failed' : running ? 'Running' : 'Completed'}
        </span>
      </header>
      {activity.url && activity.pageTitle ? (
        <p className="browser-activity-url" title={activity.url}>{activity.url}</p>
      ) : null}
      {activity.summaryLines.length ? (
        <div className="browser-activity-summary">
          {activity.summaryLines.map((line) => <span key={line}>{line}</span>)}
        </div>
      ) : null}
      {activity.consoleErrorCount > 0 || activity.failedRequestCount > 0 ? (
        <div className="browser-activity-counts">
          {activity.consoleErrorCount > 0 ? <span>{activity.consoleErrorCount} console errors</span> : null}
          {activity.failedRequestCount > 0 ? <span>{activity.failedRequestCount} failed requests</span> : null}
        </div>
      ) : null}
      {activity.error ? <p className="browser-activity-error">{activity.error}</p> : null}
      {expanded && activity.screenshotReference ? (
        <div className="browser-screenshot-preview">
          {screenshot ? (
            <img src={screenshot} alt={`Screenshot from ${activity.pageTitle || 'browser page'}`} />
          ) : screenshotError ? (
            <p>{screenshotError}</p>
          ) : (
            <span>Loading screenshot…</span>
          )}
        </div>
      ) : null}
      <footer className="activity-actions">
        {activity.durationMs != null ? <time>{formatDuration(activity.durationMs)}</time> : null}
        {activity.url ? <button type="button" onClick={() => onCopy(activity.url!, 'Browser URL')}>Copy URL</button> : null}
        {activity.screenshotReference ? (
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide screenshot' : 'View screenshot'}
          </button>
        ) : null}
        {activity.screenshotReference && activity.threadId ? (
          <button
            type="button"
            onClick={() =>
              void api.revealBrowserScreenshot(
                activity.threadId!,
                activity.screenshotReference!
              )
            }
          >
            Reveal
          </button>
        ) : null}
      </footer>
      {activity.details ? (
        <details className="browser-developer-details">
          <summary>Developer details</summary>
          <pre>{JSON.stringify(activity.details, null, 2)}</pre>
        </details>
      ) : null}
    </article>
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

type TimelineItemProps = Pick<
  ConversationTimelineProps,
  | 'onCopy'
  | 'onOpenFile'
  | 'onRevealPath'
  | 'onRevertFile'
  | 'onOpenTerminal'
  | 'onOpenBrowser'
> & { item: CodexItem };

function TimelineItemComponent({
  item,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal,
  onOpenBrowser
}: TimelineItemProps) {
  switch (item.kind) {
    case 'userMessage':
      return <UserMessage item={item} />;
    case 'agentMessage':
      {
        const markdown = item.text ? normalizeAgentMarkdown(item.text) : '';
        return (
          <article
            className={`timeline-agent-message ${item.status === 'inProgress' ? 'streaming' : ''}`}
            data-item-id={item.id}
          >
            <MarkdownContent
              text={item.text || '…'}
              onCopy={onCopy}
              onOpenFile={onOpenFile}
            />
            {item.status !== 'inProgress' && markdown.trim() ? (
              <div className="timeline-agent-message-actions" data-thread-find-ignore>
                <button
                  type="button"
                  aria-label="Copy response as Markdown"
                  title="Copy response as Markdown"
                  onClick={() => onCopy(markdown, 'Markdown response')}
                >
                  <AppIcon name="copy" size={12} />
                  <span>Copy Markdown</span>
                </button>
              </div>
            ) : null}
          </article>
        );
      }
    case 'reasoning':
      return <ReasoningItem item={item} />;
    case 'plan':
      return <PlanItem item={item} />;
    case 'commandExecution':
      return (
        <CommandItem
          item={item}
          onCopy={onCopy}
          onOpenTerminal={onOpenTerminal}
          onOpenBrowser={onOpenBrowser}
        />
      );
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
      return item.browserActivity ? (
        <BrowserActivityCard activity={item.browserActivity} onCopy={onCopy} />
      ) : (
        <ToolItem item={item} />
      );
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

const TimelineItem = memo(
  TimelineItemComponent,
  (previous, next) =>
    previous.item === next.item &&
    previous.onCopy === next.onCopy &&
    previous.onOpenFile === next.onOpenFile &&
    previous.onRevealPath === next.onRevealPath &&
    previous.onRevertFile === next.onRevertFile &&
    previous.onOpenTerminal === next.onOpenTerminal &&
    previous.onOpenBrowser === next.onOpenBrowser
);

function TurnBlockComponent({
  turn,
  approvals,
  onRespondToApproval,
  onRespondToUserInput,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal,
  onOpenBrowser
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
            onOpenBrowser={onOpenBrowser}
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

function ConversationTimelineComponent({
  thread,
  approvals,
  pendingSubmissions = [],
  usage,
  recovering = false,
  onRespondToApproval,
  onRespondToUserInput,
  onCopy,
  onOpenFile,
  onRevealPath,
  onRevertFile,
  onOpenTerminal,
  onOpenBrowser
}: ConversationTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const followingRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const visibleTurnLimitBeforeFindRef = useRef(INITIAL_VISIBLE_TURNS);
  const [unseenBelow, setUnseenBelow] = useState(false);
  const [visibleTurnLimit, setVisibleTurnLimit] = useState(INITIAL_VISIBLE_TURNS);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const [findRevision, setFindRevision] = useState(0);
  const latestTurn = thread.turns.length ? thread.turns[thread.turns.length - 1] : undefined;
  const firstVisibleTurnIndex = Math.max(0, thread.turns.length - visibleTurnLimit);
  const visibleTurns = useMemo(
    () => thread.turns.slice(firstVisibleTurnIndex),
    [firstVisibleTurnIndex, thread.turns]
  );
  const scheduleFollowScroll = useCallback(() => {
    if (!followingRef.current || scrollFrameRef.current != null) return;
    // The sentinel also keeps synchronous requestAnimationFrame test doubles
    // from leaving a stale frame id behind.
    scrollFrameRef.current = -1;
    const frame = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const element = scrollRef.current;
      if (!element || !followingRef.current) return;
      const bottom = element.scrollHeight;
      if (element.scrollTop !== bottom) element.scrollTop = bottom;
      setUnseenBelow((current) => (current ? false : current));
    });
    if (scrollFrameRef.current != null) scrollFrameRef.current = frame;
  }, []);

  const closeFind = () => {
    clearThreadFindHighlights(contentRef.current);
    setFindOpen(false);
    setFindQuery('');
    setFindMatchCount(0);
    setActiveFindIndex(0);
    setVisibleTurnLimit(
      Math.min(
        thread.turns.length,
        Math.max(INITIAL_VISIBLE_TURNS, visibleTurnLimitBeforeFindRef.current)
      )
    );
  };

  const stepFind = (direction: -1 | 1) => {
    if (!findMatchCount) return;
    setActiveFindIndex(
      (current) => (current + direction + findMatchCount) % findMatchCount
    );
  };

  useEffect(() => {
    const openFind = () => {
      setFindOpen((current) => {
        if (!current) {
          visibleTurnLimitBeforeFindRef.current = visibleTurnLimit;
        }
        return true;
      });
      setVisibleTurnLimit(thread.turns.length);
      window.setTimeout(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }, 0);
    };
    const step = (event: Event) => {
      const direction =
        event instanceof CustomEvent && event.detail?.direction === -1 ? -1 : 1;
      if (!findOpen) {
        openFind();
        return;
      }
      stepFind(direction);
    };
    window.addEventListener('atcontroller:find-thread', openFind);
    window.addEventListener('atcontroller:find-thread-step', step);
    return () => {
      window.removeEventListener('atcontroller:find-thread', openFind);
      window.removeEventListener('atcontroller:find-thread-step', step);
    };
  }, [findMatchCount, findOpen, thread.turns.length, visibleTurnLimit]);

  useEffect(() => {
    const root = contentRef.current;
    if (!findOpen || !root || typeof MutationObserver === 'undefined') return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() =>
        setFindRevision((revision) => revision + 1)
      );
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [findOpen]);

  useEffect(() => {
    if (findOpen) setVisibleTurnLimit(thread.turns.length);
  }, [findOpen, thread.turns.length]);

  useEffect(() => {
    const root = contentRef.current;
    clearThreadFindHighlights(root);
    if (!findOpen || !root || !findQuery.trim()) {
      setFindMatchCount(0);
      return;
    }
    const ranges = findThreadTextRanges(root, findQuery);
    setFindMatchCount(ranges.length);
    const nextIndex = ranges.length
      ? Math.min(activeFindIndex, ranges.length - 1)
      : 0;
    if (nextIndex !== activeFindIndex) setActiveFindIndex(nextIndex);
    if (!ranges.length) return;

    const registry = threadFindHighlightRegistry();
    if (registry && typeof Highlight !== 'undefined') {
      const matches = new Highlight(...ranges);
      matches.priority = 0;
      const active = new Highlight(ranges[nextIndex]);
      active.priority = 1;
      registry.set(THREAD_FIND_HIGHLIGHT, matches);
      registry.set(THREAD_FIND_ACTIVE_HIGHLIGHT, active);
    } else {
      const selection = window.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(ranges[nextIndex]);
    }
    const matchElement = ranges[nextIndex].startContainer.parentElement;
    window.requestAnimationFrame(() =>
      matchElement?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
    );
    return () => clearThreadFindHighlights(root);
  }, [
    activeFindIndex,
    findOpen,
    findQuery,
    findRevision,
    visibleTurnLimit
  ]);

  useEffect(() => {
    if (followingRef.current) {
      scheduleFollowScroll();
    } else {
      setUnseenBelow((current) => (current ? current : true));
    }
  }, [latestTurn, pendingSubmissions, scheduleFollowScroll]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (scrollFrameRef.current != null && scrollFrameRef.current >= 0) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = null;
    followingRef.current = true;
    element.scrollTop = element.scrollHeight;
    setUnseenBelow(false);
    scheduleFollowScroll();
  }, [recovering, scheduleFollowScroll, thread.id]);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      scheduleFollowScroll();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleFollowScroll, thread.id]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current != null && scrollFrameRef.current >= 0) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = null;
    },
    []
  );

  useEffect(() => {
    clearThreadFindHighlights(contentRef.current);
    setFindOpen(false);
    setFindQuery('');
    setFindMatchCount(0);
    setActiveFindIndex(0);
    visibleTurnLimitBeforeFindRef.current = INITIAL_VISIBLE_TURNS;
    setVisibleTurnLimit(INITIAL_VISIBLE_TURNS);
  }, [thread.id]);

  const threadApprovals = useMemo(
    () => approvals.filter((approval) => approval.threadId === thread.id),
    [approvals, thread.id]
  );
  const approvalsByTurn = useMemo(() => {
    const grouped = new Map<string, CodexApprovalRequest[]>();
    for (const approval of threadApprovals) {
      if (!approval.turnId) continue;
      const existing = grouped.get(approval.turnId);
      if (existing) existing.push(approval);
      else grouped.set(approval.turnId, [approval]);
    }
    return grouped;
  }, [threadApprovals]);
  const knownTurnIds = useMemo(
    () => new Set(thread.turns.map((turn) => turn.id)),
    [thread.turns]
  );
  const unassociatedApprovals = threadApprovals.filter(
    (approval) => !approval.turnId || !knownTurnIds.has(approval.turnId)
  );
  const runningItems =
    latestTurn?.status === 'inProgress'
      ? latestTurn.items.filter((item) => item.status === 'inProgress')
      : [];
  const runningItem = runningItems.length ? runningItems[runningItems.length - 1] : undefined;
  const usagePresentation = usage ? tokenUsagePresentation(usage) : null;

  return (
    <div className={`conversation-timeline-shell ${findOpen ? 'find-open' : ''}`}>
      {findOpen ? (
        <div
          className="thread-find-bar"
          role="search"
          aria-label="Find in thread"
          data-thread-find-ignore
        >
          <AppIcon name="search" size={14} />
          <input
            ref={findInputRef}
            type="search"
            aria-label="Find in thread"
            placeholder="Find in this thread"
            value={findQuery}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setActiveFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="thread-find-count" role="status" aria-live="polite">
            {!findQuery.trim()
              ? 'Find'
              : findMatchCount
                ? `${activeFindIndex + 1} of ${findMatchCount}`
                : 'No matches'}
          </span>
          <button
            type="button"
            className="icon-button thread-find-previous"
            aria-label="Previous match"
            disabled={!findMatchCount}
            onClick={() => stepFind(-1)}
          >
            <AppIcon name="chevronDown" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next match"
            disabled={!findMatchCount}
            onClick={() => stepFind(1)}
          >
            <AppIcon name="chevronDown" size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close find"
            onClick={closeFind}
          >
            <AppIcon name="close" size={13} />
          </button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="conversation-timeline"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          followingRef.current = atBottom;
          if (atBottom) {
            setUnseenBelow((current) => (current ? false : current));
          }
        }}
      >
        <div ref={contentRef} className="conversation-column">
          {thread.turns.length === 0 && pendingSubmissions.length === 0 && recovering ? (
            <div className="timeline-empty timeline-recovering" role="status">
              <span className="timeline-history-spinner" aria-hidden="true" />
              <h2>Loading thread history</h2>
              <p>Reading this conversation from the local Codex runtime…</p>
            </div>
          ) : thread.turns.length === 0 && pendingSubmissions.length === 0 ? (
            <div className="timeline-empty">
              <span className="empty-kicker">Ready</span>
              <h2>Start with a task</h2>
              <p>Ask Codex to explore this project, change code, run tests, or explain what it finds.</p>
            </div>
          ) : (
            <>
              {firstVisibleTurnIndex > 0 ? (
                <button
                  type="button"
                  className="timeline-load-earlier"
                  onClick={(event) => {
                    const scrollElement = scrollRef.current;
                    const previousHeight = scrollElement?.scrollHeight ?? 0;
                    setVisibleTurnLimit((limit) =>
                      Math.min(thread.turns.length, limit + EARLIER_TURN_PAGE_SIZE)
                    );
                    requestAnimationFrame(() => {
                      if (scrollElement) {
                        scrollElement.scrollTop += scrollElement.scrollHeight - previousHeight;
                      }
                    });
                    event.currentTarget.blur();
                  }}
                >
                  Show {Math.min(firstVisibleTurnIndex, EARLIER_TURN_PAGE_SIZE)} earlier turns
                  <span>{firstVisibleTurnIndex} hidden</span>
                </button>
              ) : null}
              {visibleTurns.map((turn) => (
                <TurnBlock
                  key={turn.id}
                  turn={turn}
                  approvals={approvalsByTurn.get(turn.id) ?? []}
                  onRespondToApproval={onRespondToApproval}
                  onRespondToUserInput={onRespondToUserInput}
                  onCopy={onCopy}
                  onOpenFile={onOpenFile}
                  onRevealPath={onRevealPath}
                  onRevertFile={onRevertFile}
                  onOpenTerminal={onOpenTerminal}
                  onOpenBrowser={onOpenBrowser}
                />
              ))}
            </>
          )}
          {pendingSubmissions.map((submission) => (
            <PendingUserMessage
              key={submission.clientId}
              submission={submission}
            />
          ))}
          {unassociatedApprovals.map((approval) => (
            <ApprovalCard
              key={String(approval.requestId)}
              approval={approval}
              onRespond={onRespondToApproval}
              onRespondToUserInput={onRespondToUserInput}
            />
          ))}
          {usagePresentation ? (
            <div className="token-usage" title={usagePresentation.title}>
              {usagePresentation.label}
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
            followingRef.current = true;
            setUnseenBelow(false);
            scheduleFollowScroll();
          }}
        >
          <AppIcon name="arrowDown" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineComponent);
