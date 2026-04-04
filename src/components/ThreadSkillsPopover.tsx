import * as React from 'react';
import { createPortal } from 'react-dom';

import { getSkillUsageStats, matchesSkillSearch, sortSkillsForDisplay, type SkillUsageMap } from '../lib/skillUsage';
import { isRemoteWorkspaceKind } from '../lib/workspaceKind';
import type { SkillInfo, ThreadMetadata, Workspace } from '../types';

interface SkillsPopoverPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

interface ThreadSkillsPopoverProps {
  workspace?: Workspace;
  thread?: ThreadMetadata;
  skills: SkillInfo[];
  loading: boolean;
  error?: string | null;
  usageMap: SkillUsageMap;
  saving?: boolean;
  onToggleSkill: (skillId: string) => void | Promise<void>;
  onRemoveMissingSkill: (skillId: string) => void | Promise<void>;
  onTogglePinned: (skillId: string) => void;
  onRefresh: () => void | Promise<void>;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm6 10 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="m8 5 8 5-2.6 1.1-.3 4.6-1.3 1.3-1.6-4.1L7.1 16l-.1-.1 2.9-3.1L5.8 9.9 8 5Z"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.2 10.2 3 3.1 6.6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function countEnabledSkills(thread?: ThreadMetadata): number {
  return thread?.enabledSkills.length ?? 0;
}

function isGlobalSkill(skill: SkillInfo): boolean {
  return skill.isGlobal ?? skill.relativePath.startsWith('~/');
}

export function ThreadSkillsPopover({
  workspace,
  thread,
  skills,
  loading,
  error,
  usageMap,
  saving = false,
  onToggleSkill,
  onRemoveMissingSkill,
  onTogglePinned,
  onRefresh
}: ThreadSkillsPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<SkillsPopoverPosition | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popoverRef = React.useRef<HTMLElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedSkillIds = thread?.enabledSkills ?? [];
  const skillCount = countEnabledSkills(thread);
  const skillById = React.useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const selectedSkills = React.useMemo(
    () => selectedSkillIds.map((skillId) => skillById.get(skillId)).filter((skill): skill is SkillInfo => Boolean(skill)),
    [selectedSkillIds, skillById]
  );
  const missingSkillIds = React.useMemo(
    () => selectedSkillIds.filter((skillId) => !skillById.has(skillId)),
    [selectedSkillIds, skillById]
  );
  const sortedSkills = React.useMemo(() => {
    if (!workspace) {
      return skills;
    }
    return sortSkillsForDisplay(skills, workspace.path, usageMap);
  }, [skills, usageMap, workspace]);
  const filteredSkills = React.useMemo(() => {
    if (!searchQuery.trim()) {
      return sortedSkills;
    }
    return sortedSkills.filter((skill) => matchesSkillSearch(skill, searchQuery));
  }, [searchQuery, sortedSkills]);
  const skillSections = React.useMemo(() => {
    const workspaceSkills: SkillInfo[] = [];
    const globalSkills: SkillInfo[] = [];

    for (const skill of filteredSkills) {
      if (isGlobalSkill(skill)) {
        globalSkills.push(skill);
      } else {
        workspaceSkills.push(skill);
      }
    }

    return { workspaceSkills, globalSkills };
  }, [filteredSkills]);
  const remoteWorkspace = workspace ? isRemoteWorkspaceKind(workspace.kind) : false;
  const triggerDisabled = !thread || !workspace;

  const renderSkillRows = React.useCallback(
    (sectionSkills: SkillInfo[]) =>
      sectionSkills.map((skill) => {
        const selected = selectedSkillIds.includes(skill.id);
        const usage = workspace ? getSkillUsageStats(usageMap, workspace.path, skill.id) : { lastUsedAt: 0, pinned: false };
        return (
          <div
            key={skill.id}
            className={selected ? 'skills-row selected' : 'skills-row'}
          >
            <button
              type="button"
              className="skills-row-main"
              onClick={() => void onToggleSkill(skill.id)}
              disabled={saving}
            >
              <span className={selected ? 'skills-row-check selected' : 'skills-row-check'} aria-hidden="true">
                {selected ? <CheckIcon /> : null}
              </span>
              <span className="skills-row-meta">
                <span className="skills-row-topline">
                  <span className="skills-row-name">{skill.name}</span>
                  <span className="skills-row-id">{skill.id}</span>
                </span>
                {skill.description ? <span className="skills-row-description">{skill.description}</span> : null}
                <span className="skills-row-path">{skill.relativePath}</span>
                {skill.entryPoints.length > 0 ? (
                  <span className="skills-row-entry-points">{skill.entryPoints.slice(0, 3).join(' · ')}</span>
                ) : null}
                {skill.warning ? <span className="skills-row-warning">{skill.warning}</span> : null}
              </span>
            </button>
            <div className="skills-row-actions">
              <button
                type="button"
                className={usage.pinned ? 'skills-pin-button pinned' : 'skills-pin-button'}
                aria-label={usage.pinned ? `Unpin ${skill.name}` : `Pin ${skill.name}`}
                title={usage.pinned ? 'Pinned to the top' : 'Pin to the top'}
                onClick={() => onTogglePinned(skill.id)}
              >
                <PinIcon pinned={usage.pinned} />
              </button>
            </div>
          </div>
        );
      }),
    [onTogglePinned, onToggleSkill, saving, selectedSkillIds, usageMap, workspace]
  );

  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      setPosition(null);
      return;
    }

