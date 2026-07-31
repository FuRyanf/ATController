import {
  memo,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react';

import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type {
  CodexModel,
  CodexPlugin,
  CodexRateLimitWindowV2,
  CodexSkill,
  ComposerInput,
  PermissionMode,
  ThreadPreferences
} from '../types';
import { serviceTierDisplayName } from '../lib/codexLabels';
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
  plugins: CodexPlugin[];
  selectedPlugins: CodexPlugin[];
  skills: CodexSkill[];
  selectedSkills: CodexSkill[];
  preferences: ThreadPreferences;
  effectiveServiceTier?: string | null;
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
  onSelectedPluginsChange: (plugins: CodexPlugin[]) => void;
  onSelectedSkillsChange: (skills: CodexSkill[]) => void;
  onPreferencesChange: (preferences: ThreadPreferences) => void;
  onPickAttachments: () => void;
  onDropPaths: (paths: string[]) => void | Promise<void>;
  onSubmit: (inputs: ComposerInput[]) => void;
  onStop: () => void;
  onRestore: () => void;
}

interface ActiveSkillMention {
  start: number;
  end: number;
  query: string;
}

interface ComposerMentionOption {
  key: string;
  kind: 'plugin' | 'skill';
  displayName: string;
  description: string;
  sourceLabel: 'Plugin' | 'Project skill';
  plugin?: CodexPlugin;
  skill?: CodexSkill;
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_SKILL_MENTION_RESULTS = 80;

export function findActiveSkillMention(
  value: string,
  cursor: number
): ActiveSkillMention | null {
  if (cursor < 0 || cursor > value.length) return null;
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return {
    start: cursor - match[1].length - 1,
    end: cursor,
    query: match[1]
  };
}

function humanizeMentionName(name: string): string {
  const nameParts = name.split(':');
  const baseName = nameParts[nameParts.length - 1] || name;
  return baseName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) =>
      /^[A-Z0-9]{2,}$/.test(part)
        ? part
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    )
    .join(' ');
}

export function skillDisplayName(skill: CodexSkill): string {
  return humanizeMentionName(skill.name);
}

export function skillSourceLabel(skill: CodexSkill): string {
  if (skill.path.includes('/.codex/plugins/') || skill.path.includes('/plugins/cache/')) {
    return 'Plugin skill';
  }
  if (
    skill.scope === 'repo' ||
    skill.path.includes('/.github/skills/') ||
    skill.path.includes('/.agents/skills/')
  ) {
    return 'Project skill';
  }
  return `${readableKind(skill.scope || 'runtime')} skill`;
}

export function isComposerSkill(skill: CodexSkill): boolean {
  const normalizedPath = skill.path.toLocaleLowerCase();
  return (
    skill.scope === 'repo' ||
    normalizedPath.includes('/.github/skills/') ||
    normalizedPath.includes('/.agents/skills/')
  );
}

