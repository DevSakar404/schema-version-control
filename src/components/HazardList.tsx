/**
 * Hazards, kept visually and structurally separate from conflicts
 * (design.md §12, §8): nobody disagreed here — the COMBINATION of two
 * changes, or a schema that was already invalid, is what's wrong. There is
 * no choice to offer, only a defect to report.
 *
 * Where causedBy correlates changes from both branches, the card names them.
 * The wording is always "touched", never "caused" — this is correlation by
 * entity, not proof of blame (D24).
 */

import { AlertTriangle } from 'lucide-react';
import type { AttributedHazard } from '@/core/merge';

export function HazardList({
  hazards,
  oursLabel,
  theirsLabel,
}: {
  hazards: AttributedHazard[];
  oursLabel: string;
  theirsLabel: string;
}) {
  if (hazards.length === 0) return null;
  const errors = hazards.filter((h) => h.severity === 'error');

  return (
    <section className="card" style={{ marginBottom: '1.5rem', borderColor: errors.length ? 'var(--danger)' : 'var(--warning)' }}>
      <h2 style={{ margin: '0 0 0.3rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <AlertTriangle size={16} strokeWidth={2.25} aria-hidden />
        {errors.length > 0 ? 'This merge would be invalid' : 'Warnings'}
      </h2>
      <p className="text-dim" style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>
        Nobody disagreed on any of these — the combination of two independently fine changes is what breaks.
      </p>
      {hazards.map((hazard, i) => (
        <HazardRow key={i} hazard={hazard} oursLabel={oursLabel} theirsLabel={theirsLabel} />
      ))}
    </section>
  );
}

function HazardRow({ hazard, oursLabel, theirsLabel }: { hazard: AttributedHazard; oursLabel: string; theirsLabel: string }) {
  const pillClass = hazard.severity === 'error' ? 'pill-danger' : 'pill-warning';
  return (
    <div style={{ padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
        <span className={`pill ${pillClass}`}>{hazard.class.replace(/_/g, ' ')}</span>
        <span>{hazard.description}</span>
      </div>
      <Attribution hazard={hazard} oursLabel={oursLabel} theirsLabel={theirsLabel} />
    </div>
  );
}

function Attribution({ hazard, oursLabel, theirsLabel }: { hazard: AttributedHazard; oursLabel: string; theirsLabel: string }) {
  const ours = hazard.causedBy?.ours ?? [];
  const theirs = hazard.causedBy?.theirs ?? [];
  if (ours.length === 0 && theirs.length === 0) return null;

  const parts: string[] = [];
  if (ours.length) parts.push(`${oursLabel} touched this`);
  if (theirs.length) parts.push(`${theirsLabel} touched this`);

  return (
    <p className="text-dim" style={{ margin: '0.3rem 0 0', fontSize: '0.85rem' }}>
      {parts.join(' — ')}.
    </p>
  );
}
