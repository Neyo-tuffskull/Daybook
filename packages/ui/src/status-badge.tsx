import type { ReactElement } from 'react';

export type StatusTone =
  | 'planned'
  | 'active'
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'missed';

const LABELS: Record<StatusTone, string> = {
  planned: 'Planned',
  active: 'In progress',
  completed: 'Done',
  partial: 'Partly done',
  skipped: 'Skipped',
  missed: 'Missed',
};

/**
 * State is carried by the label as well as the colour. Roughly one man in
 * twelve cannot reliably separate the completed green from the missed red, and
 * "did I do it" is the single most important thing on the timeline.
 */
export function StatusBadge({ tone }: { tone: StatusTone }): ReactElement {
  return (
    <span
      data-status={tone}
      style={{
        color: `var(--db-state-${tone})`,
        borderColor: `var(--db-state-${tone})`,
        borderWidth: 1,
        borderStyle: 'solid',
        borderRadius: 3,
        padding: '2px 8px',
        fontSize: 12,
        fontFamily: 'var(--db-font-mono)',
        whiteSpace: 'nowrap',
      }}
    >
      {LABELS[tone]}
    </span>
  );
}