function composerMentionMatches(
  plugins: CodexPlugin[],
  skills: CodexSkill[],
  selectedPlugins: CodexPlugin[],
  selectedSkills: CodexSkill[],
  query: string
): ComposerMentionOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedPluginIds = new Set(selectedPlugins.map((plugin) => plugin.id));
  const selectedSkillPaths = new Set(selectedSkills.map((skill) => skill.path));
  const options: ComposerMentionOption[] = [
    ...plugins
      .filter((plugin) => plugin.enabled && !selectedPluginIds.has(plugin.id))
      .map((plugin) => ({
        key: `plugin:${plugin.id}`,
        kind: 'plugin' as const,
        displayName: plugin.displayName || humanizeMentionName(plugin.name),
        description: plugin.description,
        sourceLabel: 'Plugin' as const,
        plugin
      })),
    ...skills
      .filter(isComposerSkill)
      .filter((skill) => !selectedSkillPaths.has(skill.path))
      .map((skill) => ({
        key: `skill:${skill.path}`,
        kind: 'skill' as const,
        displayName: skillDisplayName(skill),
        description: skill.shortDescription || skill.description,
        sourceLabel: 'Project skill' as const,
        skill
      }))
  ];
  const matchRank = (option: ComposerMentionOption) => {
    if (!normalizedQuery) return 0;
    const name = (
      option.plugin?.name ??
      option.skill?.name ??
      option.displayName
    ).toLocaleLowerCase();
    const displayName = option.displayName.toLocaleLowerCase();
    if (name === normalizedQuery || displayName === normalizedQuery) return 0;
    if (name.startsWith(normalizedQuery) || displayName.startsWith(normalizedQuery)) {
      return 1;
    }
    if (
      name.split(/[-_:\s]+/).some((part) => part.startsWith(normalizedQuery)) ||
      displayName.split(/\s+/).some((part) => part.startsWith(normalizedQuery))
    ) {
      return 2;
    }
    return 3;
  };
  return options
    .filter((option) => {
      if (!normalizedQuery) return true;
      return [
        option.displayName,
        option.description,
        option.plugin?.name ?? '',
        option.plugin?.id ?? '',
        option.skill?.name ?? '',
        option.skill?.path ?? ''
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort(
      (left, right) =>
        matchRank(left) - matchRank(right) ||
        (left.kind === right.kind ? 0 : left.kind === 'plugin' ? -1 : 1) ||
        left.displayName.localeCompare(right.displayName)
    )
    .slice(0, MAX_SKILL_MENTION_RESULTS);
}

export function physicalPointInsideRect(
  position: { x: number; y: number },
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  scaleFactor: number,
  viewportHeight = window.innerHeight
): boolean {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const points = [
    { x: position.x / scale, y: position.y / scale },
    // Some WebKit/Tauri combinations already report logical coordinates even
    // though the API type is PhysicalPosition.
    { x: position.x, y: position.y }
  ];
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    points.push(
      { x: position.x / scale, y: viewportHeight - position.y / scale },
      { x: position.x, y: viewportHeight - position.y }
    );
  }
  return points.some(
    ({ x, y }) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  );
}

function pathInsideWorkspace(path: string, workspacePath: string): boolean {
  const root = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path === workspacePath || path.startsWith(root);
}

function filePath(file: File): string | null {
  const candidate = (file as File & { path?: string }).path;
  return typeof candidate === 'string' && candidate.startsWith('/') ? candidate : null;
}

export function pathsFromDataTransfer(dataTransfer: DataTransfer): string[] {
  const paths = Array.from(dataTransfer.files)
    .map(filePath)
    .filter((path): path is string => Boolean(path));
  const uriList = dataTransfer.getData('text/uri-list');
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'file:') paths.push(decodeURIComponent(url.pathname));
    } catch {
      // Native Tauri events remain the authoritative path source.
    }
  }
  return [...new Set(paths.filter((path) => path.startsWith('/')))];
}

export function pathsWithoutInlineImages(paths: string[], imageNames: string[]): string[] {
  const remainingNames = new Map<string, number>();
  for (const name of imageNames) {
    remainingNames.set(name, (remainingNames.get(name) ?? 0) + 1);
  }
  return paths.filter((path) => {
    const name = path.split('/').pop() ?? path;
    const remaining = remainingNames.get(name) ?? 0;
    if (remaining === 0) return true;
    if (remaining === 1) remainingNames.delete(name);
    else remainingNames.set(name, remaining - 1);
    return false;
  });
}

async function imageAttachment(file: File, workspacePath: string): Promise<ComposerAttachment> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Images must be PNG, JPEG, GIF, or WebP.');
  }
  if (file.size > MAX_INLINE_IMAGE_BYTES) {
    throw new Error('Images are limited to 10 MB.');
  }
  const path = filePath(file);
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
    outsideWorkspace: path ? !pathInsideWorkspace(path, workspacePath) : false
  };
}

function formatAllowance(window?: CodexRateLimitWindowV2 | null): string {
  if (!window) return '—';
  return `${Math.max(0, Math.round(100 - window.usedPercent))}% left`;
}

export function attachmentsToInputs(
  text: string,
  attachments: ComposerAttachment[],
  skills: CodexSkill[] = [],
  plugins: CodexPlugin[] = []
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
  for (const plugin of plugins) {
    inputs.push({
      type: 'plugin',
      id: plugin.id,
      name: plugin.displayName || plugin.name
    });
  }
  return inputs;
}

