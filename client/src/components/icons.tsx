/**
 * Small stroke icons used by the application shell and dashboard: navigation
 * glyphs, theme toggle and statistic indicators. They draw with `currentColor`
 * at 24×24 and are sized via CSS, keeping the icon language consistent (no
 * external icon package is installed).
 */
import type { ReactNode } from 'react';

function IconBase({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d ? <path d={d} /> : null}
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------ nav glyphs */
export function DashboardIcon() {
  return (
    <IconBase d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  );
}

export function DocumentIcon() {
  return (
    <IconBase d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z">
      <path d="M14 2v5h5M9 13h6M9 17h4" />
    </IconBase>
  );
}

export function InboxIcon() {
  return (
    <IconBase d="M4 13h4l2 3h4l2-3h4">
      <path d="M22 13 17.5 5h-11L2 13v6h20z" />
    </IconBase>
  );
}

export function SettingsIcon() {
  return (
    <IconBase>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="18" r="2" />
    </IconBase>
  );
}

export function ChatIcon() {
  return (
    <IconBase d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
  );
}

/* ------------------------------------------------------ statistic glyphs */
export function LayersIcon() {
  return (
    <IconBase d="m12 2 10 5.5-10 5.5L2 7.5z">
      <path d="m2 12.5 10 5.5 10-5.5" />
    </IconBase>
  );
}

export function BookIcon() {
  return (
    <IconBase d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20">
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </IconBase>
  );
}

/* ------------------------------------------------------ theme toggle icons */
export function SunIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </IconBase>
  );
}

export function MoonIcon() {
  return <IconBase d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />;
}

/* -------------------------------------------------------- password fields */
export function EyeIcon() {
  return (
    <IconBase d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z">
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  );
}

export function EyeOffIcon() {
  return (
    <IconBase d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22">
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    </IconBase>
  );
}
