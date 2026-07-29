import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConversationTimeline } from '../../src/components/ConversationTimeline';
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
});
