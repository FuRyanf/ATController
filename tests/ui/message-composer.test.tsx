import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachmentsToInputs,
  MessageComposer,
  physicalPointInsideRect,
  type ComposerAttachment
} from '../../src/components/MessageComposer';
import type { CodexModel, ThreadPreferences } from '../../src/types';

const nativeDrop = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async (handler: (event: { payload: unknown }) => void) => {
      nativeDrop.handler = handler;
      return () => {
        nativeDrop.handler = null;
      };
    }
  })
}));

const model: CodexModel = {
  id: 'runtime-model',
  model: 'runtime-model',
  displayName: 'Runtime Model',
  description: '',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'high',
  reasoningEfforts: [
    { value: 'medium', description: '' },
    { value: 'high', description: '' },
    { value: 'ultra', description: '' }
  ],
  serviceTiers: [
    { id: 'standard', name: 'Standard', description: '' },
    { id: 'priority', name: 'Fast', description: '' }
  ],
  defaultServiceTier: 'standard',
  inputModalities: ['text', 'image']
};

const preferences: ThreadPreferences = {
  permissionMode: 'fullAccess',
  model: 'runtime-model',
  reasoningEffort: 'high',
  serviceTier: null
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const props: React.ComponentProps<typeof MessageComposer> = {
    threadId: 'thread-1',
    workspacePath: '/tmp/project',
    value: 'Run the tests',
    promptHistory: [],
    attachments: [],
    skills: [],
    selectedSkills: [],
    preferences,
    models: [model],
    archived: false,
    running: false,
    connected: true,
    recovering: false,
    submitting: false,
    commandEnterToSend: true,
    onChange: vi.fn(),
    onAttachmentsChange: vi.fn(),
    onSelectedSkillsChange: vi.fn(),
    onPreferencesChange: vi.fn(),
    onPickAttachments: vi.fn(),
    onDropPaths: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    onRestore: vi.fn(),
    ...overrides
  };
  render(<MessageComposer {...props} />);
  return props;
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri;
  nativeDrop.handler = null;
});

