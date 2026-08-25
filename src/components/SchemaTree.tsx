'use client';

/**
 * The schema editor. Renders tables, columns, constraints and indexes for a
 * branch, accumulates edits as SchemaOps, and commits them as one batch.
 *
 * The rule the whole task turns on (D21, design.md §4.1): editing a
 * constraint or index that already has an id emits `alter_constraint` /
 * `alter_index`, never a drop followed by an add. Every edit affordance in
 * this file routes through updateConstraint / updateIndex for exactly that
 * reason — there is no path here that produces drop+add except the explicit
 * "delete this rule" button.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast } from './Toast';
import { applyOps, type ConstraintPatch, type SchemaOp } from '@/core/ops';
import { validate } from '@/core/validate';
import { closureOf } from '@/core/closure';
import { counterIdGen, nanoIdGen } from '@/core/ids';
import { describeType } from '@/core/diff';
import { ExpressionBuilder } from './ExpressionBuilder';
import type {
  Column,
  ColumnType,
  Constraint,
  Expression,
  Index,
  ReferentialAction,
  Schema,
  Table,
} from '@/core/schema';

const KINDS: ColumnType['kind'][] = [
  'smallint', 'int', 'bigint', 'boolean', 'uuid', 'date', 'timestamptz', 'jsonb', 'text', 'varchar', 'numeric',
];

function defaultTypeFor(kind: ColumnType['kind']): ColumnType {
  if (kind === 'varchar') return { kind, length: 255 };
  if (kind === 'numeric') return { kind, precision: 10, scale: 2 };
  return { kind } as ColumnType;
}

export function SchemaTree({
  branchId,
  branchName,
  headCommitId,
  schema,
}: {
  branchId: string;
  branchName: string;
  headCommitId: string;
  schema: Schema;
}) {
  const router = useRouter();
  const [ops, setOps] = useState<SchemaOp[]>([]);
  const [message, setMessage] = useState('');
  const [author, setAuthor] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<{ message: string; branchMoved: boolean } | null>(null);

  // Every add/create op built by this component already carries its own id
  // (see the id-divergence fix in core/ops.ts), so this generator is a
  // fallback that should never actually be called — it exists only because
  // applyOps requires one.
  const preview = useMemo(() => applyOps(schema, ops, counterIdGen('local')), [schema, ops]);
  const hazards = useMemo(() => validate(preview), [preview]);
  const errorHazards = hazards.filter((h) => h.severity === 'error');

  const add = (op: SchemaOp) => setOps((prev) => [...prev, op]);

  async function commit() {
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch(`/api/branches/${branchId}/commits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, message, author, expectedHead: headCommitId }),
      });
      const body = await res.json();
      if (res.status === 409) {
        setCommitError({ message: 'This branch moved since you started editing.', branchMoved: true });
        return;
      }
      if (!res.ok) {
        setCommitError({ message: body.error?.message ?? 'commit failed', branchMoved: false });
        return;
      }
      setOps([]);
      setMessage('');
      router.refresh();
    } finally {
      setCommitting(false);
    }
  }

  const commitDisabled =
    ops.length === 0 || !message.trim() || !author.trim() || committing || errorHazards.length > 0;

  return (
    <div>
      <div
        className="card"
        style={{ position: 'sticky', top: '1rem', zIndex: 1, marginBottom: '1.5rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}
      >
        <strong className="mono">{branchName}</strong>
        <span className="text-dim">
          {ops.length === 0 ? 'no uncommitted changes' : `${ops.length} uncommitted change${ops.length === 1 ? '' : 's'}`}
        </span>
        <input placeholder="commit message" value={message} onChange={(e) => setMessage(e.target.value)} style={{ flex: '1 1 12rem' }} />
        <input placeholder="your name" value={author} onChange={(e) => setAuthor(e.target.value)} style={{ width: '9rem' }} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={commitDisabled}
          onClick={commit}
          title={
            ops.length === 0
              ? 'no changes to commit'
              : errorHazards.length > 0
                ? `${errorHazards.length} hazard(s) must be fixed first`
                : !message.trim()
                  ? 'commit message required'
                  : !author.trim()
                    ? 'your name is required'
                    : undefined
          }
        >
          {committing ? 'Committing…' : 'Commit'}
        </button>
      </div>

      {commitError && (
        <Toast
          message={commitError.message}
          action={commitError.branchMoved ? { label: 'Refresh', onClick: () => router.refresh() } : undefined}
          onDismiss={() => setCommitError(null)}
        />
      )}

      {hazards.length > 0 && (
        <div className="card" style={{ marginBottom: '1.5rem', borderColor: errorHazards.length ? 'var(--danger)' : 'var(--warning)' }}>
          <strong>{errorHazards.length > 0 ? 'This schema is invalid' : 'Warnings'}</strong>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
            {hazards.map((h, i) => (
              <li key={i} style={{ color: h.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}>
                {h.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.tables.map((table) => (
        <TableSection key={table.id} table={table} schema={preview} onOp={add} />
      ))}

      <AddTable onAdd={(name) => add({ kind: 'create_table', name, id: nanoIdGen() })} />
    </div>
  );
}

/* -------------------------------------------------------------- tables */

