/**
 * One row per Change. The categorisation below exists to make the identity
 * decision (design.md §3.1) visible on screen: a rename gets its OWN colour
 * and icon, distinct from both "created" and "dropped" — never a red drop
 * beside a green add for what is, underneath, one edit to one entity's name.
 */

import { describeChange, type Change } from '@/core/diff';
import type { Schema } from '@/core/schema';

type Category = 'created' | 'dropped' | 'renamed' | 'modified';

const CATEGORY: Record<Category, { color: string; icon: string; label: string }> = {
  created: { color: 'var(--safe)', icon: '+', label: 'added' },
  dropped: { color: 'var(--danger)', icon: '−', label: 'dropped' },
  renamed: { color: 'var(--accent)', icon: '→', label: 'renamed' },
  modified: { color: 'var(--warning)', icon: '~', label: 'changed' },
};

function categoryOf(change: Change): Category {
  if (change.kind.endsWith('_added') || change.kind === 'table_created') return 'created';
  if (change.kind.endsWith('_dropped')) return 'dropped';
  if (change.kind.endsWith('_renamed')) return 'renamed';
  return 'modified';
}

export function ChangeRow({ change, schema }: { change: Change; schema?: Schema }) {
  const category = categoryOf(change);
  const { color, icon, label } = CATEGORY[category];

  return (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
      <span
        aria-hidden
        className="mono"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '1.3rem', height: '1.3rem', borderRadius: '4px',
          background: color, color: '#04101f', fontWeight: 700, fontSize: '0.85rem', flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span className="pill" style={{ color, border: `1px solid ${color}`, flexShrink: 0 }}>{label}</span>
      <span>{describeChange(change, schema)}</span>
    </div>
  );
}