describe('Codex message composer', () => {
  it('sends on Enter and preserves a newline on Shift Enter', async () => {
    const props = renderComposer();
    const composer = screen.getByRole('textbox', {
      name: 'Message Codex'
    }) as HTMLTextAreaElement;

    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(props.onSubmit).toHaveBeenCalledWith([{ type: 'text', text: 'Run the tests' }]);
  });

  it('shows runtime-derived model, Ultra reasoning, Full Access, and usage', async () => {
    const user = userEvent.setup();
    const props = renderComposer({
      fiveHourLimit: { usedPercent: 25, windowDurationMins: 300 },
      weeklyLimit: { usedPercent: 60, windowDurationMins: 10_080 }
    });

    expect(screen.getByText(/5h 75% left · Week 40% left/)).toBeInTheDocument();
    expect(screen.getByText(/Full Access — Codex may read/)).toBeInTheDocument();

    const effort = screen.getByRole('combobox', { name: 'Reasoning effort' });
    await user.selectOptions(effort, 'ultra');
    expect(props.onPreferencesChange).toHaveBeenCalledWith({
      ...preferences,
      reasoningEffort: 'ultra'
    });
    const tier = screen.getByRole('combobox', { name: 'Service tier' });
    await user.selectOptions(tier, 'priority');
    expect(props.onPreferencesChange).toHaveBeenCalledWith({
      ...preferences,
      serviceTier: 'priority'
    });
  });

  it('serializes path attachments and bounded inline images as structured inputs', () => {
    const attachments: ComposerAttachment[] = [
      {
        id: 'file',
        name: 'notes.txt',
        kind: 'file',
        path: '/tmp/project/notes.txt',
        outsideWorkspace: false
      },
      {
        id: 'image',
        name: 'paste.png',
        kind: 'image',
        dataUrl: 'data:image/png;base64,AAAA',
        outsideWorkspace: false
      }
    ];
    expect(attachmentsToInputs('Review these', attachments)).toEqual([
      { type: 'text', text: 'Review these' },
      {
        type: 'file',
        path: '/tmp/project/notes.txt',
        name: 'notes.txt',
        allowOutsideWorkspace: false
      },
      { type: 'image', url: 'data:image/png;base64,AAAA', detail: 'auto' }
    ]);
  });

  it('serializes selected runtime skills with the official structured input shape', () => {
    expect(
      attachmentsToInputs('', [], [
        {
          name: 'review',
          description: 'Review changes',
          path: '/tmp/skills/review/SKILL.md',
          scope: 'user',
          enabled: true
        }
      ])
    ).toEqual([
      { type: 'skill', name: 'review', path: '/tmp/skills/review/SKILL.md' }
    ]);
  });

  it('maps native physical drag coordinates into the composer CSS bounds', () => {
    expect(
      physicalPointInsideRect(
        { x: 80, y: 120 },
        { left: 20, right: 120, top: 40, bottom: 100 },
        2
      )
    ).toBe(true);
    expect(
      physicalPointInsideRect(
        { x: 10, y: 120 },
        { left: 20, right: 120, top: 40, bottom: 100 },
        2
      )
    ).toBe(false);
  });

  it('accepts file paths from the native Tauri drop event', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    const onDropPaths = vi.fn(async () => undefined);
    renderComposer({ onDropPaths });
    await waitFor(() => expect(nativeDrop.handler).not.toBeNull());

    act(() => {
      nativeDrop.handler?.({
        payload: {
          type: 'enter',
          paths: ['/tmp/project/notes.txt'],
          position: { x: 0, y: 0 }
        }
      });
    });
    expect(screen.getByText('Drop files or images to attach')).toBeInTheDocument();

    act(() => {
      nativeDrop.handler?.({
        payload: {
          type: 'drop',
          paths: ['/tmp/project/notes.txt'],
          position: { x: 0, y: 0 }
        }
      });
    });
    await waitFor(() =>
      expect(onDropPaths).toHaveBeenCalledWith(['/tmp/project/notes.txt'])
    );
  });

  it('offers Stop and steering while a turn is running', async () => {
    const user = userEvent.setup();
    const props = renderComposer({ running: true });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(props.onStop).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Steer active turn' }));
    expect(props.onSubmit).toHaveBeenCalled();
  });

  it('keeps archived threads readable and requires an explicit restore before continuing', async () => {
    const user = userEvent.setup();
    const props = renderComposer({ archived: true });
    expect(screen.queryByRole('textbox', { name: 'Message Codex' })).not.toBeInTheDocument();
    expect(screen.getByText('Thread archived')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore thread' }));
    expect(props.onRestore).toHaveBeenCalledOnce();
  });

  it('honors the optional Command Enter shortcut', () => {
    const disabled = renderComposer({ commandEnterToSend: false });
    const composer = screen.getByRole('textbox', {
      name: 'Message Codex'
    }) as HTMLTextAreaElement;
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(disabled.onSubmit).not.toHaveBeenCalled();
  });

  it('recalls and restores per-thread prompt history with arrow keys', async () => {
    const submit = vi.fn();
    function HistoryHarness() {
      const [value, setValue] = useState('');
      return (
        <MessageComposer
          threadId="thread-history"
          workspacePath="/tmp/project"
          value={value}
          promptHistory={['First prompt', 'Most recent prompt']}
          attachments={[]}
          skills={[]}
          selectedSkills={[]}
          preferences={preferences}
          models={[model]}
          archived={false}
          running={false}
          connected
          recovering={false}
          submitting={false}
          commandEnterToSend
          onChange={setValue}
          onAttachmentsChange={vi.fn()}
          onSelectedSkillsChange={vi.fn()}
          onPreferencesChange={vi.fn()}
          onPickAttachments={vi.fn()}
          onDropPaths={vi.fn()}
          onSubmit={submit}
          onStop={vi.fn()}
          onRestore={vi.fn()}
        />
      );
    }
    render(<HistoryHarness />);
    const composer = screen.getByRole('textbox', {
      name: 'Message Codex'
    }) as HTMLTextAreaElement;
    fireEvent.keyDown(composer, { key: 'ArrowUp' });
    expect(composer).toHaveValue('Most recent prompt');
    composer.setSelectionRange(0, 0);
    fireEvent.keyDown(composer, { key: 'ArrowUp' });
    expect(composer).toHaveValue('First prompt');
    composer.setSelectionRange(composer.value.length, composer.value.length);
    fireEvent.keyDown(composer, { key: 'ArrowDown' });
    expect(composer).toHaveValue('Most recent prompt');
  });
});
