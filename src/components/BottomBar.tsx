import * as React from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';

import type { GitBranchEntry, GitInfo, GitWorkspaceStatus, ThreadMetadata, Workspace } from '../types';

interface BranchSwitcherSnapshot {
  branches: GitBranchEntry[];
  status: GitWorkspaceStatus | null;
}

interface BottomBarProps {
  workspace?: Workspace;
  selectedThread?: ThreadMetadata;
  skillsControl?: React.ReactNode;
  attachmentDraftPaths: string[];
  attachmentsEnabled: boolean;
  fullAccessUpdating?: boolean;
  fullAccessToggleBlockedReason?: string | null;
  gitInfo: GitInfo | null;
  onPickAttachments: () => Promise<void>;
  onAddAttachmentPaths: (paths: string[]) => boolean;
  onRemoveAttachmentPath: (path: string) => void;
  onClearAttachmentPaths: () => void;
  onToggleFullAccess: () => Promise<void>;
  onLoadBranchSwitcher: () => Promise<BranchSwitcherSnapshot>;
  onCheckoutBranch: (branchName: string) => Promise<boolean>;
}

interface BranchPopoverPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif']);

function decodeFileUriToPath(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('file://')) {
    return trimmed;
  }

  let decoded = trimmed.replace(/^file:\/\//, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw value when URI decoding fails
  }
  if (/^\/[a-zA-Z]:\//.test(decoded)) {
    return decoded.slice(1);
  }
  return decoded;
}

function normalizeDroppedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function extractAttachmentPathsFromDrop(dataTransfer: DataTransfer): string[] {
  const paths: string[] = [];

  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    for (const line of uriList.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      paths.push(decodeFileUriToPath(trimmed));
    }
  }

  const plain = dataTransfer.getData('text/plain');
  if (plain) {
    const trimmed = plain.trim();
    if (trimmed.startsWith('/') || trimmed.startsWith('~/') || trimmed.startsWith('file://')) {
      paths.push(decodeFileUriToPath(trimmed));
    }
  }

  for (const file of Array.from(dataTransfer.files)) {
    const withPath = file as File & { path?: string };
    if (withPath.path) {
      paths.push(withPath.path);
    }
  }

  return normalizeDroppedPaths(paths);
}

function attachmentDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const lastSegment = normalized.split(/[\\/]/).pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : path;
}

function attachmentSecondaryLabel(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  if (segments.length <= 1) {
    return null;
  }
  return segments.slice(-2, -1)[0] ?? null;
}

function isImageAttachmentPath(path: string): boolean {
  const name = attachmentDisplayName(path);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0) {
    return false;
  }
  return IMAGE_ATTACHMENT_EXTENSIONS.has(name.slice(dotIndex + 1).toLowerCase());
}

