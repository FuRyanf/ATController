import type { SVGProps } from 'react';

export type AppIconName =
  | 'add'
  | 'archive'
  | 'arrowDown'
  | 'attachment'
  | 'browser'
  | 'camera'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'close'
  | 'code'
  | 'command'
  | 'copy'
  | 'ellipsis'
  | 'file'
  | 'folder'
  | 'gear'
  | 'history'
  | 'info'
  | 'panelLeft'
  | 'panelRight'
  | 'pin'
  | 'refresh'
  | 'search'
  | 'send'
  | 'stop'
  | 'terminal'
  | 'trash'
  | 'warning';

interface AppIconProps extends SVGProps<SVGSVGElement> {
  name: AppIconName;
  size?: number;
}
export function AppIcon({ name, size = 16, ...props }: AppIconProps) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  };
  const path = (() => {
    switch (name) {
      case 'add':
        return <path d="M12 5v14M5 12h14" {...common} />;
      case 'archive':
        return (
          <>
            <path d="M4 7h16v12H4zM3 4h18v3H3z" {...common} />
            <path d="M9 11h6" {...common} />
          </>
        );
      case 'arrowDown':
        return <path d="m7 10 5 5 5-5" {...common} />;
      case 'attachment':
        return <path d="m9.5 12.5 5.7-5.7a3 3 0 1 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l8-8" {...common} />;
      case 'browser':
        return (
          <>
            <rect x="3.5" y="4.5" width="17" height="15" rx="2" {...common} />
            <path d="M3.5 8.5h17M7 6.5h.01m3 0h.01" {...common} />
          </>
        );
      case 'camera':
        return (
          <>
            <path d="M4 8h3l1.4-2h7.2L17 8h3v10H4z" {...common} />
            <circle cx="12" cy="13" r="3" {...common} />
          </>
        );
      case 'check':
        return <path d="m5 12.5 4.2 4.2L19 7" {...common} />;
      case 'chevronDown':
        return <path d="m7 9.5 5 5 5-5" {...common} />;
      case 'chevronRight':
        return <path d="m9.5 7 5 5-5 5" {...common} />;
      case 'close':
        return <path d="m6.5 6.5 11 11m0-11-11 11" {...common} />;
      case 'code':
        return <path d="m8.5 8-4 4 4 4m7-8 4 4-4 4m-4.2 3 1.4-14" {...common} />;
      case 'command':
        return (
          <>
            <path d="M9 7.5V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" {...common} />
          </>
        );
      case 'copy':
        return <path d="M8 8h11v11H8zM5 16H4V5h11v1" {...common} />;
      case 'ellipsis':
        return (
          <>
            <circle cx="5" cy="12" r="1" fill="currentColor" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
            <circle cx="19" cy="12" r="1" fill="currentColor" />
          </>
        );
      case 'file':
        return <path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6m-6 3h6" {...common} />;
      case 'folder':
        return <path d="M3.5 6.5h6l2 2h9v10h-17z" {...common} />;
      case 'gear':
        return (
          <>
            <circle cx="12" cy="12" r="3" {...common} />
            <path d="M19 13.5v-3l-2-.6a7 7 0 0 0-.8-1.8l1-1.9-2.2-2.1-1.8 1a7 7 0 0 0-2-.8L10.5 2h-3l-.6 2.2a7 7 0 0 0-1.8.8L3.2 4 1.1 6.2l1 1.9a7 7 0 0 0-.8 1.8L-1 10.5" {...common} transform="translate(3 1)" />
          </>
        );
      case 'history':
        return <path d="M4 10a8 8 0 1 1 2 7M4 5v5h5M12 8v4l3 2" {...common} />;
      case 'info':
        return (
          <>
            <circle cx="12" cy="12" r="9" {...common} />
            <path d="M12 11v6m0-10h.01" {...common} />
          </>
        );
      case 'panelLeft':
        return <path d="M3.5 4.5h17v15h-17zM9 4.5v15" {...common} />;
      case 'panelRight':
        return <path d="M3.5 4.5h17v15h-17zM15 4.5v15" {...common} />;
      case 'pin':
        return <path d="m8 4 8 1-1 5 3 3-5 1-4 6 1-7-4-4 5-1z" {...common} />;
      case 'refresh':
        return <path d="M19 7v5h-5M5 17v-5h5m8.2-.5A7 7 0 0 0 6.5 7M5.8 12.5A7 7 0 0 0 17.5 17" {...common} />;
      case 'search':
        return (
          <>
            <circle cx="10.5" cy="10.5" r="6.5" {...common} />
            <path d="m15.5 15.5 4 4" {...common} />
          </>
        );
      case 'send':
        return <path d="m4 12 16-8-6.5 16-2.3-6.8zm7.2 1.2L20 4" {...common} />;
      case 'stop':
        return <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />;
      case 'terminal':
        return <path d="m4 7 5 5-5 5m8-1h8" {...common} />;
      case 'trash':
        return <path d="M5 7h14m-9-3h4l1 3m-8 0 1 13h8l1-13M10 11v5m4-5v5" {...common} />;
      case 'warning':
        return (
          <>
            <path d="M12 3 2.8 20h18.4z" {...common} />
            <path d="M12 9v5m0 3h.01" {...common} />
          </>
        );
    }
  })();

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {path}
    </svg>
  );
}