function TableSection({ table, schema, onOp }: { table: Table; schema: Schema; onOp: (op: SchemaOp) => void }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(table.name);
  const [confirmingDrop, setConfirmingDrop] = useState(false);

  const impact = useMemo(() => describeImpact(schema, table.id, table.name), [schema, table.id, table.name]);

  return (
    <section className="card" style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {editingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name !== table.name) onOp({ kind: 'rename_table', tableId: table.id, name: name.trim() });
              setEditingName(false);
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setEditingName(false)} />
          </form>
        ) : (
          <h2 className="mono" style={{ margin: 0, cursor: 'pointer' }} onClick={() => setEditingName(true)} title="click to rename">
            {table.name}
          </h2>
        )}
        <span className="text-dim">{table.columns.length} column{table.columns.length === 1 ? '' : 's'}</span>
        <div style={{ marginLeft: 'auto' }}>
          {confirmingDrop ? (
            <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <span className="text-dim">{impact}</span>
              <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_table', tableId: table.id })}>
                Confirm drop
              </button>
              <button type="button" className="btn" onClick={() => setConfirmingDrop(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmingDrop(true)}>Drop table</button>
          )}
        </div>
      </div>

      <ColumnList table={table} onOp={onOp} />
      <ConstraintList table={table} schema={schema} onOp={onOp} />
      <IndexList table={table} schema={schema} onOp={onOp} />
    </section>
  );
}

function AddTable({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="card"
      style={{ display: 'flex', gap: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onAdd(name.trim());
        setName('');
      }}
    >
      <input placeholder="new-table-name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn">Add table</button>
    </form>
  );
}

/* ------------------------------------------------------------- columns */

function ColumnList({ table, onOp }: { table: Table; onOp: (op: SchemaOp) => void }) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {table.columns.map((column) => (
        <ColumnRow key={column.id} tableId={table.id} column={column} schema={{ tables: [table], constraints: [], indexes: [] }} onOp={onOp} />
      ))}
      <AddColumn tableId={table.id} onOp={onOp} />
    </div>
  );
}