function MessageComposerComponent({
  threadId,
  workspacePath,
  value,
  promptHistory,
  attachments,
  plugins,
  selectedPlugins,
  skills,
  selectedSkills,
  preferences,
  effectiveServiceTier,
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
  onSelectedPluginsChange,
  onSelectedSkillsChange,
  onPreferencesChange,
  onPickAttachments,
  onDropPaths,
  onSubmit,
  onStop,
  onRestore
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const nativeFileDragRef = useRef(false);
  const pendingInlineImageDropRef = useRef<{
    names: string[];
    expiresAt: number;
  } | null>(null);
  const nativeDropTimerRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const [skillMention, setSkillMention] = useState<ActiveSkillMention | null>(null);
  const [skillMentionIndex, setSkillMentionIndex] = useState(0);
  const selectedModel =
    models.find((model) => model.id === preferences.model || model.model === preferences.model) ??
    models.find((model) => model.isDefault) ??
    models[0];
  const efforts = selectedModel?.reasoningEfforts ?? [];
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const composerSkills = skills.filter(isComposerSkill);
  const composerPlugins = plugins.filter((plugin) => plugin.enabled);
  const effectiveTier = serviceTiers.find(
    (tier) => tier.id === effectiveServiceTier
  );
  const selectedTierId =
    preferences.serviceTier ?? selectedModel?.defaultServiceTier ?? '';
  const selectedTier = serviceTiers.find((tier) => tier.id === selectedTierId);
  const speedDescription =
    selectedTier?.description ||
    effectiveTier?.description ||
    'Controls the Codex runtime processing speed for future turns.';
  const canSubmit =
    connected &&
    !archived &&
    !recovering &&
    !submitting &&
    Boolean(
      value.trim() ||
        attachments.length ||
        selectedSkills.length ||
        selectedPlugins.length
    );
  const outsideAttachmentCount = attachments.filter(
    (attachment) => attachment.outsideWorkspace
  ).length;
  const skillMentionResults = skillMention
    ? composerMentionMatches(
        composerPlugins,
        composerSkills,
        selectedPlugins,
        selectedSkills,
        skillMention.query
      )
    : [];
  const activeSkillMentionIndex = Math.min(
    skillMentionIndex,
    Math.max(0, skillMentionResults.length - 1)
  );
  const setDropActive = (active: boolean) => {
    draggingRef.current = active;
    setDragging(active);
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(240, Math.max(44, textarea.scrollHeight))}px`;
    if (pendingSelectionRef.current != null) {
      const cursor = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    }
  }, [value]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener('atcontroller:focus-composer', focus);
    return () => window.removeEventListener('atcontroller:focus-composer', focus);
  }, []);

  useEffect(() => {
    setHistoryCursor(null);
    setHistoryDraft('');
    setSkillMention(null);
    setSkillMentionIndex(0);
  }, [threadId]);

  useEffect(() => {
    setSkillMentionIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    if (!isTauri() || archived) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === 'leave') {
          nativeFileDragRef.current = false;
          setDropActive(false);
          return;
        }
        if (payload.type === 'enter') {
          nativeFileDragRef.current = payload.paths.length > 0;
        }
        const target = dropTargetRef.current;
        const inside = Boolean(
          target &&
            physicalPointInsideRect(
              payload.position,
              target.getBoundingClientRect(),
              window.devicePixelRatio,
              window.innerHeight
            )
        );
        if (payload.type !== 'drop') {
          setDropActive(inside);
          return;
        }
        // Finder's native drop event is authoritative. On some macOS/WebKit
        // combinations its final point uses a different coordinate origin
        // from the preceding event, despite the system showing the green plus.
        const acceptDrop =
          inside || draggingRef.current || nativeFileDragRef.current;
        nativeFileDragRef.current = false;
        setDropActive(false);
        if (!acceptDrop || payload.paths.length === 0) return;
        const droppedPaths = [...payload.paths];
        if (nativeDropTimerRef.current != null) {
          window.clearTimeout(nativeDropTimerRef.current);
        }
        // WebKit can read an explicitly dropped image without asking the
        // native process to traverse a protected macOS folder. Give the DOM
        // drop event one frame to claim those images, then pass any remaining
        // paths through the native path flow.
        nativeDropTimerRef.current = window.setTimeout(() => {
          nativeDropTimerRef.current = null;
          const pending = pendingInlineImageDropRef.current;
          pendingInlineImageDropRef.current = null;
          const paths =
            pending && pending.expiresAt >= Date.now()
              ? pathsWithoutInlineImages(droppedPaths, pending.names)
              : droppedPaths;
          if (paths.length === 0) return;
          void (async () => {
            try {
              setAttachmentError(null);
              await onDropPaths(paths);
            } catch (error) {
              if (!disposed) {
                setAttachmentError(error instanceof Error ? error.message : String(error));
              }
            }
          })();
        }, 80);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      nativeFileDragRef.current = false;
      if (nativeDropTimerRef.current != null) {
        window.clearTimeout(nativeDropTimerRef.current);
        nativeDropTimerRef.current = null;
      }
      stop?.();
    };
  }, [archived, onDropPaths]);

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
    const inputs = attachmentsToInputs(
      value,
      attachments,
      selectedSkills,
      selectedPlugins
    );
    if (inputs.length > 0 && canSubmit) {
      setSkillMention(null);
      onSubmit(inputs);
    }
  };

  const selectMention = (option: ComposerMentionOption) => {
    if (!skillMention) return;
    const nextValue =
      value.slice(0, skillMention.start) + value.slice(skillMention.end);
    const nextCursor = skillMention.start;
    pendingSelectionRef.current = nextCursor;
    onChange(nextValue);
    if (option.plugin) {
      onSelectedPluginsChange([...selectedPlugins, option.plugin]);
    } else if (option.skill) {
      onSelectedSkillsChange([...selectedSkills, option.skill]);
    }
    setSkillMention(null);
    setSkillMentionIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMention) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillMention(null);
        return;
      }
      if (skillMentionResults.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSkillMentionIndex((current) => (current + 1) % skillMentionResults.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSkillMentionIndex(
            (current) => (current - 1 + skillMentionResults.length) % skillMentionResults.length
          );
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectMention(skillMentionResults[activeSkillMentionIndex]);
          return;
        }
      }
    }
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
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    const inlineImages = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
    if (isTauri() && inlineImages.length > 0) {
      const names = inlineImages.map((file) => file.name);
      pendingInlineImageDropRef.current = {
        names,
        expiresAt: Date.now() + 1_500
      };
      await addFiles(inlineImages);
    }
    const paths = pathsWithoutInlineImages(
      pathsFromDataTransfer(event.dataTransfer),
      isTauri() ? inlineImages.map((file) => file.name) : []
    );
    if (paths.length) {
      await onDropPaths(paths);
      return;
    }
    // Tauri supplies real macOS paths through onDragDropEvent. WebKit File
    // objects intentionally omit them, so wait for the native event instead
    // of displaying a misleading local-path error.
    if (isTauri()) return;
    await addFiles(files);
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
      ref={dropTargetRef}
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      }}
      onDrop={handleDrop}
    >
      {dragging ? <div className="composer-drop-overlay">Drop files or images to attach</div> : null}
      <div className="composer">
        {attachments.length > 0 ||
        selectedPlugins.length > 0 ||
        selectedSkills.length > 0 ? (
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
                <span title={skill.name}>{skillDisplayName(skill)}</span>
                <em>{skillSourceLabel(skill)}</em>
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
            {selectedPlugins.map((plugin) => (
              <div key={plugin.id} className="attachment-chip plugin-chip">
                <AppIcon name="code" />
                <span title={plugin.id}>@{plugin.displayName || plugin.name}</span>
                <em>Plugin</em>
                <button
                  type="button"
                  aria-label={`Remove ${plugin.displayName || plugin.name}`}
                  onClick={() =>
                    onSelectedPluginsChange(
                      selectedPlugins.filter(
                        (candidate) => candidate.id !== plugin.id
                      )
                    )
                  }
                >
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {outsideAttachmentCount > 0 ? (
          <p className="composer-external-attachment-note" role="note">
            <AppIcon name="info" size={12} />
            {outsideAttachmentCount === 1
              ? 'This outside-project attachment'
              : `These ${outsideAttachmentCount} outside-project attachments`}{' '}
            will be shared with Codex when you send this turn.
          </p>
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
            setSkillMention(
              findActiveSkillMention(event.target.value, event.target.selectionStart)
            );
          }}
          onClick={(event) => {
            setSkillMention(
              findActiveSkillMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart
              )
            );
          }}
          onSelect={(event) => {
            setSkillMention(
              findActiveSkillMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart
              )
            );
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-autocomplete="list"
          aria-controls={skillMention ? 'composer-skill-mentions' : undefined}
          aria-expanded={Boolean(skillMention)}
          aria-activedescendant={
            skillMentionResults.length
              ? `composer-skill-option-${activeSkillMentionIndex}`
              : undefined
          }
        />
        {skillMention ? (
          <div
            id="composer-skill-mentions"
            className="composer-skill-mentions"
            role="listbox"
            aria-label="Codex plugins and skills"
          >
            <header>
              <strong>Plugins and skills</strong>
              <span>Installed plugins and this project</span>
            </header>
            {skillMentionResults.length ? (
              skillMentionResults.map((option, index) => (
                <button
                  id={`composer-skill-option-${index}`}
                  key={option.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeSkillMentionIndex}
                  className={index === activeSkillMentionIndex ? 'selected' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMention(option)}
                >
                  <AppIcon name="code" size={14} />
                  <span>
                    <strong>{option.displayName}</strong>
                    <small>
                      <em>{option.sourceLabel}</em>
                      {option.description}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p>No matching plugins or project skills.</p>
            )}
          </div>
        ) : null}
        {attachmentError ? <p className="composer-error">{attachmentError}</p> : null}
        <footer className="composer-footer">
          <div className="composer-tools">
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={onPickAttachments}>
              <AppIcon name="attachment" />
            </button>
            {composerPlugins.length || composerSkills.length ? (
              <details className="composer-skills">
                <summary
                  className="icon-button"
                  aria-label="Use a Codex plugin or project skill"
                  title="Use a Codex plugin or project skill"
                >
                  <AppIcon name="code" />
                </summary>
                <div className="composer-skills-menu">
                  {composerPlugins.length ? <strong>Plugins</strong> : null}
                  {composerPlugins.map((plugin) => {
                    const selected = selectedPlugins.some(
                      (candidate) => candidate.id === plugin.id
                    );
                    return (
                      <label key={plugin.id}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            onSelectedPluginsChange(
                              selected
                                ? selectedPlugins.filter(
                                    (candidate) => candidate.id !== plugin.id
                                  )
                                : [...selectedPlugins, plugin]
                            )
                          }
                        />
                        <span>
                          <strong>
                            {plugin.displayName || humanizeMentionName(plugin.name)}
                          </strong>
                          <small>Plugin · {plugin.description}</small>
                        </span>
                      </label>
                    );
                  })}
                  {composerSkills.length ? <strong>Project skills</strong> : null}
                  {composerSkills.map((skill) => {
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
                          <strong>{skillDisplayName(skill)}</strong>
                          <small>
                            {skillSourceLabel(skill)} · {skill.shortDescription || skill.description}
                          </small>
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
              <label className="composer-select" title={speedDescription}>
                <span className="sr-only">Speed</span>
                <select
                  aria-label="Speed"
                  value={selectedTierId}
                  onChange={(event) =>
                    onPreferencesChange({
                      ...preferences,
                      serviceTier: event.target.value || null
                    })
                  }
                >
                  {!selectedModel?.defaultServiceTier ? (
                    <option value="">
                      {effectiveTier
                        ? `Speed: ${serviceTierDisplayName(effectiveTier)}`
                        : 'Speed: Default'}
                    </option>
                  ) : null}
                  {serviceTiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {`Speed: ${serviceTierDisplayName(tier)}`}
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

function equalStringArrays(left: string[], right: string[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function messageComposerPropsEqual(
  previous: MessageComposerProps,
  next: MessageComposerProps
): boolean {
  return (
    previous.threadId === next.threadId &&
    previous.workspacePath === next.workspacePath &&
    previous.value === next.value &&
    equalStringArrays(previous.promptHistory, next.promptHistory) &&
    previous.attachments === next.attachments &&
    previous.plugins === next.plugins &&
    previous.selectedPlugins === next.selectedPlugins &&
    previous.skills === next.skills &&
    previous.selectedSkills === next.selectedSkills &&
    previous.preferences.permissionMode === next.preferences.permissionMode &&
    previous.preferences.model === next.preferences.model &&
    previous.preferences.reasoningEffort ===
      next.preferences.reasoningEffort &&
    previous.preferences.serviceTier === next.preferences.serviceTier &&
    previous.effectiveServiceTier === next.effectiveServiceTier &&
    previous.models === next.models &&
    previous.fiveHourLimit === next.fiveHourLimit &&
    previous.weeklyLimit === next.weeklyLimit &&
    previous.archived === next.archived &&
    previous.running === next.running &&
    previous.connected === next.connected &&
    previous.recovering === next.recovering &&
    previous.submitting === next.submitting &&
    previous.commandEnterToSend === next.commandEnterToSend
  );
}

export const MessageComposer = memo(
  MessageComposerComponent,
  messageComposerPropsEqual
);

function readableKind(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}
