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
import { toast } from 'sonner';
import { AlertTriangle, GitCommitHorizontal, Pencil, Plus, Search, SlidersHorizontal, Table2, Trash2, X } from 'lucide-react';
import { Toast } from './Toast';
import { emptyFacets, facetCount, tableMatchesFacets, toggled, FilterModal, type Facets } from './FilterModal';
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

// Every edit affordance in this file goes through one `add()` (below), so a
// toast here covers all of them — no risk of a call site quietly missing
// its confirmation the way scattering `toast.success(...)` across a dozen
// button handlers would. Exhaustive `Record` on purpose: adding a new
// SchemaOp kind without a label here is a type error, not a silent gap.
const OP_LABEL: Record<SchemaOp['kind'], string> = {
  create_table: 'Table added',
  drop_table: 'Table dropped',
  rename_table: 'Table renamed',
  add_column: 'Column added',
  drop_column: 'Column dropped',
  rename_column: 'Column renamed',
  retype_column: 'Column type changed',
  set_column_nullable: 'Column nullability changed',
  set_column_default: 'Column default changed',
  add_constraint: 'Constraint added',
  drop_constraint: 'Constraint dropped',
  alter_constraint: 'Constraint updated',
  add_index: 'Index added',
  drop_index: 'Index dropped',
  alter_index: 'Index updated',
};

function defaultTypeFor(kind: ColumnType['kind']): ColumnType {
  if (kind === 'varchar') return { kind, length: 255 };
  if (kind === 'numeric') return { kind, precision: 10, scale: 2 };
  return { kind } as ColumnType;
}

/**
 * A table matches a filter if the table itself does, or anything inside it
 * does — a column, a constraint, an index. Matching keeps the WHOLE table
 * visible rather than hiding just the non-matching columns within it: this
 * is "find the table I'm looking for" in a schema with a dozen of them, not
 * a row-level search, and a table with half its columns hidden would still
 * need its own layout (constraint/index sections, the drop-table button)
 * reasoned about in a state it never actually has.
 */