function ColumnRow({
  tableId,
  column,
  onOp,
}: {
  tableId: string;
  column: Column;
  schema: Schema;
  onOp: (op: SchemaOp) => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(column.name);
  const [editingType, setEditingType] = useState(false);
  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultValue, setDefaultValue] = useState(column.default ?? '');
  const [confirming, setConfirming] = useState(false);

  return (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.3rem 0', borderTop: '1px solid var(--border)' }}>
      {editingName ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name !== column.name) onOp({ kind: 'rename_column', columnId: column.id, name: name.trim() });
            setEditingName(false);
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setEditingName(false)} style={{ width: '10rem' }} />
        </form>
      ) : (
        <span className="mono" style={{ width: '10rem', cursor: 'pointer' }} onClick={() => setEditingName(true)} title="click to rename">
          {column.name}
        </span>
      )}

      {editingType ? (
        <TypeEditor
          value={column.type}
          onChange={(type) => {
            onOp({ kind: 'retype_column', columnId: column.id, type });
            setEditingType(false);
          }}
          onCancel={() => setEditingType(false)}
        />
      ) : (
        <span className="text-dim mono" style={{ cursor: 'pointer', minWidth: '7rem' }} onClick={() => setEditingType(true)} title="click to change type">
          {describeType(column.type)}
        </span>
      )}

      <label style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={column.nullable}
          onChange={(e) => onOp({ kind: 'set_column_nullable', columnId: column.id, nullable: e.target.checked })}
        />
        <span className="text-dim">nullable</span>
      </label>

      {editingDefault ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onOp({ kind: 'set_column_default', columnId: column.id, default: defaultValue.trim() || null });
            setEditingDefault(false);
          }}
        >
          <input
            autoFocus
            placeholder="default"
            value={defaultValue}
            onChange={(e) => setDefaultValue(e.target.value)}
            onBlur={() => setEditingDefault(false)}
            style={{ width: '6rem' }}
          />
        </form>
      ) : (
        <span className="text-dim" style={{ cursor: 'pointer', minWidth: '4rem' }} onClick={() => setEditingDefault(true)} title="click to set default">
          {column.default === null ? <em>no default</em> : column.default}
        </span>
      )}

      <span style={{ marginLeft: 'auto' }}>
        {confirming ? (
          <>
            <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_column', columnId: column.id })}>
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)} style={{ marginLeft: '0.3rem' }}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>Drop</button>
        )}
      </span>
      <input type="hidden" value={tableId} readOnly />
    </div>
  );
}

function AddColumn({ tableId, onOp }: { tableId: string; onOp: (op: SchemaOp) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ColumnType['kind']>('text');
  const [nullable, setNullable] = useState(true);

  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', paddingTop: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onOp({ kind: 'add_column', tableId, name: name.trim(), type: defaultTypeFor(kind), nullable, default: null, id: nanoIdGen() });
        setName('');
      }}
    >
      <input placeholder="column name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '10rem' }} />
      <select value={kind} onChange={(e) => setKind(e.target.value as ColumnType['kind'])}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label style={{ display: 'flex', gap: '0.3rem' }}>
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
        <span className="text-dim">nullable</span>
      </label>
      <button type="submit" className="btn">Add column</button>
    </form>
  );
}

function TypeEditor({ value, onChange, onCancel }: { value: ColumnType; onChange: (t: ColumnType) => void; onCancel: () => void }) {
  const [kind, setKind] = useState(value.kind);
  const [length, setLength] = useState(value.kind === 'varchar' ? value.length : 255);
  const [precision, setPrecision] = useState(value.kind === 'numeric' ? value.precision : 10);
  const [scale, setScale] = useState(value.kind === 'numeric' ? value.scale : 2);

  function build(): ColumnType {
    if (kind === 'varchar') return { kind, length };
    if (kind === 'numeric') return { kind, precision, scale };
    return { kind } as ColumnType;
  }

  return (
    <span style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
      <select autoFocus value={kind} onChange={(e) => setKind(e.target.value as ColumnType['kind'])}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {kind === 'varchar' && (
        <input type="number" min={1} value={length} onChange={(e) => setLength(Number(e.target.value))} style={{ width: '4rem' }} />
      )}
      {kind === 'numeric' && (
        <>
          <input type="number" min={1} value={precision} onChange={(e) => setPrecision(Number(e.target.value))} style={{ width: '3.5rem' }} />
          <input type="number" min={0} value={scale} onChange={(e) => setScale(Number(e.target.value))} style={{ width: '3.5rem' }} />
        </>
      )}
      <button type="button" className="btn" onClick={() => onChange(build())}>Set</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </span>
  );
}

/* --------------------------------------------------------- constraints */

