import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyMarkdownLink,
  ConversationTimeline,
  findLocalDevelopmentUrl,
  normalizeAgentMarkdown,
  tokenUsagePresentation
} from '../../src/components/ConversationTimeline';
import type { CodexApprovalRequest, CodexThread } from '../../src/types';

function structuredThread(): CodexThread {
  return {
    id: 'thread-1',
    sessionId: 'thread-1',
    title: 'Production work',
    preview: '',
    cwd: '/tmp/project',
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    status: 'idle',
    source: 'appServer',
    cliVersion: '0.144.0',
    archived: false,
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        itemsView: 'full',
        durationMs: 1_250,
        items: [
          {
            id: 'user-1',
            kind: 'userMessage',
            content: [{ kind: 'text', text: 'Create hello.txt' }],
            summary: [],
            reasoning: [],
            changes: []
          },
          {
            id: 'reason-1',
            kind: 'reasoning',
            summary: ['Inspecting the project'],
            reasoning: ['I will check the current files.'],
            content: [],
            changes: []
          },
          {
            id: 'plan-1',
            kind: 'plan',
            status: 'inProgress',
            text: 'Implement and verify',
            details: {
              plan: [
                { step: 'Create the file', status: 'completed' },
                { step: 'Run verification', status: 'inProgress' }
              ]
            },
            summary: [],
            reasoning: [],
            content: [],
            changes: []
          },
          {
            id: 'command-1',
            kind: 'commandExecution',
            status: 'completed',
            command: 'printf hello > hello.txt',
            cwd: '/tmp/project',
            output: 'created hello.txt\n',
            exitCode: 0,
            durationMs: 20,
            summary: [],
            reasoning: [],
            content: [],
            changes: []
          },
          {
            id: 'file-1',
            kind: 'fileChange',
            status: 'completed',
            summary: [],
            reasoning: [],
            content: [],
            changes: [
              {
                path: '/tmp/project/hello.txt',
                kind: 'add',
                diff: '--- /dev/null\n+++ b/hello.txt\n+hello\n'
              }
            ]
          },
          {
            id: 'agent-1',
            kind: 'agentMessage',
            text: 'Created the file and verified it.',
            summary: [],
            reasoning: [],
            content: [],
            changes: []
          }
        ]
      }
    ]
  };
}