function tableMatchesFilter(schema: Schema, table: Table, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (table.name.toLowerCase().includes(q)) return true;
  if (table.columns.some((c) => c.name.toLowerCase().includes(q))) return true;
  if (schema.constraints.some((c) => c.tableId === table.id && c.name.toLowerCase().includes(q))) return true;
  if (schema.indexes.some((i) => i.tableId === table.id && i.name.toLowerCase().includes(q))) return true;
  return false;
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
  const [filter, setFilter] = useState('');
  // `facets` is what actually filters the table list; `draftFacets` is what
  // the modal edits. They only converge on Apply — see FilterModal's file
  // comment for why that split exists.
  const [facets, setFacets] = useState<Facets>(emptyFacets);
  const [draftFacets, setDraftFacets] = useState<Facets>(emptyFacets);
  const [showFilters, setShowFilters] = useState(false);

  // Every add/create op built by this component already carries its own id
  // (see the id-divergence fix in core/ops.ts), so this generator is a
  // fallback that should never actually be called — it exists only because
  // applyOps requires one.
  const preview = useMemo(() => applyOps(schema, ops, counterIdGen('local')), [schema, ops]);
  const hazards = useMemo(() => validate(preview), [preview]);
  const errorHazards = hazards.filter((h) => h.severity === 'error');
  const visibleTables = useMemo(
    () => preview.tables.filter(
      (table) => tableMatchesFilter(preview, table, filter) && tableMatchesFacets(preview, table, facets),
    ),
    [preview, filter, facets],
  );
  const activeFacetCount = facetCount(facets);
  const filtering = filter.trim().length > 0 || activeFacetCount > 0;

  function openFilters() {
    setDraftFacets(facets); // reflect whatever's actually applied right now, not last time's abandoned draft
    setShowFilters(true);
  }
  function applyFilters() {
    setFacets(draftFacets);
    setShowFilters(false);
  }
  function resetFilters() {
    const empty = emptyFacets();
    setDraftFacets(empty);
    setFacets(empty);
  }

  const add = (op: SchemaOp) => {
    setOps((prev) => [...prev, op]);
    // Same `id` every time: editing a schema is rarely one op, it's a dozen
    // in a row (add a column, toggle nullable, set a default...) — without
    // this each one stacks a new toast rather than updating the last.
    toast.success(OP_LABEL[op.kind], { id: 'schema-op', description: 'Queued — commit to save it.' });
  };

  // A handful of buttons queue more than one op as a single conceptual
  // action (new table + its id column + the primary key on it). One toast
  // for the whole batch, not one per op.
  const addBatch = (ops: SchemaOp[], label: string) => {
    setOps((prev) => [...prev, ...ops]);
    toast.success(label, { id: 'schema-op', description: 'Queued — commit to save it.' });
  };

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
      toast.success('Changes committed', { description: message.trim() });
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
      <div className="card toolbar">
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
          <GitCommitHorizontal size={14} strokeWidth={2.25} aria-hidden />
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
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <AlertTriangle size={15} strokeWidth={2.25} aria-hidden />
            {errorHazards.length > 0 ? 'This schema is invalid' : 'Warnings'}
          </strong>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
            {hazards.map((h, i) => (
              <li key={i} style={{ color: h.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}>
                {h.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', maxWidth: '46rem', marginBottom: '0.75rem' }}>
        <div style={{ position: 'relative', flex: '1 1 auto' }}>
          <Search
            size={14}
            strokeWidth={2}
            aria-hidden
            style={{ position: 'absolute', left: '0.6rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }}
          />
          <input
            placeholder="Filter tables, columns, constraints, indexes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: '100%', paddingLeft: '2rem', paddingRight: filter ? '2rem' : undefined }}
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              style={{
                position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)',
                border: 'none', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', padding: '0.2rem',
              }}
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>
        <button
          type="button"
          className={`btn${activeFacetCount > 0 ? ' btn-primary' : ''}`}
          onClick={openFilters}
          aria-haspopup="dialog"
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
          Filters{activeFacetCount > 0 ? ` (${activeFacetCount})` : ''}
        </button>
      </div>

      <FilterModal
        open={showFilters}
        draft={draftFacets}
        onToggleType={(kind) => setDraftFacets((prev) => ({ ...prev, types: toggled(prev.types, kind) }))}
        onToggleNullable={(v) => setDraftFacets((prev) => ({ ...prev, nullable: toggled(prev.nullable, v) }))}
        onToggleDefault={(v) => setDraftFacets((prev) => ({ ...prev, defaults: toggled(prev.defaults, v) }))}
        onToggleConstraintKind={(kind) => setDraftFacets((prev) => ({ ...prev, constraintKinds: toggled(prev.constraintKinds, kind) }))}
        onToggleIndexUnique={(v) => setDraftFacets((prev) => ({ ...prev, indexUnique: toggled(prev.indexUnique, v) }))}
        onApply={applyFilters}
        onReset={resetFilters}
        onClose={() => setShowFilters(false)}
      />

      {filtering && (
        <p className="text-dim" style={{ fontSize: '0.85rem', margin: '-0.25rem 0 1rem' }}>
          {visibleTables.length} of {preview.tables.length} table{preview.tables.length === 1 ? '' : 's'} match
        </p>
      )}

      {filtering && visibleTables.length === 0 ? (
        <div className="card text-dim">
          No tables, columns, constraints, or indexes match{filter ? ` "${filter}"` : ' the selected filters'}.
        </div>
      ) : (
        visibleTables.map((table) => (
          <TableSection key={table.id} table={table} schema={preview} onOp={add} />
        ))
      )}

      <AddTable
        onAdd={(name) => {
          // Every table starts with an `id` primary key — the one column
          // every table needs, and the #1 thing people forgot to add by
          // hand (design.md's own hazard list warns about it constantly).
          const tableId = nanoIdGen();
          const idColumnId = nanoIdGen();
          addBatch(
            [
              { kind: 'create_table', name, id: tableId },
              { kind: 'add_column', tableId, name: 'id', type: { kind: 'int' }, nullable: false, default: null, id: idColumnId },
              { kind: 'add_constraint', constraint: { name: `${name}_pkey`, tableId, kind: 'primary_key', columnIds: [idColumnId] }, id: nanoIdGen() },
            ],
            OP_LABEL.create_table,
          );
        }}
      />
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
        <Table2 size={16} strokeWidth={2} className="text-dim" aria-hidden />
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
            <button type="button" className="btn" onClick={() => setConfirmingDrop(true)}>
              <Trash2 size={13} strokeWidth={2} aria-hidden />
              Drop table
            </button>
          )}
        </div>
      </div>

      <ColumnList
        table={table}
        onOp={onOp}
        hasPrimaryKey={schema.constraints.some((c) => c.tableId === table.id && c.kind === 'primary_key')}
      />
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
      <input
        placeholder="new-table-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        minLength={3}
        title="Table name must be at least 3 characters"
      />
      <button type="submit" className="btn">
        <Plus size={13} strokeWidth={2} aria-hidden />
        Add table
      </button>
    </form>
  );
}

/* ------------------------------------------------------------- columns */

function ColumnList({
  table,
  onOp,
  hasPrimaryKey,
}: {
  table: Table;
  onOp: (op: SchemaOp) => void;
  hasPrimaryKey: boolean;
}) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {table.columns.map((column) => (
        <ColumnRow key={column.id} tableId={table.id} column={column} schema={{ tables: [table], constraints: [], indexes: [] }} onOp={onOp} />
      ))}
      <AddColumn tableId={table.id} tableName={table.name} hasPrimaryKey={hasPrimaryKey} onOp={onOp} />
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
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            <Trash2 size={13} strokeWidth={2} aria-hidden />
            Drop
          </button>
        )}
      </span>
      <input type="hidden" value={tableId} readOnly />
    </div>
  );
}

