'use client';

/**
 * One conflict, one card. Three shapes, because three conflict shapes are
 * genuinely different problems (design.md §12, §7):
 *
 * - `delete_modify` isn't symmetric with the others — one option discards a
 *   colleague's whole change — so it gets its own two-button treatment that
 *   states the cost before the click, not after (D19).
 * - `name_collision` has no "ours" or "theirs" value to pick between at all
 *   (both sides produced the SAME name — that's the problem), so it offers a
 *   rename per colliding entity instead of a three-way choice.
 * - Everything else gets base/ours/theirs plus Take ours / Take theirs /
 *   Write my own, typed to the attribute.
 */

import { useState } from 'react';
import { describeType } from '@/core/diff';
import type { Conflict, Resolution } from '@/core/merge';
import type { ColumnType } from '@/core/schema';

const KINDS: ColumnType['kind'][] = [
  'smallint', 'int', 'bigint', 'boolean', 'uuid', 'date', 'timestamptz', 'jsonb', 'text', 'varchar', 'numeric',
];

export function ConflictCard({
  conflict,
  oursLabel,
  theirsLabel,
  resolution,
  onResolve,
}: {
  conflict: Conflict;
  oursLabel: string;
  theirsLabel: string;
  resolution: Resolution | undefined;
  onResolve: (resolution: Resolution) => void;
}) {
  if (conflict.class === 'delete_modify') {
    return <DeleteModifyCard conflict={conflict} oursLabel={oursLabel} theirsLabel={theirsLabel} resolution={resolution} onResolve={onResolve} />;
  }
  if (conflict.class === 'name_collision') {
    return <NameCollisionCard conflict={conflict} onResolve={onResolve} />;
  }
  return <AttributeConflictCard conflict={conflict} oursLabel={oursLabel} theirsLabel={theirsLabel} resolution={resolution} onResolve={onResolve} />;
}

/* --------------------------------------------------------------- shell */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: '1rem', borderColor: 'var(--warning)' }}>
      {children}
    </div>
  );
}

function ResolvedBadge() {
  return <span className="pill" style={{ background: 'var(--safe)', color: '#04101f' }}>resolved</span>;
}

/* ------------------------------------------------------- delete_modify */

function DeleteModifyCard({
  conflict,
  oursLabel,
  theirsLabel,
  resolution,
  onResolve,
}: {
  conflict: Conflict;
  oursLabel: string;
  theirsLabel: string;
  resolution: Resolution | undefined;
  onResolve: (resolution: Resolution) => void;
}) {
  const choice = resolution?.choice;
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <p style={{ margin: 0 }}>{conflict.description}</p>
        {choice && <ResolvedBadge />}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button
          type="button"
          className="btn"
          style={choice === 'ours' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
          onClick={() => onResolve({ conflictId: conflict.id, choice: 'ours' })}
        >
          Drop `{conflict.entity.displayName}`
        </button>
        <button
          type="button"
          className="btn"
          style={choice === 'theirs' ? { borderColor: 'var(--safe)', color: 'var(--safe)' } : undefined}
          onClick={() => onResolve({ conflictId: conflict.id, choice: 'theirs' })}
        >
          Keep it
        </button>
        <span className="text-dim" style={{ alignSelf: 'center', fontSize: '0.85rem' }}>
          ({oursLabel} deleted it, {theirsLabel} changed it)
        </span>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------- name_collision */

function NameCollisionCard({ conflict, onResolve }: { conflict: Conflict; onResolve: (r: Resolution) => void }) {
  const members = conflict.collisionMembers ?? [];
  return (
    <Card>
      <p style={{ margin: 0 }}>{conflict.description}</p>
      <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {members.map((m) => (
          <RenameRow key={m.id} entityId={m.id} currentName={m.name} side={m.side} conflictId={conflict.id} onResolve={onResolve} />
        ))}
      </div>
    </Card>
  );
}

function RenameRow({
  entityId,
  currentName,
  side,
  conflictId,
  onResolve,
}: {
  entityId: string;
  currentName: string;
  side: 'ours' | 'theirs' | null;
  conflictId: string;
  onResolve: (r: Resolution) => void;
}) {
  const [name, setName] = useState('');
  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onResolve({ conflictId, choice: 'custom', value: { entityId, name: name.trim() } });
      }}
    >
      <span className="text-dim" style={{ minWidth: '5rem' }}>{side ?? 'both'}:</span>
      <span className="mono">{currentName}</span>
      <span className="text-dim">→</span>
      <input placeholder="new name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '10rem' }} />
      <button type="submit" className="btn" disabled={!name.trim()}>Rename</button>
    </form>
  );
}

/* --------------------------------------------------------- everything else */