function safeConvertAttachmentPreviewSrc(path: string): string | null {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M8.7 12.6 14.8 6.5a3.25 3.25 0 1 1 4.6 4.6l-8 8a5.25 5.25 0 1 1-7.43-7.43l8.36-8.35"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7.25 3.75h6.3l4.2 4.2v10.3A1.75 1.75 0 0 1 16 20H7.25A1.75 1.75 0 0 1 5.5 18.25V5.5A1.75 1.75 0 0 1 7.25 3.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M13.5 3.9v4.1h4.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <path d="m7 16 3.5-3.5 2.5 2.5 2-2 2.5 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

const AttachmentChip = React.memo(function AttachmentChip({
  path,
  index,
  disabled,
  onRemove
}: {
  path: string;
  index: number;
  disabled: boolean;
  onRemove: (path: string) => void;
}) {
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const imageAttachment = isImageAttachmentPath(path);
  const previewSrc = imageAttachment && !previewFailed ? safeConvertAttachmentPreviewSrc(path) : null;
  const displayName = attachmentDisplayName(path);
  const secondaryLabel = imageAttachment ? displayName : attachmentSecondaryLabel(path);
  const primaryLabel = imageAttachment ? `Image #${index + 1}` : displayName;

  return (
    <span key={path} className={imageAttachment ? 'attachment-chip image' : 'attachment-chip'} title={path}>
      <span className={imageAttachment ? 'attachment-chip-preview image' : 'attachment-chip-preview'} aria-hidden="true">
        {previewSrc ? (
          <img src={previewSrc} alt="" onError={() => setPreviewFailed(true)} />
        ) : imageAttachment ? (
          <ImageIcon />
        ) : (
          <FileIcon />
        )}
      </span>
      <span className="attachment-chip-copy">
        <span className="attachment-chip-text">{primaryLabel}</span>
        {secondaryLabel ? <span className="attachment-chip-subtext">{secondaryLabel}</span> : null}
      </span>
      <button
        type="button"
        className="attachment-chip-remove"
        aria-label={`Remove attachment ${displayName}`}
        onClick={() => onRemove(path)}
        disabled={disabled}
      >
        ×
      </button>
    </span>
  );
});

function BranchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="19" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8.2 5h2.5c2.5 0 3.8 1.3 3.8 3.8v.4M8.2 19h2.5c2.5 0 3.8-1.3 3.8-3.8v-.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BottomBar({
  workspace,
  selectedThread,
  skillsControl,
  attachmentDraftPaths,
  attachmentsEnabled,
  fullAccessUpdating = false,
  fullAccessToggleBlockedReason = null,
  gitInfo,
  onPickAttachments,
  onAddAttachmentPaths,
  onRemoveAttachmentPath,
  onClearAttachmentPaths,
  onToggleFullAccess,
  onLoadBranchSwitcher,
  onCheckoutBranch
}: BottomBarProps) {
  const [branchPopoverOpen, setBranchPopoverOpen] = React.useState(false);
  const [branchSearch, setBranchSearch] = React.useState('');
  const [branches, setBranches] = React.useState<GitBranchEntry[]>([]);
  const [branchStatus, setBranchStatus] = React.useState<GitWorkspaceStatus | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = React.useState(false);
  const [isSwitchingBranch, setIsSwitchingBranch] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [attachmentDragActive, setAttachmentDragActive] = React.useState(false);
  const [branchPopoverPosition, setBranchPopoverPosition] = React.useState<BranchPopoverPosition | null>(null);

  const switcherRef = React.useRef<HTMLDivElement | null>(null);
  const branchTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const branchPopoverRef = React.useRef<HTMLElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const fullAccessToggleBlocked = Boolean(fullAccessToggleBlockedReason);

  const filteredBranches = React.useMemo(() => {
    const query = branchSearch.trim().toLowerCase();
    if (!query) {
      return branches;
    }
    return branches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [branchSearch, branches]);

  const updateBranchPopoverPosition = React.useCallback(() => {
    const trigger = branchTriggerRef.current;
    if (!trigger) {
      setBranchPopoverPosition(null);
      return;
    }

    const viewportPadding = 8;
    const desiredWidth = 360;
    const rect = trigger.getBoundingClientRect();

    const availableWidth = Math.max(260, window.innerWidth - viewportPadding * 2);
    const width = Math.min(desiredWidth, availableWidth);
    const left = Math.max(viewportPadding, Math.min(rect.right - width, window.innerWidth - width - viewportPadding));

    const spaceAbove = Math.max(0, rect.top - viewportPadding - 8);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - 8);
    const openUpward = spaceAbove >= spaceBelow;
    const maxHeight = Math.max(180, Math.min(420, openUpward ? spaceAbove : spaceBelow));

    if (openUpward) {
      setBranchPopoverPosition({
        left,
        width,
        maxHeight,
        bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 8)
      });
      return;
    }

    setBranchPopoverPosition({
      left,
      width,
      maxHeight,
      top: Math.max(viewportPadding, rect.bottom + 8)
    });
  }, []);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const withinSwitcher = switcherRef.current?.contains(target) ?? false;
      const withinPopover = branchPopoverRef.current?.contains(target) ?? false;
      if (!withinSwitcher && !withinPopover) {
        setBranchPopoverOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBranchPopoverOpen(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onEscape);
    window.addEventListener('resize', updateBranchPopoverPosition);
    window.addEventListener('scroll', updateBranchPopoverPosition, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('resize', updateBranchPopoverPosition);
      window.removeEventListener('scroll', updateBranchPopoverPosition, true);
    };
  }, [branchPopoverOpen, updateBranchPopoverPosition]);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }
    if (filteredBranches.length === 0) {
      setHighlightedIndex(0);
      return;
    }
    if (highlightedIndex >= filteredBranches.length) {
      setHighlightedIndex(filteredBranches.length - 1);
    }
  }, [branchPopoverOpen, filteredBranches, highlightedIndex]);

  React.useEffect(() => {
    if (!branchPopoverOpen) {
      return;
    }
    updateBranchPopoverPosition();
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, [branchPopoverOpen, updateBranchPopoverPosition]);

  React.useEffect(() => {
    setAttachmentDragActive(false);
  }, [selectedThread?.id]);

  React.useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    if (!attachmentsEnabled) {
      setAttachmentDragActive(false);
      return () => undefined;
    }

    if (typeof window === 'undefined') {
      return () => undefined;
    }

    const tauriWindow = window as unknown as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
    if (!tauriWindow.__TAURI__ && !tauriWindow.__TAURI_INTERNALS__) {
      return () => undefined;
    }

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onDragDropEvent((event) => {
          if (!active) {
            return;
          }
          const payload = event.payload;
          if (payload.type === 'over') {
            setAttachmentDragActive(true);
            return;
          }
          if (payload.type === 'drop') {
            setAttachmentDragActive(false);
            if (payload.paths.length > 0) {
              onAddAttachmentPaths(payload.paths);
            }
            return;
          }
          setAttachmentDragActive(false);
        })
      )
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      setAttachmentDragActive(false);
      unlisten?.();
    };
  }, [attachmentsEnabled, onAddAttachmentPaths]);

  const openBranchPopover = React.useCallback(async () => {
    if (!workspace || !gitInfo) {
      return;
    }
    setBranchPopoverOpen(true);
    updateBranchPopoverPosition();
    setBranchSearch('');
    setIsLoadingBranches(true);
    try {
      const snapshot = await onLoadBranchSwitcher();
      setBranches(snapshot.branches);
      setBranchStatus(snapshot.status);
      const currentIndex = snapshot.branches.findIndex((branch) => branch.isCurrent);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);
    } finally {
      setIsLoadingBranches(false);
    }
  }, [gitInfo, onLoadBranchSwitcher, updateBranchPopoverPosition, workspace]);

  const runCheckout = React.useCallback(
    async (branchName: string) => {
      setIsSwitchingBranch(true);
      try {
        const changed = await onCheckoutBranch(branchName);
        if (!changed) {
          return;
        }
        setBranchPopoverOpen(false);
      } catch {
        // Toast is emitted by the caller; keep popover open for retries.
      } finally {
        setIsSwitchingBranch(false);
      }
    },
    [onCheckoutBranch]
  );

  const onBranchSearchKeyDown = React.useCallback(
    async (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredBranches.length > 0) {
          setHighlightedIndex((current) => Math.min(filteredBranches.length - 1, current + 1));
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredBranches.length > 0) {
          setHighlightedIndex((current) => Math.max(0, current - 1));
        }
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const target = filteredBranches[highlightedIndex];
        if (target) {
          await runCheckout(target.name);
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setBranchPopoverOpen(false);
      }
    },
    [filteredBranches, highlightedIndex, runCheckout]
  );

  const onAttachmentDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!attachmentsEnabled) {
        return;
      }
      event.preventDefault();
      setAttachmentDragActive(true);
    },
    [attachmentsEnabled]
  );

  const onAttachmentDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!attachmentsEnabled) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!attachmentDragActive) {
        setAttachmentDragActive(true);
      }
    },
    [attachmentDragActive, attachmentsEnabled]
  );

  const onAttachmentDragLeave = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setAttachmentDragActive(false);
  }, []);

  const onAttachmentDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setAttachmentDragActive(false);
      if (!attachmentsEnabled) {
        return;
      }
      const paths = extractAttachmentPathsFromDrop(event.dataTransfer);
      if (paths.length === 0) {
        return;
      }
      onAddAttachmentPaths(paths);
    },
    [attachmentsEnabled, onAddAttachmentPaths]
  );

  return (
    <footer className="bottom-bar" data-testid="bottom-bar">
      <div className="bottom-bar-left">
        <span className="bottom-bar-label">{workspace && workspace.kind !== 'local' ? 'Remote' : 'Local'}</span>
        <div className="branch-switcher" ref={switcherRef}>
          <button
            ref={branchTriggerRef}
            type="button"
            className="ghost-button branch-trigger"
            onClick={() => void (branchPopoverOpen ? setBranchPopoverOpen(false) : openBranchPopover())}
            disabled={!workspace || !gitInfo}
            aria-expanded={branchPopoverOpen}
            aria-haspopup="dialog"
            title={gitInfo ? `Current branch: ${gitInfo.branch}` : 'Workspace is not a git repository'}
          >
            <span className="branch-trigger-label">{gitInfo?.branch ?? 'No git repo'}</span>
            <span className="branch-trigger-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M7 10.5 12 15l5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </span>
          </button>
        </div>
        {gitInfo?.worktreeLabel && gitInfo.isMainWorktree === false ? (
          <span
            className="worktree-indicator-pill"
            title={
              gitInfo.worktreePath
                ? `Currently in worktree "${gitInfo.worktreeLabel}"\n${gitInfo.worktreePath}`
                : `Currently in worktree "${gitInfo.worktreeLabel}"`
            }
            aria-label={
              gitInfo.worktreePath
                ? `Currently in worktree ${gitInfo.worktreeLabel} at ${gitInfo.worktreePath}`
                : `Currently in worktree ${gitInfo.worktreeLabel}`
            }
          >
            <span className="worktree-indicator-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path
                  d="M2.5 4.25h4.1l1.15 1.35h5.75v5.15a1.25 1.25 0 0 1-1.25 1.25H3.75A1.25 1.25 0 0 1 2.5 10.75z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <path d="M5.25 8h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M8 5.4v5.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="worktree-indicator-prefix">Worktree</span>
            <span className="worktree-indicator-label">{gitInfo.worktreeLabel}</span>
          </span>
        ) : null}
      </div>

      {branchPopoverOpen && branchPopoverPosition && typeof document !== 'undefined'
        ? createPortal(
            <section
              ref={branchPopoverRef}
              className="branch-popover branch-popover-portal"
              role="dialog"
              aria-label="Branch switcher"
              style={{
                left: branchPopoverPosition.left,
                width: branchPopoverPosition.width,
                maxHeight: branchPopoverPosition.maxHeight,
                ...(typeof branchPopoverPosition.top === 'number'
                  ? { top: branchPopoverPosition.top }
                  : { bottom: branchPopoverPosition.bottom ?? 8 })
              }}
            >
              <div className="branch-search-row">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="branch-search-input"
                  placeholder="Search branches"
                  value={branchSearch}
                  onChange={(event) => {
                    setBranchSearch(event.target.value);
                    setHighlightedIndex(0);
                  }}
                  onKeyDown={(event) => void onBranchSearchKeyDown(event)}
                />
              </div>

              <p className="branch-section-label">Branches</p>

              <div className="branch-list">
                {isLoadingBranches ? (
                  <p className="branch-empty">Loading...</p>
                ) : filteredBranches.length === 0 ? (
                  <p className="branch-empty">No branches found.</p>
                ) : (
                  filteredBranches.map((branch, index) => {
                    const isHighlighted = index === highlightedIndex;
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        className={isHighlighted ? 'branch-row highlighted' : 'branch-row'}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={() => void runCheckout(branch.name)}
                        disabled={isSwitchingBranch}
                      >
                        <div className="branch-row-top">
                          <span className="branch-icon">
                            <BranchGlyph />
                          </span>
                          <span className="branch-name">{branch.name}</span>
                          {branch.isCurrent ? <span className="branch-check">✓</span> : null}
                        </div>
                        {branch.isCurrent ? (
                          <p className="branch-current-status">
                            <span>Uncommitted: {branchStatus?.uncommittedFiles ?? 0} files</span>
                            <span className="branch-ins">+{branchStatus?.insertions ?? 0}</span>
                            <span className="branch-del">-{branchStatus?.deletions ?? 0}</span>
                          </p>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>

            </section>,
            document.body
          )
        : null}

      <div
        className={attachmentDragActive ? 'attachment-composer attachment-drop-active' : 'attachment-composer'}
        data-testid="attachment-composer"
        onDragEnter={onAttachmentDragEnter}
        onDragOver={onAttachmentDragOver}
        onDragLeave={onAttachmentDragLeave}
        onDrop={onAttachmentDrop}
      >
        <div className="attachment-composer-row">
          <button
            type="button"
            className="attachment-add-button"
            aria-label="Add attachments"
            title="Add attachments"
            onClick={() => void onPickAttachments()}
            disabled={!attachmentsEnabled}
          >
            <PaperclipIcon />
          </button>

          <div className="attachment-composer-main">
            {attachmentDraftPaths.length > 0 ? (
              <div className="attachment-chip-list" data-testid="attachment-chip-list">
                {attachmentDraftPaths.map((path, index) => (
                  <AttachmentChip
                    key={path}
                    path={path}
                    index={index}
                    disabled={!attachmentsEnabled}
                    onRemove={onRemoveAttachmentPath}
                  />
                ))}
              </div>
            ) : (
              <p className="attachment-drop-hint">
                {attachmentsEnabled
                  ? attachmentDragActive
                    ? 'Drop files or images to attach'
                    : 'Attach files or images. They send with your next prompt.'
                  : 'Select a thread to stage attachments'}
              </p>
            )}
          </div>

          {attachmentDraftPaths.length > 0 ? (
            <button
              type="button"
              className="attachment-clear-button"
              onClick={onClearAttachmentPaths}
              disabled={!attachmentsEnabled}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="bottom-bar-right">
        {skillsControl}
        <button
          type="button"
          className={[
            'full-access-toggle',
            selectedThread?.fullAccess ? 'enabled' : '',
            fullAccessToggleBlocked ? 'blocked' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="full-access-toggle"
          aria-label="Toggle full access"
          aria-pressed={selectedThread?.fullAccess ?? false}
          aria-disabled={fullAccessToggleBlocked || undefined}
          disabled={!selectedThread || fullAccessUpdating}
          onClick={() => {
            if (fullAccessToggleBlocked || !selectedThread || fullAccessUpdating) {
              return;
            }
            void onToggleFullAccess();
          }}
          title={
            fullAccessToggleBlockedReason ??
            (!selectedThread ? 'Select a thread' : selectedThread.fullAccess ? 'Disable full access' : 'Enable full access')
          }
        >
          <span className="full-access-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 3.8A8.2 8.2 0 1 0 20.2 12 8.2 8.2 0 0 0 12 3.8Zm0 4.4v6.1M12 17.4h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="full-access-label">{fullAccessUpdating ? 'Updating...' : 'Full access'}</span>
          <span className="full-access-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 10.5 12 15l5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
        </button>
      </div>
    </footer>
  );
}
