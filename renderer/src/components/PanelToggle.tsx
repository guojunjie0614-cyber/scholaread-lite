/** Adapted from the user's IC Agent Harness sidebar control. */
export function PanelToggle({ open, side, label, controls, className = '', onToggle }: {
  open: boolean; side: 'left' | 'right'; label: string; controls: string;
  className?: string; onToggle: () => void;
}) {
  return <button type="button" className={`panel-toggle ${className}`} data-side={side} data-open={open}
    aria-label={label} aria-expanded={open} aria-controls={controls} title={label} onClick={onToggle}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.9" y="3.9" width="15.8" height="15.8" rx="3.1" />
      <path className="sidebar-toggle-divider" d="M9.3 4.3v14.65" strokeLinecap="round" />
      <path className="sidebar-toggle-arrow" d="m-1.25-2.5 2.5 2.5-2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>;
}
