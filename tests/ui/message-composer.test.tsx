import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachmentsToInputs,
  findActiveSkillMention,
  isComposerSkill,
  MessageComposer,
  pathsFromDataTransfer,
  physicalPointInsideRect,
  skillDisplayName,
  skillSourceLabel,
  type ComposerAttachment
} from '../../src/components/MessageComposer';
import type {
  CodexModel,
  CodexPlugin,
  CodexSkill,
  ThreadPreferences
} from '../../src/types';

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

const computerUseSkill: CodexSkill = {
  name: 'computer-use:computer-use',
  description: 'Control local Mac apps through Computer Use.',
  path: '/Users/test/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use/SKILL.md',
  scope: 'user',
  enabled: true
};

const computerUsePlugin: CodexPlugin = {
  id: 'computer-use@openai-bundled',
  name: 'computer-use',
  displayName: 'Computer Use',
  description: 'Control local Mac apps through Computer Use.',
  marketplace: 'openai-bundled',
  enabled: true
};

const projectSkill: CodexSkill = {
  name: 'deployment-verification',
  description: 'Verify a project deployment.',
  path: '/tmp/project/.github/skills/deployment-verification/SKILL.md',
  scope: 'repo',
  enabled: true
};

const unrelatedPluginSkill: CodexSkill = {
  name: 'artifact-template-analytics-dashboard',
  description: 'Create a spreadsheet from an installed artifact template.',
  path: '/Users/test/.codex/plugins/cache/templates/skills/analytics/SKILL.md',
  scope: 'user',
  enabled: true
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const props: React.ComponentProps<typeof MessageComposer> = {
    threadId: 'thread-1',
    workspacePath: '/tmp/project',
    value: 'Run the tests',
    promptHistory: [],
    attachments: [],
    plugins: [],
    selectedPlugins: [],
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
    onSelectedPluginsChange: vi.fn(),
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
    const tier = screen.getByRole('combobox', { name: 'Speed' });
    await user.selectOptions(tier, 'priority');
    expect(props.onPreferencesChange).toHaveBeenCalledWith({
      ...preferences,
      serviceTier: 'priority'
    });
  });

  it('shows the effective runtime speed with a friendly label', () => {
    const runtimeDefaultModel = {
      ...model,
      defaultServiceTier: null
    };
    renderComposer({
      models: [runtimeDefaultModel],
      effectiveServiceTier: 'priority'
    });

    expect(screen.getByRole('combobox', { name: 'Speed' })).toHaveDisplayValue(
      'Speed: Fast'
    );
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

  it('serializes selected plugins with the official structured mention identity', () => {
    expect(attachmentsToInputs('', [], [], [computerUsePlugin])).toEqual([
      {
        type: 'plugin',
        id: 'computer-use@openai-bundled',
        name: 'Computer Use'
      }
    ]);
  });

  it('recognizes active @ skill mentions without treating email addresses as mentions', () => {
    expect(findActiveSkillMention('Use @computer', 13)).toEqual({
      start: 4,
      end: 13,
      query: 'computer'
    });
    expect(findActiveSkillMention('person@example.com', 18)).toBeNull();
    expect(skillDisplayName(computerUseSkill)).toBe('Computer Use');
    expect(skillSourceLabel(computerUseSkill)).toBe('Plugin skill');
    expect(skillSourceLabel(projectSkill)).toBe('Project skill');
    expect(isComposerSkill(computerUseSkill)).toBe(false);
    expect(isComposerSkill(projectSkill)).toBe(true);
    expect(isComposerSkill(unrelatedPluginSkill)).toBe(false);
  });

  it('selects plugin and .github skills through keyboard-first @ autocomplete', async () => {
    const user = userEvent.setup();
    const submit = vi.fn();

    function SkillMentionHarness() {
      const [value, setValue] = useState('');
      const [selectedPlugins, setSelectedPlugins] = useState<CodexPlugin[]>([]);
      const [selectedSkills, setSelectedSkills] = useState<CodexSkill[]>([]);
      return (
        <MessageComposer
          threadId="thread-skills"
          workspacePath="/tmp/project"
          value={value}
          promptHistory={[]}
          attachments={[]}
          plugins={[computerUsePlugin]}
          selectedPlugins={selectedPlugins}
          skills={[projectSkill]}
          selectedSkills={selectedSkills}
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
          onSelectedPluginsChange={setSelectedPlugins}
          onSelectedSkillsChange={setSelectedSkills}
          onPreferencesChange={vi.fn()}
          onPickAttachments={vi.fn()}
          onDropPaths={vi.fn()}
          onSubmit={submit}
          onStop={vi.fn()}
          onRestore={vi.fn()}
        />
      );
    }

    render(<SkillMentionHarness />);
    const composer = screen.getByRole('textbox', { name: 'Message Codex' });
    await user.type(composer, 'Inspect Chrome with @comp');
    expect(
      screen.getByRole('listbox', { name: 'Codex plugins and skills' })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Computer Use/ })).toHaveTextContent(
      'Plugin'
    );
    await user.keyboard('{Enter}');
    expect(screen.getByTitle('computer-use@openai-bundled')).toHaveTextContent(
      '@Computer Use'
    );
    expect(composer).toHaveValue('Inspect Chrome with ');

    await user.type(composer, '@deploy');
    expect(
      screen.getByRole('option', { name: /Deployment Verification/ })
    ).toHaveTextContent('Project skill');
    await user.keyboard('{Enter}');
    expect(screen.getByTitle('deployment-verification')).toHaveTextContent(
      'Deployment Verification'
    );

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(submit).toHaveBeenCalledWith([
      { type: 'text', text: 'Inspect Chrome with ' },
      {
        type: 'skill',
        name: 'deployment-verification',
        path: projectSkill.path
      },
      {
        type: 'plugin',
        id: 'computer-use@openai-bundled',
        name: 'Computer Use'
      }
    ]);
  });

  it('keeps unrelated installed plugin packs out of the composer skill picker', async () => {
    const user = userEvent.setup();
    renderComposer({
      value: '',
      plugins: [computerUsePlugin],
      skills: [unrelatedPluginSkill, computerUseSkill, projectSkill]
    });
    const composer = screen.getByRole('textbox', { name: 'Message Codex' });

    await user.type(composer, '@');

    expect(
      screen.queryByRole('option', { name: /Artifact Template Analytics/ })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Computer Use/ })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Deployment Verification/ })
    ).toBeInTheDocument();
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
    expect(
      physicalPointInsideRect(
        { x: 650, y: 700 },
        { left: 600, right: 700, top: 650, bottom: 750 },
        2,
        900
      )
    ).toBe(true);
    expect(
      physicalPointInsideRect(
        { x: 80, y: 180 },
        { left: 20, right: 120, top: 700, bottom: 760 },
        2,
        800
      )
    ).toBe(true);
  });

  it('recovers macOS file URLs when WebKit omits File.path', () => {
    const transfer = {
      files: [],
      getData: (type: string) =>
        type === 'text/uri-list'
          ? '# Finder files\nfile:///tmp/project/file%20with%20spaces.txt\nhttps://example.test'
          : ''
    } as unknown as DataTransfer;
    expect(pathsFromDataTransfer(transfer)).toEqual([
      '/tmp/project/file with spaces.txt'
    ]);
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

  it('keeps a Finder file drag valid when the final native point uses another origin', async () => {
    (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri = true;
    const onDropPaths = vi.fn(async () => undefined);
    renderComposer({ onDropPaths });
    await waitFor(() => expect(nativeDrop.handler).not.toBeNull());

    act(() => {
      nativeDrop.handler?.({
        payload: {
          type: 'enter',
          paths: ['/tmp/project/from finder.txt'],
          position: { x: 50_000, y: 50_000 }
        }
      });
      nativeDrop.handler?.({
        payload: {
          type: 'drop',
          paths: ['/tmp/project/from finder.txt'],
          position: { x: -50_000, y: -50_000 }
        }
      });
    });

    await waitFor(() =>
      expect(onDropPaths).toHaveBeenCalledWith([
        '/tmp/project/from finder.txt'
      ])
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
          plugins={[]}
          selectedPlugins={[]}
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
          onSelectedPluginsChange={vi.fn()}
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
