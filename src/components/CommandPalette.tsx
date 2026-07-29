import { useEffect, useMemo, useRef, useState } from 'react';

import { AppIcon, type AppIconName } from './AppIcon';

export interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  icon: AppIconName;
  keywords?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}
interface CommandPaletteProps {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

function fuzzyScore(query: string, candidate: string): number {
  const needle = query.toLocaleLowerCase().replace(/\s+/g, '');
  const haystack = candidate.toLocaleLowerCase();
  if (!needle) return 1;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1_000 - direct;
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, cursor);
    if (next < 0) return -1;
    score += Math.max(1, 20 - (next - cursor));
    cursor = next + 1;
  }
  return score;
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(
    () =>
      actions
        .filter((action) => !action.disabled)
        .map((action) => ({
          action,
          score: fuzzyScore(query, `${action.label} ${action.description ?? ''} ${action.keywords ?? ''}`)
        }))
        .filter(({ score }) => score >= 0)
        .sort((left, right) => right.score - left.score)
        .map(({ action }) => action),
    [actions, query]
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const runSelected = () => {
    const action = filtered[selected];
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div className="palette-backdrop" role="presentation" onPointerDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label className="palette-search">
          <AppIcon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Type a command"
            aria-label="Search commands"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((current) => Math.min(filtered.length - 1, current + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((current) => Math.max(0, current - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runSelected();
              }
            }}
          />
          <kbd>esc</kbd>
        </label>
        <div className="palette-results" role="listbox">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching command</div>
          ) : (
            filtered.map((action, index) => (
              <button
                key={action.id}
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`${index === selected ? 'selected' : ''} ${action.danger ? 'danger' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => {
                  onClose();
                  action.run();
                }}
              >
                <span className="palette-action-icon"><AppIcon name={action.icon} /></span>
                <span>
                  <strong>{action.label}</strong>
                  {action.description ? <small>{action.description}</small> : null}
                </span>
                {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