    const viewportPadding = 10;
    const desiredWidth = 420;
    const rect = trigger.getBoundingClientRect();
    const availableWidth = Math.max(300, window.innerWidth - viewportPadding * 2);
    const width = Math.min(desiredWidth, availableWidth);
    const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding));
    const spaceAbove = Math.max(0, rect.top - viewportPadding - 8);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - 8);
    const openUpward = spaceAbove > spaceBelow && spaceAbove >= 220;
    const maxHeight = Math.max(220, Math.min(520, openUpward ? spaceAbove : spaceBelow));

    if (openUpward) {
      setPosition({
        left,
        width,
        maxHeight,
        bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 8)
      });
      return;
    }

    setPosition({
      left,
      width,
      maxHeight,
      top: Math.max(viewportPadding, rect.bottom + 8)
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const withinTrigger = triggerRef.current?.contains(target) ?? false;
      const withinPopover = popoverRef.current?.contains(target) ?? false;
      if (!withinTrigger && !withinPopover) {
        setOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open) {
      setSearchQuery('');
      return;
    }
    updatePosition();
  }, [error, loading, open, skills.length, sortedSkills, updatePosition]);

  React.useEffect(() => {
    if (!open || remoteWorkspace || !position) {
      return;
    }

    let cancelled = false;
    const timeoutIds: number[] = [];
    const focusSearchInput = () => {
      if (cancelled) {
        return;
      }
      const input = searchInputRef.current;
      if (!input) {
        return;
      }
      input.focus({ preventScroll: true });
      if (document.activeElement !== input) {
        timeoutIds.push(window.setTimeout(focusSearchInput, 32));
      }
    };
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
      timeoutIds.push(window.setTimeout(focusSearchInput, 96));
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [open, position, remoteWorkspace]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={open || skillCount > 0 ? 'ghost-button skills-button active' : 'ghost-button skills-button'}
        onClick={() => {
          if (triggerDisabled) {
            return;
          }
          setOpen((current) => {
            const next = !current;
            if (!current) {
              window.setTimeout(() => {
                updatePosition();
              }, 0);
            }
            return next;
          });
        }}
        disabled={triggerDisabled}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="skills-button-icon" aria-hidden="true">
          <SparkIcon />
        </span>
        <span>Skills</span>
        {skillCount > 0 ? <span className="skills-button-count">{skillCount}</span> : null}
      </button>

      {open && position
        ? createPortal(
            <section
              ref={popoverRef}
              className="skills-popover skills-popover-portal"
              role="dialog"
              aria-modal="false"
              aria-label="Project skills"
              style={{
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
                top: position.top,
                bottom: position.bottom
              }}
            >
              <div className="skills-popover-header">
                <div>
                  <h3>Skills</h3>
                  <p>Enable workspace and global skills per thread and inject them invisibly with the next prompt.</p>
                </div>
                <button type="button" className="ghost-button skills-refresh-button" onClick={() => void onRefresh()} disabled={loading}>
                  Refresh
                </button>
              </div>

              <div className="skills-popover-intro">
                {remoteWorkspace
                  ? 'Local repo skills are only available for local workspaces right now.'
                  : selectedSkills.length > 0 || missingSkillIds.length > 0
                    ? 'Selected skills are prepended off-screen before Claude receives your next submitted prompt.'
                    : 'Choose one or more skills below to use them in this thread.'}
              </div>

              {!remoteWorkspace ? (
                <div className="skills-search">
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="skills-search-input"
                    placeholder="Search skills"
                    aria-label="Search skills"
                    autoFocus
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    spellCheck={false}
                  />
                </div>
              ) : null}

              {selectedSkills.length > 0 || missingSkillIds.length > 0 ? (
                <div className="skills-chip-list" aria-label="Selected skills">
                  {selectedSkills.map((skill) => (
                    <span key={skill.id} className="skills-chip">
                      <span className="skills-chip-label">{skill.name}</span>
                      <button
                        type="button"
                        className="skills-chip-remove"
                        aria-label={`Remove ${skill.name}`}
                        onClick={() => void onToggleSkill(skill.id)}
                        disabled={saving}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {missingSkillIds.map((skillId) => (
                    <span key={skillId} className="skills-chip missing">
                      <span className="skills-chip-label">{skillId}</span>
                      <button
                        type="button"
                        className="skills-chip-remove"
                        aria-label={`Remove missing skill ${skillId}`}
                        onClick={() => void onRemoveMissingSkill(skillId)}
                        disabled={saving}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {remoteWorkspace ? (
                <div className="skills-empty">
                  Project skill discovery currently scans local repositories only. Remote sessions can keep using normal Claude prompts.
                </div>
              ) : error ? (
                <div className="skills-error" role="status">
                  <strong>Couldn&apos;t scan project skills.</strong>
                  <span>{error}</span>
                </div>
              ) : loading ? (
                <div className="skills-empty">Scanning workspace and global skills…</div>
              ) : sortedSkills.length === 0 ? (
                <div className="skills-empty">
                  No skills found. Add folders like `.claude/skills/review/SKILL.md` or `~/.claude/skills/review/SKILL.md` to make them available here.
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="skills-empty" role="status">
                  No skills match "{searchQuery.trim()}".
                </div>
              ) : (
                <div className="skills-list">
                  {skillSections.workspaceSkills.length > 0 ? (
                    <div className="skills-section">
                      {skillSections.globalSkills.length > 0 ? (
                        <div className="skills-section-header">Workspace</div>
                      ) : null}
                      {renderSkillRows(skillSections.workspaceSkills)}
                    </div>
                  ) : null}
                  {skillSections.globalSkills.length > 0 ? (
                    <div className="skills-section">
                      <div className="skills-section-header">Global</div>
                      {renderSkillRows(skillSections.globalSkills)}
                    </div>
                  ) : null}
                </div>
              )}
            </section>,
            document.body
          )
        : null}
    </>
  );
}
