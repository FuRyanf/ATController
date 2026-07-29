import { useEffect } from 'react';

import type { Workspace } from '../types';
import { AppIcon } from './AppIcon';

const ICON_TONES = [
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'rose', label: 'Rose' },
  { id: 'amber', label: 'Amber' },
  { id: 'green', label: 'Green' },
  { id: 'slate', label: 'Slate' }
] as const;

interface ProjectIconDialogProps {
  workspace: Workspace | null;
  onSelect: (preference: string | null) => void;
  onClose: () => void;
}

export function ProjectIconDialog({
  workspace,
  onSelect,
  onClose
}: ProjectIconDialogProps) {
  useEffect(() => {
    if (!workspace) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, workspace]);

  if (!workspace) return null;
  const mark = workspace.name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((piece) => piece[0])
    .join('')
    .slice(0, 2)
    .toLocaleUpperCase() || '•';

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <section
        className="project-icon-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-icon-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="project-icon-title">Project icon</h2>
            <p>Choose a restrained shelf color for {workspace.name}.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <AppIcon name="close" />
          </button>
        </header>
        <div className="project-icon-options" role="radiogroup" aria-label="Project icon color">
          <button
            type="button"
            role="radio"
            aria-checked={!workspace.iconPreference}
            className={!workspace.iconPreference ? 'selected' : ''}
            onClick={() => onSelect(null)}
          >
            <span className="project-monogram">{mark}</span>
            <span>Automatic</span>
          </button>
          {ICON_TONES.map((tone) => (
            <button
              key={tone.id}
              type="button"
              role="radio"
              aria-checked={workspace.iconPreference === tone.id}
              className={workspace.iconPreference === tone.id ? 'selected' : ''}
              onClick={() => onSelect(tone.id)}
            >
              <span className={`project-monogram tone-${tone.id}`}>{mark}</span>
              <span>{tone.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
