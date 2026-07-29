import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';

import type {
  CodexModel,
  CodexRateLimitWindowV2,
  CodexSkill,
  ComposerInput,
  PermissionMode,
  ThreadPreferences
} from '../types';
import { AppIcon } from './AppIcon';

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  path?: string;
  dataUrl?: string;
  outsideWorkspace: boolean;
}

interface MessageComposerProps {
  threadId: string;
  workspacePath: string;
  value: string;
  promptHistory: string[];
  attachments: ComposerAttachment[];
  skills: CodexSkill[];
  selectedSkills: CodexSkill[];
  preferences: ThreadPreferences;
  models: CodexModel[];
  fiveHourLimit?: CodexRateLimitWindowV2 | null;
  weeklyLimit?: CodexRateLimitWindowV2 | null;
  archived: boolean;
  running: boolean;
  connected: boolean;
  recovering: boolean;
  submitting: boolean;
  commandEnterToSend: boolean;
  onChange: (value: string) => void;
  onAttachmentsChange: (attachments: ComposerAttachment[]) => void;
  onSelectedSkillsChange: (skills: CodexSkill[]) => void;
  onPreferencesChange: (preferences: ThreadPreferences) => void;
  onPickAttachments: () => void;
  onSubmit: (inputs: ComposerInput[]) => void;
  onStop: () => void;
  onRestore: () => void;
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function pathInsideWorkspace(path: string, workspacePath: string): boolean {
  const root = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path === workspacePath || path.startsWith(root);
}

function filePath(file: File): string | null {
  const candidate = (file as File & { path?: string }).path;
  return typeof candidate === 'string' && candidate.startsWith('/') ? candidate : null;
}

async function imageAttachment(file: File, workspacePath: string): Promise<ComposerAttachment> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Images must be PNG, JPEG, GIF, or WebP.');
  }
  if (file.size > MAX_INLINE_IMAGE_BYTES) {
    throw new Error('Images are limited to 10 MB.');
  }
  const path = filePath(file);
  if (path) {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      kind: 'image',
      path,
      outsideWorkspace: !pathInsideWorkspace(path, workspacePath)
    };
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read image.'));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image.'));
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    name: file.name || 'Pasted image',
    kind: 'image',
    dataUrl,
    outsideWorkspace: false
  };
}

function formatAllowance(window?: CodexRateLimitWindowV2 | null): string {
  if (!window) return '—';
  return `${Math.max(0, Math.round(100 - window.usedPercent))}% left`;
}

export function attachmentsToInputs(
  text: string,
  attachments: ComposerAttachment[],
  skills: CodexSkill[] = []
): ComposerInput[] {
  const inputs: ComposerInput[] = [];
  if (text.trim()) {
    inputs.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    if (attachment.dataUrl) {
      inputs.push({ type: 'image', url: attachment.dataUrl, detail: 'auto' });
    } else if (attachment.path && attachment.kind === 'image') {
      inputs.push({
        type: 'localImage',
        path: attachment.path,
        detail: 'auto',
        allowOutsideWorkspace: attachment.outsideWorkspace
      });
    } else if (attachment.path) {
      inputs.push({
        type: 'file',
        path: attachment.path,
        name: attachment.name,
        allowOutsideWorkspace: attachment.outsideWorkspace
      });
    }
  }
  for (const skill of skills) {
    inputs.push({ type: 'skill', name: skill.name, path: skill.path });
  }
  return inputs;
}