function ConstraintList({ table, schema, onOp }: { table: Table; schema: Schema; onOp: (op: SchemaOp) => void }) {
  const rows = schema.constraints.filter((c) => c.tableId === table.id);
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div className="text-dim" style={{ fontSize: '0.85rem', margin: '0.5rem 0 0.25rem' }}>Constraints</div>
      {rows.map((c) => (
        <ConstraintRow key={c.id} constraint={c} table={table} onOp={onOp} />
      ))}
      <AddConstraint table={table} onOp={onOp} />
    </div>
  );
}

function ConstraintRow({ constraint, table, onOp }: { constraint: Constraint; table: Table; onOp: (op: SchemaOp) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Every edit here goes through alter_constraint — the id in the closure is
  // never re-minted, which is exactly what keeps constraint_divergence
  // detectable when two branches edit the same rule (D21).
  const patch = (p: ConstraintPatch) =>
    onOp({ kind: 'alter_constraint', constraintId: constraint.id, patch: p });

  return (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.3rem 0', borderTop: '1px solid var(--border)' }}>
      <span className="pill mono" style={{ background: 'var(--border)' }}>{constraint.kind}</span>
      <span className="mono text-dim">{constraint.name}</span>

      {!editing && <ConstraintSummary constraint={constraint} table={table} />}

      {editing && (
        <ConstraintEditor
          constraint={constraint}
          table={table}
          onChange={(p) => { patch(p); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}

      <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.3rem' }}>
        {!editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {confirming ? (
          <>
            <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_constraint', constraintId: constraint.id })}>
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>Drop</button>
        )}
      </span>
    </div>
  );
}

function ConstraintSummary({ constraint, table }: { constraint: Constraint; table: Table }) {
  const nameOf = (id: string) => table.columns.find((c) => c.id === id)?.name ?? id;
  if (constraint.kind === 'check') return <span className="text-dim mono">{renderExpr(constraint.expression, table.columns)}</span>;
  if (constraint.kind === 'foreign_key') {
    return <span className="text-dim mono">({constraint.columnIds.map(nameOf).join(', ')}) → {constraint.referencedTableId}</span>;
  }
  return <span className="text-dim mono">({constraint.columnIds.map(nameOf).join(', ')})</span>;
}

function renderExpr(expr: Expression, columns: Column[]): string {
  let out = expr.template;
  expr.columnIds.forEach((id, i) => {
    out = out.replace(`{${i}}`, columns.find((c) => c.id === id)?.name ?? id);
  });
  return out;
}

function ConstraintEditor({
  constraint,
  table,
  onChange,
  onCancel,
}: {
  constraint: Constraint;
  table: Table;
  onChange: (patch: ConstraintPatch) => void;
  onCancel: () => void;
}) {
  if (constraint.kind === 'primary_key' || constraint.kind === 'unique') {
    return (
      <ColumnSetPicker
        columns={table.columns}
        selected={constraint.columnIds}
        onSubmit={(columnIds) => onChange({ columnIds })}
        onCancel={onCancel}
      />
    );
  }
  if (constraint.kind === 'check') {
    return (
      <CheckEditor
        columns={table.columns}
        value={constraint.expression}
        onSubmit={(expression) => onChange({ expression })}
        onCancel={onCancel}
      />
    );
  }
  // foreign_key: the UI only edits the referential actions and the local
  // column set. Repointing which table/columns it references is treated as
  // a different rule and left to drop + add — a deliberate scope cut, not
  // a limitation of alter_constraint itself.
  return (
    <ForeignKeyEditor
      columns={table.columns}
      constraint={constraint}
      onSubmit={(patch) => onChange(patch)}
      onCancel={onCancel}
    />
  );
}

function ColumnSetPicker({
  columns,
  selected,
  onSubmit,
  onCancel,
}: {
  columns: Column[];
  selected: string[];
  onSubmit: (columnIds: string[]) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(new Set(selected));
  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <span style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
      {columns.map((c) => (
        <label key={c.id} style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
          <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
          <span className="mono">{c.name}</span>
        </label>
      ))}
      <button type="button" className="btn" disabled={chosen.size === 0} onClick={() => onSubmit([...chosen])}>Set</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </span>
  );
}

function CheckEditor({
  columns,
  value,
  onSubmit,
  onCancel,
}: {
  columns: Column[];
  value: Expression;
  onSubmit: (expr: Expression) => void;
  onCancel: () => void;
}) {
  const [expr, setExpr] = useState<Expression | null>(value);
  return (
    <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <ExpressionBuilder columns={columns} value={expr} onChange={setExpr} />
      <button type="button" className="btn" disabled={!expr} onClick={() => expr && onSubmit(expr)}>Set</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </span>
  );
}

const ACTIONS: ReferentialAction[] = ['no_action', 'restrict', 'cascade', 'set_null'];

function ForeignKeyEditor({
  columns,
  constraint,
  onSubmit,
  onCancel,
}: {
  columns: Column[];
  constraint: Extract<Constraint, { kind: 'foreign_key' }>;
  onSubmit: (patch: ConstraintPatch) => void;
  onCancel: () => void;
}) {
  const [columnId, setColumnId] = useState(constraint.columnIds[0] ?? columns[0]?.id ?? '');
  const [onDelete, setOnDelete] = useState<ReferentialAction>(constraint.onDelete);
  const [onUpdate, setOnUpdate] = useState<ReferentialAction>(constraint.onUpdate);

  return (
    <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
      <select value={columnId} onChange={(e) => setColumnId(e.target.value)}>
        {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <span className="text-dim">on delete</span>
      <select value={onDelete} onChange={(e) => setOnDelete(e.target.value as ReferentialAction)}>
        {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <span className="text-dim">on update</span>
      <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value as ReferentialAction)}>
        {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <button type="button" className="btn" onClick={() => onSubmit({ columnIds: [columnId], onDelete, onUpdate })}>Set</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </span>
  );
}

function AddConstraint({ table, onOp }: { table: Table; onOp: (op: SchemaOp) => void }) {
  const [kind, setKind] = useState<Constraint['kind']>('unique');
  const [name, setName] = useState('');
  const [columnIds, setColumnIds] = useState<Set<string>>(new Set());
  const [expr, setExpr] = useState<Expression | null>(null);

  const toggle = (id: string) => setColumnIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (kind === 'check') {
      if (!expr) return;
      onOp({ kind: 'add_constraint', constraint: { name: name.trim(), tableId: table.id, kind: 'check', expression: expr }, id: nanoIdGen() });
    } else if (kind === 'primary_key' || kind === 'unique') {
      if (columnIds.size === 0) return;
      onOp({ kind: 'add_constraint', constraint: { name: name.trim(), tableId: table.id, kind, columnIds: [...columnIds] }, id: nanoIdGen() });
    }
    setName('');
    setColumnIds(new Set());
    setExpr(null);
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', paddingTop: '0.5rem' }}>
      <select value={kind} onChange={(e) => setKind(e.target.value as Constraint['kind'])}>
        <option value="unique">unique</option>
        <option value="primary_key">primary key</option>
        <option value="check">check</option>
      </select>
      <input placeholder="constraint name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '10rem' }} />
      {(kind === 'primary_key' || kind === 'unique') && (
        <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {table.columns.map((c) => (
            <label key={c.id} style={{ display: 'flex', gap: '0.2rem' }}>
              <input type="checkbox" checked={columnIds.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="mono">{c.name}</span>
            </label>
          ))}
        </span>
      )}
      {kind === 'check' && <ExpressionBuilder columns={table.columns} value={expr} onChange={setExpr} />}
      <button type="submit" className="btn">Add constraint</button>
      <span className="text-dim" style={{ fontSize: '0.8rem' }}>
        (foreign keys: add from the referencing table)
      </span>
    </form>
  );
}

/* -------------------------------------------------------------- indexes */

function IndexList({ table, schema, onOp }: { table: Table; schema: Schema; onOp: (op: SchemaOp) => void }) {
  const rows = schema.indexes.filter((i) => i.tableId === table.id);
  return (
    <div>
      <div className="text-dim" style={{ fontSize: '0.85rem', margin: '0.5rem 0 0.25rem' }}>Indexes</div>
      {rows.map((idx) => (
        <IndexRow key={idx.id} index={idx} table={table} onOp={onOp} />
      ))}
      <AddIndex table={table} onOp={onOp} />
    </div>
  );
}

function IndexRow({ index, table, onOp }: { index: Index; table: Table; onOp: (op: SchemaOp) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const nameOf = (id: string) => table.columns.find((c) => c.id === id)?.name ?? id;

  // Same rule as constraints: every edit is alter_index, so index_divergence
  // stays detectable when two branches tune the same index differently.
  const patch = (p: Partial<Omit<Index, 'id' | 'tableId'>>) => onOp({ kind: 'alter_index', indexId: index.id, patch: p });

  return (
    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.3rem 0', borderTop: '1px solid var(--border)' }}>
      <span className="mono text-dim">{index.name}</span>
      {!editing ? (
        <span className="text-dim mono">
          ({index.columnIds.map(nameOf).join(', ')}){index.unique ? ' unique' : ''} {index.method}
          {index.where ? ` where ${renderExpr(index.where, table.columns)}` : ''}
        </span>
      ) : (
        <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <ColumnSetPicker columns={table.columns} selected={index.columnIds} onSubmit={(columnIds) => { patch({ columnIds }); setEditing(false); }} onCancel={() => setEditing(false)} />
          <label style={{ display: 'flex', gap: '0.25rem' }}>
            <input type="checkbox" checked={index.unique} onChange={(e) => patch({ unique: e.target.checked })} />
            <span className="text-dim">unique</span>
          </label>
        </span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.3rem' }}>
        {!editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>}
        {confirming ? (
          <>
            <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_index', indexId: index.id })}>
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>Drop</button>
        )}
      </span>
    </div>
  );
}

function AddIndex({ table, onOp }: { table: Table; onOp: (op: SchemaOp) => void }) {
  const [name, setName] = useState('');
  const [columnIds, setColumnIds] = useState<Set<string>>(new Set());
  const [unique, setUnique] = useState(false);

  const toggle = (id: string) => setColumnIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', paddingTop: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || columnIds.size === 0) return;
        onOp({ kind: 'add_index', index: { name: name.trim(), tableId: table.id, columnIds: [...columnIds], unique, method: 'btree', where: null }, id: nanoIdGen() });
        setName('');
        setColumnIds(new Set());
      }}
    >
      <input placeholder="index name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '10rem' }} />
      {table.columns.map((c) => (
        <label key={c.id} style={{ display: 'flex', gap: '0.2rem' }}>
          <input type="checkbox" checked={columnIds.has(c.id)} onChange={() => toggle(c.id)} />
          <span className="mono">{c.name}</span>
        </label>
      ))}
      <label style={{ display: 'flex', gap: '0.25rem' }}>
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        <span className="text-dim">unique</span>
      </label>
      <button type="submit" className="btn">Add index</button>
    </form>
  );
}

/* --------------------------------------------------------------- impact */

/** Human-readable summary of what dropping an entity takes with it (§7.2's closure, surfaced for confirmation). */
function describeImpact(schema: Schema, entityId: string, ownName: string): string {
  const closure = closureOf(schema, entityId);
  const others = [...closure].filter((id) => id !== entityId);
  if (others.length === 0) return `Drops \`${ownName}\` only.`;

  const parts: string[] = [];
  const columnCount = others.filter((id) => schema.tables.some((t) => t.columns.some((c) => c.id === id))).length;
  if (columnCount) parts.push(`${columnCount} column${columnCount === 1 ? '' : 's'}`);
  const constraintNames = schema.constraints.filter((c) => others.includes(c.id)).map((c) => c.name);
  if (constraintNames.length) parts.push(`constraint${constraintNames.length === 1 ? '' : 's'} ${constraintNames.join(', ')}`);
  const indexNames = schema.indexes.filter((i) => others.includes(i.id)).map((i) => i.name);
  if (indexNames.length) parts.push(`index${indexNames.length === 1 ? '' : 'es'} ${indexNames.join(', ')}`);

  return `Also drops: ${parts.join('; ')}.`;
}