function AttributeConflictCard({
  conflict,
  oursLabel,
  theirsLabel,
  resolution,
  onResolve,
}: {
  conflict: Conflict;
  oursLabel: string;
  theirsLabel: string;
  resolution: Resolution | undefined;
  onResolve: (r: Resolution) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const choice = resolution?.choice;
  // constraint_divergence / index_divergence carry a full Constraint/Index as
  // base/ours/theirs — composing an arbitrary one inline is out of scope
  // (the schema editor is the tool for that); this class offers a side pick
  // only, a deliberate cut rather than a silent gap.
  const allowCustom = conflict.attribute !== 'definition';

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <p style={{ margin: 0 }}>{conflict.description}</p>
        {choice && <ResolvedBadge />}
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', margin: '0.6rem 0', fontSize: '0.9rem' }}>
        <ValueColumn label="base" value={conflict.base} attribute={conflict.attribute} />
        <ValueColumn label={oursLabel} value={conflict.ours} attribute={conflict.attribute} />
        <ValueColumn label={theirsLabel} value={conflict.theirs} attribute={conflict.attribute} />
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          style={choice === 'ours' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => onResolve({ conflictId: conflict.id, choice: 'ours' })}
        >
          Take {oursLabel}
        </button>
        <button
          type="button"
          className="btn"
          style={choice === 'theirs' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
          onClick={() => onResolve({ conflictId: conflict.id, choice: 'theirs' })}
        >
          Take {theirsLabel}
        </button>
        {allowCustom && (
          <button
            type="button"
            className="btn"
            style={choice === 'custom' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setShowCustom((v) => !v)}
          >
            Write my own
          </button>
        )}
      </div>

      {showCustom && allowCustom && (
        <div style={{ marginTop: '0.6rem' }}>
          <CustomInput
            attribute={conflict.attribute}
            initial={conflict.ours}
            onSubmit={(value) => {
              onResolve({ conflictId: conflict.id, choice: 'custom', value });
              setShowCustom(false);
            }}
          />
        </div>
      )}
    </Card>
  );
}

function ValueColumn({ label, value, attribute }: { label: string; value: unknown; attribute: string }) {
  return (
    <div>
      <div className="text-dim" style={{ fontSize: '0.75rem' }}>{label}</div>
      <div className="mono">{formatValue(value, attribute)}</div>
    </div>
  );
}

function formatValue(value: unknown, attribute: string): string {
  if (value === null || value === undefined) return attribute === 'default' ? 'no default' : '—';
  if (attribute === 'type') return describeType(value as ColumnType);
  if (attribute === 'nullable') return value ? 'nullable' : 'NOT NULL';
  return String(value);
}

/** The custom input is typed to the attribute — a text field for a name, a type picker for a type. */
function CustomInput({
  attribute,
  initial,
  onSubmit,
}: {
  attribute: string;
  initial: unknown;
  onSubmit: (value: unknown) => void;
}) {
  // Every hook call unconditionally at the top, before any early return —
  // `attribute` is fixed for the lifetime of one mounted instance here, so
  // this specific case would likely never surface the classic "hook order
  // shifted between renders" bug in practice, but the rule exists precisely
  // so nobody has to reason about "likely" case by case.
  //
  // The field starts EMPTY, never pre-filled with `initial`. A pre-filled
  // value looks editable but isn't safely editable by click-then-type: a
  // click into existing text places a cursor mid-string, not a selection, so
  // typing inserts rather than replaces — "contact_email" clicked-into and
  // typed over becomes "contact_emPRIMARY_EMAILail", not "primary_email".
  // Found by actually doing it, not by inspection. `initial` still helps as
  // a placeholder, which carries no such risk.
  const [value, setValue] = useState('');
  const placeholder =
    attribute === 'default'
      ? '(empty = no default)'
      : typeof initial === 'string'
        ? `e.g. ${initial}`
        : 'name';

  if (attribute === 'type') {
    return <CustomTypeInput initial={initial as ColumnType} onSubmit={onSubmit} />;
  }
  if (attribute === 'nullable') {
    return (
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="btn" onClick={() => onSubmit(true)}>nullable</button>
        <button type="button" className="btn" onClick={() => onSubmit(false)}>NOT NULL</button>
      </div>
    );
  }
  // name, default
  return (
    <form
      style={{ display: 'flex', gap: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(attribute === 'default' && value.trim() === '' ? null : value.trim());
      }}
    >
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
      <button type="submit" className="btn">Set</button>
    </form>
  );
}

function CustomTypeInput({ initial, onSubmit }: { initial: ColumnType; onSubmit: (value: ColumnType) => void }) {
  const [kind, setKind] = useState(initial.kind);
  const [length, setLength] = useState(initial.kind === 'varchar' ? initial.length : 255);
  const [precision, setPrecision] = useState(initial.kind === 'numeric' ? initial.precision : 10);
  const [scale, setScale] = useState(initial.kind === 'numeric' ? initial.scale : 2);

  function build(): ColumnType {
    if (kind === 'varchar') return { kind, length };
    if (kind === 'numeric') return { kind, precision, scale };
    return { kind } as ColumnType;
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <select value={kind} onChange={(e) => setKind(e.target.value as ColumnType['kind'])}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {kind === 'varchar' && <input type="number" min={1} value={length} onChange={(e) => setLength(Number(e.target.value))} style={{ width: '4rem' }} />}
      {kind === 'numeric' && (
        <>
          <input type="number" min={1} value={precision} onChange={(e) => setPrecision(Number(e.target.value))} style={{ width: '3.5rem' }} />
          <input type="number" min={0} value={scale} onChange={(e) => setScale(Number(e.target.value))} style={{ width: '3.5rem' }} />
        </>
      )}
      <button type="button" className="btn" onClick={() => onSubmit(build())}>Set</button>
    </div>
  );
}