describe('structured Codex timeline', () => {
  it('classifies only safe web URLs and project file links', () => {
    expect(classifyMarkdownLink('https://example.com/docs?a=1')).toEqual({
      kind: 'external',
      url: 'https://example.com/docs?a=1'
    });
    expect(classifyMarkdownLink('/tmp/project/design%20notes.md#summary')).toEqual({
      kind: 'projectFile',
      path: '/tmp/project/design notes.md'
    });
    expect(classifyMarkdownLink('docs/conclusion.md')).toEqual({
      kind: 'projectFile',
      path: 'docs/conclusion.md'
    });
    expect(classifyMarkdownLink('javascript:alert(1)')).toEqual({
      kind: 'unsupported'
    });
  });

  it('opens an absolute Markdown file link on Command-click', () => {
    const thread = structuredThread();
    const agent = thread.turns[0].items.find(
      (item) => item.kind === 'agentMessage'
    )!;
    agent.text =
      'See [Current Master Control](/tmp/project/experiments/control/conclusion.md).';
    const onOpenFile = vi.fn();
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={onOpenFile}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole('link', { name: 'Current Master Control' }),
      { metaKey: true }
    );
    expect(onOpenFile).toHaveBeenCalledWith(
      '/tmp/project/experiments/control/conclusion.md'
    );
  });

  it('defers Markdown parsing until a streamed agent message completes', () => {
    const thread = structuredThread();
    thread.turns = [
      {
        id: 'turn-live',
        status: 'inProgress',
        itemsView: 'full',
        items: [
          {
            id: 'agent-live',
            kind: 'agentMessage',
            status: 'inProgress',
            text: 'Read [the docs](https://example.com/docs)',
            summary: [],
            reasoning: [],
            content: [],
            changes: []
          }
        ]
      }
    ];
    const callbacks = {
      onRespondToApproval: vi.fn(),
      onRespondToUserInput: vi.fn(),
      onCopy: vi.fn(),
      onOpenFile: vi.fn(),
      onRevealPath: vi.fn(),
      onRevertFile: vi.fn(),
      onOpenTerminal: vi.fn()
    };
    const { rerender } = render(
      <ConversationTimeline thread={thread} approvals={[]} {...callbacks} />
    );

    expect(screen.queryByRole('link', { name: 'the docs' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Read [the docs](https://example.com/docs)')
    ).toBeInTheDocument();

    const completed = structuredThread();
    completed.turns = [
      {
        ...thread.turns[0],
        status: 'completed',
        items: [{ ...thread.turns[0].items[0], status: 'completed' }]
      }
    ];
    rerender(
      <ConversationTimeline thread={completed} approvals={[]} {...callbacks} />
    );

    expect(screen.getByRole('link', { name: 'the docs' })).toBeInTheDocument();
  });

  it('refreshes completed-turn actions when callback props change', () => {
    const thread = structuredThread();
    const firstCopy = vi.fn();
    const secondCopy = vi.fn();
    const callbacks = {
      onRespondToApproval: vi.fn(),
      onRespondToUserInput: vi.fn(),
      onOpenFile: vi.fn(),
      onRevealPath: vi.fn(),
      onRevertFile: vi.fn(),
      onOpenTerminal: vi.fn()
    };
    const { rerender } = render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onCopy={firstCopy}
        {...callbacks}
      />
    );
    rerender(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onCopy={secondCopy}
        {...callbacks}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy response as Markdown' }));
    expect(firstCopy).not.toHaveBeenCalled();
    expect(secondCopy).toHaveBeenCalledWith(
      'Created the file and verified it.',
      'Markdown response'
    );
  });

  it('uses the current context rather than cumulative thread tokens for context percentage', () => {
    expect(
      tokenUsagePresentation({
        totalTokens: 41_633_086,
        inputTokens: 41_000_000,
        cachedInputTokens: 0,
        outputTokens: 633_086,
        reasoningOutputTokens: 0,
        lastTotalTokens: 32_000,
        modelContextWindow: 256_000
      })
    ).toEqual({
      label: '32,000 tokens · 13% context',
      title:
        'Current context: 32,000 of 256,000 tokens. ' +
        'Thread cumulative: 41,633,086 tokens.'
    });
  });

  it('distinguishes history recovery from a genuinely empty thread', () => {
    const thread = structuredThread();
    thread.turns = [];
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        recovering
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading thread history');
    expect(screen.queryByText('Start with a task')).not.toBeInTheDocument();
  });

  it('renders an optimistic user bubble and its delivery state immediately', () => {
    const thread = structuredThread();
    thread.turns = [];
    const callbacks = {
      onRespondToApproval: vi.fn(),
      onRespondToUserInput: vi.fn(),
      onCopy: vi.fn(),
      onOpenFile: vi.fn(),
      onRevealPath: vi.fn(),
      onRevertFile: vi.fn(),
      onOpenTerminal: vi.fn()
    };
    const { rerender } = render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        pendingSubmissions={[
          {
            clientId: 'client-1',
            threadId: 'thread-1',
            mode: 'turn',
            status: 'sending',
            text: 'Check the current implementation',
            resources: [{ kind: 'file', label: 'notes.md' }],
            submittedAt: 1
          }
        ]}
        {...callbacks}
      />
    );

    expect(screen.getByText('Check the current implementation')).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sending to Codex…');
    expect(screen.queryByText('Start with a task')).not.toBeInTheDocument();

    rerender(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        pendingSubmissions={[
          {
            clientId: 'client-1',
            threadId: 'thread-1',
            mode: 'steer',
            status: 'accepted',
            text: 'Check the current implementation',
            resources: [],
            submittedAt: 1
          }
        ]}
        {...callbacks}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Steer queued');
  });

  it('renders recent history first and progressively reveals long conversations', async () => {
    const user = userEvent.setup();
    const thread = structuredThread();
    thread.turns = Array.from({ length: 50 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [
        {
          id: `message-${index + 1}`,
          kind: 'agentMessage',
          text: `History message ${index + 1}`,
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        }
      ]
    }));
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.queryByText('History message 1')).not.toBeInTheDocument();
    expect(screen.getByText('History message 50')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show 24 earlier turns/ }));
    expect(screen.getByText('History message 3')).toBeInTheDocument();
    expect(screen.queryByText('History message 1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show 2 earlier turns/ }));
    expect(screen.getByText('History message 1')).toBeInTheDocument();
  });

  it('pins a newly opened thread to the latest content through late layout changes', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    let resizeCallback: ResizeObserverCallback | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let frameId = 0;

    class ResizeObserverHarness {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this as unknown as ResizeObserver;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver =
      ResizeObserverHarness as unknown as typeof ResizeObserver;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(performance.now());
      frameId += 1;
      return frameId;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();

    const callbacks = {
      onRespondToApproval: vi.fn(),
      onRespondToUserInput: vi.fn(),
      onCopy: vi.fn(),
      onOpenFile: vi.fn(),
      onRevealPath: vi.fn(),
      onRevertFile: vi.fn(),
      onOpenTerminal: vi.fn()
    };
    const firstThread = structuredThread();
    const { container, rerender, unmount } = render(
      <ConversationTimeline
        thread={firstThread}
        approvals={[]}
        {...callbacks}
      />
    );
    const scrollElement = container.querySelector<HTMLElement>(
      '.conversation-timeline'
    )!;
    let scrollHeight = 1_000;
    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight
    });
    Object.defineProperty(scrollElement, 'clientHeight', {
      configurable: true,
      get: () => 300
    });

    const secondThread = {
      ...structuredThread(),
      id: 'thread-2',
      sessionId: 'thread-2'
    };
    rerender(
      <ConversationTimeline
        thread={secondThread}
        approvals={[]}
        {...callbacks}
      />
    );
    expect(scrollElement.scrollTop).toBe(1_000);

    scrollHeight = 1_600;
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(scrollElement.scrollTop).toBe(1_600);

    scrollElement.scrollTop = 400;
    fireEvent.scroll(scrollElement);
    scrollHeight = 2_000;
    act(() => {
      resizeCallback?.([], resizeObserver!);
    });
    expect(scrollElement.scrollTop).toBe(400);

    unmount();
    globalThis.ResizeObserver = originalResizeObserver;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('finds and navigates matches across the full thread with Command-F events', async () => {
    const user = userEvent.setup();
    const thread = structuredThread();
    thread.turns = Array.from({ length: 30 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      itemsView: 'full',
      items: [
        {
          id: `message-${index + 1}`,
          kind: 'agentMessage',
          text:
            index === 0 || index === 29
              ? `Unique needle in message ${index + 1}`
              : `History message ${index + 1}`,
          summary: [],
          reasoning: [],
          content: [],
          changes: []
        }
      ]
    }));
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.queryByText('Unique needle in message 1')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('atcontroller:find-thread'));
    });
    const input = await screen.findByRole('searchbox', { name: 'Find in thread' });
    await user.type(input, 'needle');
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Unique needle in message 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(await screen.findByText('2 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(
      screen.queryByRole('searchbox', { name: 'Find in thread' })
    ).not.toBeInTheDocument();
  });

  it('renders messages, commands, output, file edits, and completion as distinct items', async () => {
    const user = userEvent.setup();
    const openFile = vi.fn();
    const revealPath = vi.fn();
    const revertFile = vi.fn();
    render(
      <ConversationTimeline
        thread={structuredThread()}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={openFile}
        onRevealPath={revealPath}
        onRevertFile={revertFile}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('Create hello.txt')).toBeInTheDocument();
    expect(screen.getByText('Inspecting the project')).toBeInTheDocument();
    expect(screen.getByText('Create the file')).toBeInTheDocument();
    expect(screen.getByText('Run verification')).toBeInTheDocument();
    expect(screen.getByText('printf hello > hello.txt')).toBeInTheDocument();
    expect(screen.getByText('Changed file')).toBeInTheDocument();
    expect(screen.getByText('Created the file and verified it.')).toBeInTheDocument();
    expect(screen.getByText('Completed', { selector: '.turn-completion span' })).toBeInTheDocument();
    expect(document.querySelector('.current-action')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByText(/created hello.txt/)).toBeInTheDocument();
    await user.click(screen.getByText('/tmp/project/hello.txt'));
    expect(screen.getByText(/\+hello/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open file' }));
    await user.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    await user.click(screen.getByRole('button', { name: 'Revert file…' }));
    expect(openFile).toHaveBeenCalledWith('/tmp/project/hello.txt');
    expect(revealPath).toHaveBeenCalledWith('/tmp/project/hello.txt');
    expect(revertFile).toHaveBeenCalledWith('/tmp/project/hello.txt');
  });

  it('paces live Markdown presentation and reveals the completed response immediately', () => {
    vi.useFakeTimers();
    try {
      const base = structuredThread();
      const withAgentText = (
        text: string,
        status: 'inProgress' | 'completed'
      ): CodexThread => ({
        ...base,
        turns: base.turns.map((turn) => ({
          ...turn,
          status,
          items: turn.items.map((item) =>
            item.kind === 'agentMessage' ? { ...item, status, text } : item
          )
        }))
      });
      const props = {
        approvals: [],
        onRespondToApproval: vi.fn(),
        onRespondToUserInput: vi.fn(),
        onCopy: vi.fn(),
        onOpenFile: vi.fn(),
        onRevealPath: vi.fn(),
        onRevertFile: vi.fn(),
        onOpenTerminal: vi.fn()
      };
      const { rerender } = render(
        <ConversationTimeline
          {...props}
          thread={withAgentText('First streamed fragment', 'inProgress')}
        />
      );

      rerender(
        <ConversationTimeline
          {...props}
          thread={withAgentText('Second streamed fragment', 'inProgress')}
        />
      );
      expect(screen.getByText('First streamed fragment')).toBeInTheDocument();
      expect(screen.queryByText('Second streamed fragment')).toBeNull();

      act(() => vi.advanceTimersByTime(48));
      expect(screen.getByText('Second streamed fragment')).toBeInTheDocument();

      rerender(
        <ConversationTimeline
          {...props}
          thread={withAgentText('Final response', 'completed')}
        />
      );
      expect(screen.getByText('Final response')).toBeInTheDocument();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('offers local development-server URLs to the isolated browser', async () => {
    expect(
      findLocalDevelopmentUrl(
        'ready at http://0.0.0.0:4317/dashboard?token=temporary.'
      )
    ).toBe('http://127.0.0.1:4317/dashboard?token=temporary');
    expect(findLocalDevelopmentUrl('https://example.com')).toBeNull();

    const user = userEvent.setup();
    const onOpenBrowser = vi.fn();
    const thread = structuredThread();
    const command = thread.turns[0].items.find(
      (item) => item.kind === 'commandExecution'
    )!;
    command.output = 'Vite ready at http://localhost:5173/';
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
        onOpenBrowser={onOpenBrowser}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Open in Browser' }));
    expect(onOpenBrowser).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('renders safe GitHub-flavored Markdown with copyable fenced code', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const thread = structuredThread();
    const agent = thread.turns[0].items.find((item) => item.kind === 'agentMessage')!;
    agent.text = [
      'Queried **256,166 ERROR rows** total.',
      '',
      '- First result',
      '- Second result',
      '',
      '```kusto',
      'let errors = materialize(ctc_pipeline_logs);',
      'errors | count',
      '```',
      '',
      '| Status | Count |',
      '| --- | ---: |',
      '| Failed | 256166 |',
      '',
      '<script>unsafe()</script>',
      '',
      '![Remote image](https://example.com/tracker.png)'
    ].join('\n');

    const { container } = render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={onCopy}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );

    expect(screen.getByText('256,166 ERROR rows')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('First result').closest('li')).not.toBeNull();
    expect(screen.getByText('Failed').closest('table')).not.toBeNull();
    expect(screen.getByText('kusto')).toBeInTheDocument();
    expect(screen.queryByText(/```kusto/)).not.toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Remote image')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(onCopy).toHaveBeenCalledWith(
      'let errors = materialize(ctc_pipeline_logs);\nerrors | count',
      'Code block'
    );

    await user.click(
      screen.getByRole('button', { name: 'Copy response as Markdown' })
    );
    expect(onCopy).toHaveBeenLastCalledWith(agent.text, 'Markdown response');
  });

  it('unwraps balanced structured writing envelopes before rendering Markdown', () => {
    const wrapped = [
      ':::writing{variant="chat_message" id="48217"} Good morning team.',
      '',
      '- **Design:** Add the document.',
      '- Keep the negative ID canonical.',
      '',
      'We will review it together. :::'
    ].join('\n');
    expect(normalizeAgentMarkdown(wrapped)).toBe(
      [
        'Good morning team.',
        '',
        '- **Design:** Add the document.',
        '- Keep the negative ID canonical.',
        '',
        'We will review it together.'
      ].join('\n')
    );
    expect(normalizeAgentMarkdown('Keep this ordinary ::: marker')).toBe(
      'Keep this ordinary ::: marker'
    );

    const thread = structuredThread();
    const agent = thread.turns[0].items.find(
      (item) => item.kind === 'agentMessage'
    )!;
    agent.text = wrapped;
    const { container } = render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );

    expect(screen.getByText('Design:')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByText('Keep the negative ID canonical.').closest('li')).not.toBeNull();
    expect(container).not.toHaveTextContent(':::writing');
    expect(container).not.toHaveTextContent('review it together. :::');
  });

  it('keeps large diffs compact until the user requests the full patch', async () => {
    const user = userEvent.setup();
    const thread = structuredThread();
    const fileItem = thread.turns[0].items.find((item) => item.kind === 'fileChange')!;
    fileItem.changes[0].diff = Array.from(
      { length: 100 },
      (_, index) => `+line ${index + 1}`
    ).join('\n');
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    await user.click(screen.getByText('/tmp/project/hello.txt'));
    expect(screen.queryByText('+line 100')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show full diff' }));
    expect(screen.getByText('+line 100')).toBeInTheDocument();
  });

  it('renders an inline approval and exposes protocol decisions', async () => {
    const user = userEvent.setup();
    const approval: CodexApprovalRequest = {
      requestId: 7,
      approvalType: 'commandExecution',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'git push',
      cwd: '/tmp/project',
      reason: 'Publishing requires approval',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel']
    };
    const respond = vi.fn();
    render(
      <ConversationTimeline
        thread={structuredThread()}
        approvals={[approval]}
        onRespondToApproval={respond}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('Command needs approval')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve for session' }));
    expect(respond).toHaveBeenCalledWith(approval, 'acceptForSession');
  });

  it('shows structured permission scope and supports a session-scoped grant', async () => {
    const user = userEvent.setup();
    const approval: CodexApprovalRequest = {
      requestId: 'permission-1',
      approvalType: 'permissions',
      threadId: 'thread-1',
      turnId: 'turn-1',
      grantRoot: '/tmp/project',
      requestedPermissions: {
        fileSystem: { read: ['/tmp/project'], write: ['/tmp/project'] }
      },
      availableDecisions: ['accept', 'acceptForSession', 'decline']
    };
    const respond = vi.fn();
    render(
      <ConversationTimeline
        thread={structuredThread()}
        approvals={[approval]}
        onRespondToApproval={respond}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('Filesystem scope: /tmp/project')).toBeInTheDocument();
    await user.click(screen.getByText('Show requested permissions'));
    expect(screen.getByText(/fileSystem/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve for session' }));
    expect(respond).toHaveBeenCalledWith(approval, 'acceptForSession');
  });

  it('renders and answers a structured Codex user-input request', async () => {
    const user = userEvent.setup();
    const approval: CodexApprovalRequest = {
      requestId: 'question-1',
      approvalType: 'userInput',
      threadId: 'thread-1',
      turnId: 'turn-1',
      availableDecisions: ['answer', 'cancel'],
      payload: {
        questions: [
          {
            id: 'approach',
            header: 'Approach',
            question: 'Which implementation should Codex use?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Structured', description: 'Use app-server events.' },
              { label: 'Pause', description: 'Wait for more context.' }
            ]
          }
        ]
      }
    };
    const answer = vi.fn();
    render(
      <ConversationTimeline
        thread={structuredThread()}
        approvals={[approval]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={answer}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    await user.click(screen.getByRole('radio', { name: /Structured/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(answer).toHaveBeenCalledWith(approval, { approach: ['Structured'] });
  });

  it('keeps an approval visible even when its turn arrives later', () => {
    const approval: CodexApprovalRequest = {
      requestId: 'early-approval',
      approvalType: 'fileChange',
      threadId: 'thread-1',
      turnId: 'turn-not-hydrated',
      reason: 'Write access is required',
      availableDecisions: ['accept', 'decline']
    };
    render(
      <ConversationTimeline
        thread={structuredThread()}
        approvals={[approval]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('File Change needs approval')).toBeInTheDocument();
    expect(screen.getByText('Write access is required')).toBeInTheDocument();
  });

  it('summarizes image attachments without rendering inline image data', () => {
    const thread = structuredThread();
    thread.turns[0].items[0] = {
      ...thread.turns[0].items[0],
      content: [
        { kind: 'text', text: 'Review this image' },
        { kind: 'image', url: 'data:image/png;base64,INLINEIMAGEBYTES' }
      ]
    };
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('Pasted image')).toBeInTheDocument();
    expect(screen.queryByText(/INLINEIMAGEBYTES/)).not.toBeInTheDocument();
  });

  it('renders structured Playwright activity without exposing raw form input', () => {
    const thread = structuredThread();
    thread.turns[0].items.splice(1, 0, {
      id: 'browser-1',
      kind: 'mcpToolCall',
      status: 'completed',
      toolServer: 'atcontroller-playwright',
      toolName: 'browser_click',
      toolArguments: { element: 'Create project', value: '[redacted]' },
      browserActivity: {
        id: 'browser-1',
        activityType: 'click',
        label: 'Clicked “Create project”',
        status: 'completed',
        server: 'atcontroller-playwright',
        tool: 'browser_click',
        threadId: 'thread-1',
        turnId: 'turn-1',
        pageTitle: 'Projects',
        url: 'http://127.0.0.1:3000/projects',
        target: 'Create project',
        consoleErrorCount: 0,
        failedRequestCount: 0,
        summaryLines: [],
        details: { value: '[redacted]' },
        timestamp: '2026-07-29T12:00:00Z'
      },
      summary: [],
      reasoning: [],
      content: [],
      changes: []
    });
    render(
      <ConversationTimeline
        thread={thread}
        approvals={[]}
        onRespondToApproval={vi.fn()}
        onRespondToUserInput={vi.fn()}
        onCopy={vi.fn()}
        onOpenFile={vi.fn()}
        onRevealPath={vi.fn()}
        onRevertFile={vi.fn()}
        onOpenTerminal={vi.fn()}
      />
    );
    expect(screen.getByText('Clicked “Create project”')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.queryByText('do-not-persist')).not.toBeInTheDocument();
  });
});