function AddColumn({
  tableId,
  tableName,
  hasPrimaryKey,
  onOp,
}: {
  tableId: string;
  tableName: string;
  hasPrimaryKey: boolean;
  onOp: (op: SchemaOp) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ColumnType['kind']>('text');
  const [nullable, setNullable] = useState(true);
  const [primaryKey, setPrimaryKey] = useState(false);

  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', paddingTop: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const columnId = nanoIdGen();
        // A primary key column can't be nullable — enforced here rather
        // than trusting the (now disabled) checkbox's last value.
        onOp({ kind: 'add_column', tableId, name: name.trim(), type: defaultTypeFor(kind), nullable: primaryKey ? false : nullable, default: null, id: columnId });
        if (primaryKey) {
          onOp({ kind: 'add_constraint', constraint: { name: `${tableName}_pkey`, tableId, kind: 'primary_key', columnIds: [columnId] }, id: nanoIdGen() });
        }
        setName('');
        setPrimaryKey(false);
      }}
    >
      <input placeholder="column name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '10rem' }} />
      <select value={kind} onChange={(e) => setKind(e.target.value as ColumnType['kind'])}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label style={{ display: 'flex', gap: '0.3rem' }}>
        <input type="checkbox" checked={!primaryKey && nullable} disabled={primaryKey} onChange={(e) => setNullable(e.target.checked)} />
        <span className="text-dim">nullable</span>
      </label>
      {!hasPrimaryKey && (
        <label style={{ display: 'flex', gap: '0.3rem' }} title="Adds a primary key constraint on this column">
          <input type="checkbox" checked={primaryKey} onChange={(e) => setPrimaryKey(e.target.checked)} />
          <span className="text-dim">primary key</span>
        </label>
      )}
      <button type="submit" className="btn">
        <Plus size={13} strokeWidth={2} aria-hidden />
        Add column
      </button>
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
        {!editing && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            <Pencil size={13} strokeWidth={2} aria-hidden />
            Edit
          </button>
        )}
        {confirming ? (
          <>
            <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_constraint', constraintId: constraint.id })}>
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            <Trash2 size={13} strokeWidth={2} aria-hidden />
            Drop
          </button>
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
      <button type="submit" className="btn">
        <Plus size={13} strokeWidth={2} aria-hidden />
        Add constraint
      </button>
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
        {!editing && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            <Pencil size={13} strokeWidth={2} aria-hidden />
            Edit
          </button>
        )}
        {confirming ? (
          <>
            <button type="button" className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onOp({ kind: 'drop_index', indexId: index.id })}>
              Confirm
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            <Trash2 size={13} strokeWidth={2} aria-hidden />
            Drop
          </button>
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
      <button type="submit" className="btn">
        <Plus size={13} strokeWidth={2} aria-hidden />
        Add index
      </button>
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