export function MessageComposer({
  threadId,
  workspacePath,
  value,
  promptHistory,
  attachments,
  skills,
  selectedSkills,
  preferences,
  models,
  fiveHourLimit,
  weeklyLimit,
  archived,
  running,
  connected,
  recovering,
  submitting,
  commandEnterToSend,
  onChange,
  onAttachmentsChange,
  onSelectedSkillsChange,
  onPreferencesChange,
  onPickAttachments,
  onSubmit,
  onStop,
  onRestore
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const selectedModel =
    models.find((model) => model.id === preferences.model || model.model === preferences.model) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const efforts = selectedModel?.reasoningEfforts ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const canSubmit =
    connected &&
    !archived &&
    !recovering &&
    !submitting &&
    Boolean(value.trim() || attachments.length || selectedSkills.length);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(240, Math.max(44, textarea.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener('atcontroller:focus-composer', focus);
    return () => window.removeEventListener('atcontroller:focus-composer', focus);
  }, []);

  useEffect(() => {
    setHistoryCursor(null);
    setHistoryDraft('');
  }, [threadId]);

  const addFiles = async (files: File[]) => {
    setAttachmentError(null);
    try {
      const next: ComposerAttachment[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          next.push(await imageAttachment(file, workspacePath));
          continue;
        }
        const path = filePath(file);
        if (!path) {
          throw new Error(`ATController needs a local path for ${file.name}. Use the attachment picker instead.`);
        }
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          kind: 'file',
          path,
          outsideWorkspace: !pathInsideWorkspace(path, workspacePath)
        });
      }
      onAttachmentsChange([...attachments, ...next]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  };

  const submit = () => {
    const inputs = attachmentsToInputs(value, attachments, selectedSkills);
    if (inputs.length > 0 && canSubmit) {
      onSubmit(inputs);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plainEnter =
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey;
    const commandEnter =
      event.key === 'Enter' &&
      event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      commandEnterToSend;
    if (plainEnter || commandEnter) {
      event.preventDefault();
      submit();
      return;
    }
    const noModifiers =
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (
      event.key === 'ArrowUp' &&
      noModifiers &&
      event.currentTarget.selectionStart === 0 &&
      promptHistory.length
    ) {
      event.preventDefault();
      const next =
        historyCursor == null
          ? promptHistory.length - 1
          : Math.max(0, historyCursor - 1);
      if (historyCursor == null) setHistoryDraft(value);
      setHistoryCursor(next);
      onChange(promptHistory[next]);
      return;
    }
    if (
      event.key === 'ArrowDown' &&
      noModifiers &&
      historyCursor != null &&
      event.currentTarget.selectionEnd === value.length
    ) {
      event.preventDefault();
      const next = historyCursor + 1;
      if (next >= promptHistory.length) {
        setHistoryCursor(null);
        onChange(historyDraft);
      } else {
        setHistoryCursor(next);
        onChange(promptHistory[next]);
      }
      return;
    }
    if (event.key === 'Escape' && running) {
      event.preventDefault();
      onStop();
    }
  };

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    event.preventDefault();
    await addFiles(images);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    await addFiles(Array.from(event.dataTransfer.files));
  };

  if (archived) {
    return (
      <div className="composer-wrap archived-composer-wrap">
        <div className="archived-composer">
          <div>
            <strong>Thread archived</strong>
            <span>Restore this thread to continue the Codex session.</span>
          </div>
          <button type="button" className="primary-button" onClick={onRestore}>
            Restore thread
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {dragging ? <div className="composer-drop-overlay">Drop files or images to attach</div> : null}
      <div className="composer">
        {attachments.length > 0 || selectedSkills.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="attachment-chip">
                <AppIcon name={attachment.kind === 'image' ? 'file' : 'attachment'} />
                <span>{attachment.name}</span>
                {attachment.outsideWorkspace ? <em title="This file is outside the active project">Outside project</em> : null}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}
                >
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            ))}
            {selectedSkills.map((skill) => (
              <div key={skill.path} className="attachment-chip skill-chip">
                <AppIcon name="code" />
                <span>{skill.name}</span>
                <em>Skill</em>
                <button
                  type="button"
                  aria-label={`Remove ${skill.name}`}
                  onClick={() =>
                    onSelectedSkillsChange(
                      selectedSkills.filter((candidate) => candidate.path !== skill.path)
                    )
                  }
                >
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          key={threadId}
          value={value}
          disabled={!connected || recovering}
          placeholder={
            recovering
              ? 'Recovering this Codex thread…'
              : connected
                ? running
                  ? 'Steer the active turn…'
                  : 'Ask Codex to work on this project…'
                : 'Codex runtime is disconnected'
          }
          rows={1}
          aria-label="Message Codex"
          onChange={(event) => {
            setHistoryCursor(null);
            onChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        {attachmentError ? <p className="composer-error">{attachmentError}</p> : null}
        <footer className="composer-footer">
          <div className="composer-tools">
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={onPickAttachments}>
              <AppIcon name="attachment" />
            </button>
            {skills.length ? (
              <details className="composer-skills">
                <summary className="icon-button" aria-label="Use a Codex skill" title="Use a Codex skill">
                  <AppIcon name="code" />
                </summary>
                <div className="composer-skills-menu">
                  <strong>Skills</strong>
                  {skills.map((skill) => {
                    const selected = selectedSkills.some((candidate) => candidate.path === skill.path);
                    return (
                      <label key={skill.path}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            onSelectedSkillsChange(
                              selected
                                ? selectedSkills.filter((candidate) => candidate.path !== skill.path)
                                : [...selectedSkills, skill]
                            )
                          }
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.shortDescription || skill.description}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </details>
            ) : null}
            <label className="composer-select model-select">
              <span className="sr-only">Model</span>
              <select
                value={preferences.model ?? selectedModel?.id ?? ''}
                onChange={(event) => {
                  const model = models.find((candidate) => candidate.id === event.target.value);
                  onPreferencesChange({
                    ...preferences,
                    model: event.target.value || null,
                    reasoningEffort: model?.defaultReasoningEffort || null,
                    serviceTier: model?.defaultServiceTier ?? null
                  });
                }}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{model.displayName || model.model || model.id}</option>
                ))}
              </select>
            </label>
            <label className="composer-select">
              <span className="sr-only">Reasoning effort</span>
              <select
                value={preferences.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? ''}
                onChange={(event) =>
                  onPreferencesChange({ ...preferences, reasoningEffort: event.target.value || null })
                }
              >
                {efforts.map((effort) => (
                  <option key={effort.value} value={effort.value}>{effort.value === 'ultra' ? 'Ultra' : readableKind(effort.value)}</option>
                ))}
              </select>
            </label>
            {serviceTiers.length ? (
              <label className="composer-select">
                <span className="sr-only">Service tier</span>
                <select
                  value={
                    preferences.serviceTier ??
                    selectedModel?.defaultServiceTier ??
                    ''
                  }
                  onChange={(event) =>
                    onPreferencesChange({
                      ...preferences,
                      serviceTier: event.target.value || null
                    })
                  }
                >
                  {!selectedModel?.defaultServiceTier ? (
                    <option value="">Runtime tier</option>
                  ) : null}
                  {serviceTiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.name || readableKind(tier.id)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={`composer-select permission-select ${preferences.permissionMode}`}>
              <span className="sr-only">Permission mode</span>
              <select
                value={preferences.permissionMode}
                onChange={(event) =>
                  onPreferencesChange({
                    ...preferences,
                    permissionMode: event.target.value as PermissionMode
                  })
                }
              >
                <option value="standard">Standard</option>
                <option value="workspaceAccess">Workspace Access</option>
                <option value="fullAccess">Full Access</option>
              </select>
            </label>
            <span className="composer-usage" title="Codex usage">
              5h {formatAllowance(fiveHourLimit)} · Week {formatAllowance(weeklyLimit)}
            </span>
          </div>
          {running ? (
            <div className="composer-running-actions">
              <button type="button" className="stop-button" onClick={onStop}>
                <AppIcon name="stop" size={13} />
                Stop
              </button>
              <button type="button" className="send-button" aria-label="Steer active turn" disabled={!canSubmit} onClick={submit}>
                <AppIcon name="send" />
              </button>
            </div>
          ) : (
            <button type="button" className="send-button" aria-label="Send message" disabled={!canSubmit} onClick={submit}>
              {submitting ? <span className="button-spinner" /> : <AppIcon name="send" />}
            </button>
          )}
        </footer>
      </div>
      {preferences.permissionMode === 'fullAccess' ? (
        <p className="full-access-note">
          <span />
          Full Access — Codex may read, modify, delete, and execute resources available to your macOS user.
        </p>
      ) : null}
    </div>
  );
}

function readableKind(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}
