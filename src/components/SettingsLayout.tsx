import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
  controlClassName?: string;
  align?: 'center' | 'start';
}

interface SettingsActionFooterProps {
  leading?: ReactNode;
  trailing: ReactNode;
}

function joinClassNames(...values: Array<string | undefined>): string | undefined {
  const className = values.filter(Boolean).join(' ');
  return className.length > 0 ? className : undefined;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="settings-group">
      <div className="settings-group-header">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  className,
  controlClassName,
  align = 'center'
}: SettingsRowProps) {
  return (
    <div className={joinClassNames('settings-row', align === 'start' ? 'settings-row-start' : undefined, className)}>
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {description ? <div className="settings-row-description">{description}</div> : null}
      </div>
      <div className={joinClassNames('settings-row-control', controlClassName)}>{control}</div>
    </div>
  );
}

export function SettingsActionFooter({ leading, trailing }: SettingsActionFooterProps) {
  return (
    <footer className="settings-action-footer">
      <div className="settings-action-footer-group">{leading}</div>
      <div className="settings-action-footer-group settings-action-footer-group-right">{trailing}</div>
    </footer>
  );
}
