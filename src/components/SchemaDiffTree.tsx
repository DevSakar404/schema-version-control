/**
 * The full schema, annotated with what changed — a code-review diff rather
 * than a changelog (see core/difftree.ts for why both shapes exist).
 *
 * Unchanged rows are rendered as dimmed context. A modified row is rendered
 * as two lines, the old one and the new one, the way a line-based diff shows
 * a replaced line. Tables with no changes at all collapse into a `<details>`
 * so they stay reachable without competing for attention — which is also why
 * this needs no client JavaScript.
 */

import type { DiffRow, DiffTree, RowStatus, TableDiff } from '@/core/difftree';

const MARKER: Record<RowStatus, { glyph: string; label: string; color: string }> = {
  added: { glyph: '+', label: 'added', color: 'var(--safe)' },
  dropped: { glyph: '−', label: 'dropped', color: 'var(--danger)' },
  modified: { glyph: '~', label: 'changed', color: 'var(--warning)' },
  unchanged: { glyph: ' ', label: 'unchanged', color: 'var(--text-dim)' },
};

export function SchemaDiffTree({ tree }: { tree: DiffTree }) {
  const changed = tree.tables.filter((t) => t.changeCount > 0);
  const unchanged = tree.tables.filter((t) => t.changeCount === 0);

  return (
    <>
      <p className="text-dim">
        {tree.totalChanges} change{tree.totalChanges === 1 ? '' : 's'} across{' '}
        {tree.changedTables} table{tree.changedTables === 1 ? '' : 's'}
        {unchanged.length > 0 && `, ${unchanged.length} unchanged`}.
      </p>

      {changed.map((table) => (
        <TableCard key={table.id} table={table} />
      ))}

      {unchanged.length > 0 && (
        <details className="card" style={{ marginBottom: '1rem' }}>
          <summary className="text-dim" style={{ cursor: 'pointer' }}>
            {unchanged.length} unchanged table{unchanged.length === 1 ? '' : 's'}
          </summary>
          <div style={{ marginTop: '0.75rem' }}>
            {unchanged.map((table) => (
              <div key={table.id} style={{ marginBottom: '1rem' }}>
                {/* The name has to travel with the body here — without it,
                    an expanded list of unchanged tables is just columns with
                    no indication which table any of them belong to. */}
                <h3 className="mono" style={{ margin: '0 0 0.2rem', fontSize: '0.95rem' }}>{table.name}</h3>
                <TableBody table={table} />
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function TableCard({ table }: { table: TableDiff }) {
  const marker = MARKER[table.status];
  return (
    <section
      className="card"
      style={{
        marginBottom: '1rem',
        borderColor: table.status === 'unchanged' ? 'var(--border)' : marker.color,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 className="mono" style={{ margin: 0, fontSize: '1.05rem' }}>
          {table.renamedFrom ? (
            <>
              <span style={{ color: 'var(--text-dim)', textDecoration: 'line-through' }}>{table.renamedFrom}</span>
              <span style={{ margin: '0 0.4rem' }}>→</span>
              {table.name}
            </>
          ) : (
            table.name
          )}
        </h2>
        {table.status !== 'unchanged' && (
          <span className="pill" style={{ color: marker.color, border: `1px solid ${marker.color}` }}>
            table {marker.label}
          </span>
        )}
        <span className="text-dim" style={{ marginLeft: 'auto', fontSize: '0.85rem' }}>
          {table.changeCount} change{table.changeCount === 1 ? '' : 's'}
        </span>
      </div>
      <TableBody table={table} />
    </section>
  );
}

function TableBody({ table }: { table: TableDiff }) {
  return (
    <>
      <Section title="Columns" rows={table.columns} />
      <Section title="Constraints" rows={table.constraints} />
      <Section title="Indexes" rows={table.indexes} />
    </>
  );
}

function Section<T>({ title, rows }: { title: string; rows: DiffRow<T>[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: '0.6rem' }}>
      <div className="text-dim" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0.2rem' }}>{title}</div>
      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </div>
  );
}

function Row<T>({ row }: { row: DiffRow<T> }) {
  // A replaced row shows both sides, the way a line diff does. Everything
  // else is a single line carrying whichever side exists.
  if (row.status === 'modified' && row.beforeLabel && row.afterLabel) {
    return (
      <div>
        <Line glyph="−" color="var(--danger)" background="var(--del-bg)" text={row.beforeLabel} srLabel="before" />
        <Line glyph="+" color="var(--safe)" background="var(--add-bg)" text={row.afterLabel} srLabel="after" />
        <Notes notes={row.notes} />
      </div>
    );
  }

  const marker = MARKER[row.status];
  const text = row.afterLabel ?? row.beforeLabel ?? '';
  const background =
    row.status === 'added' ? 'var(--add-bg)' : row.status === 'dropped' ? 'var(--del-bg)' : 'transparent';

  return (
    <div>
      <Line
        glyph={marker.glyph}
        color={marker.color}
        background={background}
        text={text}
        dim={row.status === 'unchanged'}
        srLabel={marker.label}
      />
      <Notes notes={row.notes} />
    </div>
  );
}

function Line({
  glyph,
  color,
  background,
  text,
  dim,
  srLabel,
}: {
  glyph: string;
  color: string;
  background: string;
  text: string;
  dim?: boolean;
  srLabel: string;
}) {
  return (
    <div
      className="mono"
      style={{
        display: 'flex',
        gap: '0.6rem',
        background,
        padding: '0.15rem 0.4rem',
        borderRadius: '3px',
        fontSize: '0.85rem',
        color: dim ? 'var(--text-dim)' : 'var(--text)',
      }}
    >
      {/* The glyph is decorative; the status is announced in text so the diff
          never depends on colour alone. */}
      <span aria-hidden style={{ color, fontWeight: 700, width: '1ch', flexShrink: 0 }}>{glyph}</span>
      <span className="sr-only">{srLabel}: </span>
      <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="text-dim" style={{ margin: '0.15rem 0 0.35rem 2rem', padding: 0, fontSize: '0.8rem', listStyle: 'none' }}>
      {notes.map((note, i) => (
        <li key={i}>{note}</li>
      ))}
    </ul>
  );
}
