/**
 * The full schema annotated with what changed, rendered the way a code review
 * diff is: line-number gutters, hunk headers, and changed lines marked in
 * place against unchanged context.
 *
 * The mapping is deliberate — a table is the "file", its columns, constraints
 * and indexes are the lines, and each section is a hunk. That borrows a visual
 * grammar every engineer already reads fluently, so nothing here needs a
 * legend. Two view modes, chosen by the caller (a URL param, not local state
 * — see compare/page.tsx): unified shows a replaced row as old-line-then-new
 * -line; split shows the same row once, old on the left and new on the right.
 *
 * Line numbering and stats come from core/difftree.ts, where they are tested;
 * this file only turns them into markup. Collapsing uses <details>, so the
 * whole component stays server-rendered with no client JavaScript.
 */

import {
  toDiffLines,
  toSplitLines,
  diffStat,
  type DiffLine,
  type DiffTree,
  type RowStatus,
  type SplitCell as SplitCellData,
  type SplitLine,
  type TableDiff,
} from '@/core/difftree';

export type DiffView = 'unified' | 'split';

const TABLE_BADGE: Partial<Record<RowStatus, { label: string; pillClass: string }>> = {
  added: { label: 'table added', pillClass: 'pill-safe' },
  dropped: { label: 'table dropped', pillClass: 'pill-danger' },
  modified: { label: 'table changed', pillClass: 'pill-warning' },
};

export function SchemaDiffTree({ tree, view = 'unified' }: { tree: DiffTree; view?: DiffView }) {
  const changed = tree.tables.filter((t) => t.changeCount > 0);
  const unchanged = tree.tables.filter((t) => t.changeCount === 0);

  const totals = changed
    .map((t) => diffStat(toDiffLines(t)))
    .reduce((acc, s) => ({ added: acc.added + s.added, removed: acc.removed + s.removed }), { added: 0, removed: 0 });

  return (
    <>
      <p className="text-dim" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <span>
          {tree.totalChanges} change{tree.totalChanges === 1 ? '' : 's'} across {tree.changedTables} table
          {tree.changedTables === 1 ? '' : 's'}
          {unchanged.length > 0 && `, ${unchanged.length} unchanged`}
        </span>
        <Stat added={totals.added} removed={totals.removed} />
      </p>

      {changed.map((table) => (
        <DiffFile key={table.id} table={table} view={view} />
      ))}

      {unchanged.length > 0 && (
        <details className="diff-file">
          <summary className="diff-file-header text-dim" style={{ cursor: 'pointer' }}>
            {unchanged.length} unchanged table{unchanged.length === 1 ? '' : 's'}
          </summary>
          {unchanged.map((table) => (
            <DiffFile key={table.id} table={table} view={view} nested />
          ))}
        </details>
      )}
    </>
  );
}

function DiffFile({ table, view, nested }: { table: TableDiff; view: DiffView; nested?: boolean }) {
  const lines = toDiffLines(table);
  const { added, removed } = diffStat(lines);
  const badge = TABLE_BADGE[table.status];

  return (
    <div className="diff-file" style={nested ? { border: 'none', borderRadius: 0, marginBottom: 0 } : undefined}>
      <div className="diff-file-header">
        <span className="diff-file-name">
          {table.renamedFrom ? (
            <>
              <span className="text-dim" style={{ textDecoration: 'line-through' }}>{table.renamedFrom}</span>
              <span style={{ margin: '0 0.4rem' }}>→</span>
              {table.name}
            </>
          ) : (
            table.name
          )}
        </span>
        {badge && <span className={`pill ${badge.pillClass}`}>{badge.label}</span>}
        <Stat added={added} removed={removed} />
      </div>

      <div className="diff-body">
        {view === 'split'
          ? toSplitLines(table).map((line, i) => <SplitRow key={i} line={line} />)
          : lines.map((line, i) => <Line key={i} line={line} />)}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- unified */

function Line({ line }: { line: DiffLine }) {
  if (line.kind === 'hunk') {
    return <div className="diff-hunk">{line.text}</div>;
  }

  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  const status = line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged';

  return (
    <>
      <div className={`diff-line diff-line--${line.kind}`}>
        <span className="diff-num">{line.beforeNo ?? ''}</span>
        <span className="diff-num">{line.afterNo ?? ''}</span>
        <span className="diff-code">
          {/* The sign is decorative — the status is announced as text so the
              diff never depends on colour alone. */}
          <span className="diff-sign" aria-hidden>{sign}</span>
          <span className="sr-only">{status}: </span>
          {line.text}
        </span>
      </div>
      {line.notes.map((note, i) => (
        <div className="diff-note" key={i}>{note}</div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ split */

function SplitRow({ line }: { line: SplitLine }) {
  if (line.kind === 'hunk') {
    return <div className="diff-hunk">{line.text}</div>;
  }

  return (
    <>
      <div className="diff-split-line">
        <Side cell={line.left} tone={line.left?.changed ? 'del' : undefined} />
        <Side cell={line.right} tone={line.right?.changed ? 'add' : undefined} right />
      </div>
      {line.notes.map((note, i) => (
        <div className="diff-note diff-note--split" key={i}>{note}</div>
      ))}
    </>
  );
}

function Side({ cell, tone, right }: { cell: SplitCellData | null; tone?: 'add' | 'del'; right?: boolean }) {
  const sideClass = ['diff-split-side', right && 'diff-split-side--right', tone && `diff-split-side--${tone}`]
    .filter(Boolean)
    .join(' ');
  const sign = tone === 'add' ? '+' : tone === 'del' ? '−' : ' ';
  const status = tone === 'add' ? 'added' : tone === 'del' ? 'removed' : 'unchanged';

  return (
    <div className={sideClass}>
      <span className="diff-split-num">{cell?.no ?? ''}</span>
      <span className="diff-split-code">
        {cell && (
          <>
            <span className="diff-sign" aria-hidden>{sign}</span>
            <span className="sr-only">{status}: </span>
            {cell.text}
          </>
        )}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- shared */

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stat">
      <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </span>
  );
}
