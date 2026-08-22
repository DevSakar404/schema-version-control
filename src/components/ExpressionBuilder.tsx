'use client';

/**
 * Composes a CHECK / partial-index predicate as a structured Expression
 * (design.md §3.4), never as typed SQL.
 *
 * A free-text box here would be the one hole in the whole "never match by
 * name" rule (D22) — a raw string can name a column that nothing tracks. So
 * the only inputs are: pick a column, pick an operator, and either a literal
 * or a second column. That covers the common real cases (age > 0, start_date
 * < end_date, deleted_at IS NULL) without ever letting a name slip in as text.
 */

import { useState } from 'react';
import type { Column, Expression } from '@/core/schema';

type Operator = '>' | '>=' | '<' | '<=' | '=' | '<>' | 'IS NULL' | 'IS NOT NULL';

const UNARY_OPS: Operator[] = ['IS NULL', 'IS NOT NULL'];
const BINARY_OPS: Operator[] = ['>', '>=', '<', '<=', '=', '<>'];

export function ExpressionBuilder({
  columns,
  value,
  onChange,
}: {
  columns: Column[];
  value: Expression | null;
  onChange: (expr: Expression | null) => void;
}) {
  const parsed = parseExpression(value, columns);
  const [leftId, setLeftId] = useState(parsed?.leftId ?? columns[0]?.id ?? '');
  const [op, setOp] = useState<Operator>(parsed?.op ?? '>');
  const [mode, setMode] = useState<'literal' | 'column'>(parsed?.mode ?? 'literal');
  const [literal, setLiteral] = useState(parsed?.literal ?? '0');
  const [rightId, setRightId] = useState(parsed?.rightId ?? columns[1]?.id ?? columns[0]?.id ?? '');

  function emit(next: { leftId: string; op: Operator; mode: 'literal' | 'column'; literal: string; rightId: string }) {
    if (!next.leftId) return onChange(null);
    if (UNARY_OPS.includes(next.op)) {
      onChange({ template: `{0} ${next.op}`, columnIds: [next.leftId] });
      return;
    }
    if (next.mode === 'column') {
      if (!next.rightId) return onChange(null);
      onChange({ template: `{0} ${next.op} {1}`, columnIds: [next.leftId, next.rightId] });
    } else {
      // The literal is interpolated as a bare token, not a column reference —
      // it never carries a name, only a value, so it cannot go stale.
      onChange({ template: `{0} ${next.op} ${literalToken(next.literal)}`, columnIds: [next.leftId] });
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
      <select value={leftId} onChange={(e) => { setLeftId(e.target.value); emit({ leftId: e.target.value, op, mode, literal, rightId }); }}>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <select
        value={op}
        onChange={(e) => { const next = e.target.value as Operator; setOp(next); emit({ leftId, op: next, mode, literal, rightId }); }}
      >
        {[...BINARY_OPS, ...UNARY_OPS].map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>

      {!UNARY_OPS.includes(op) && (
        <>
          <select value={mode} onChange={(e) => { const next = e.target.value as 'literal' | 'column'; setMode(next); emit({ leftId, op, mode: next, literal, rightId }); }}>
            <option value="literal">value</option>
            <option value="column">column</option>
          </select>

          {mode === 'literal' ? (
            <input
              style={{ width: '6rem' }}
              value={literal}
              onChange={(e) => { setLiteral(e.target.value); emit({ leftId, op, mode, literal: e.target.value, rightId }); }}
              placeholder="0"
            />
          ) : (
            <select value={rightId} onChange={(e) => { setRightId(e.target.value); emit({ leftId, op, mode, literal, rightId: e.target.value }); }}>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}

/** A bare numeric token passes through; anything else is single-quoted. */
function literalToken(raw: string): string {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function parseExpression(
  expr: Expression | null,
  columns: Column[],
): { leftId: string; op: Operator; mode: 'literal' | 'column'; literal: string; rightId: string } | null {
  if (!expr) return null;
  const columnIds = new Set(columns.map((c) => c.id));
  const unary = UNARY_OPS.find((o) => expr.template === `{0} ${o}`);
  if (unary && expr.columnIds[0] && columnIds.has(expr.columnIds[0])) {
    return { leftId: expr.columnIds[0], op: unary, mode: 'literal', literal: '0', rightId: '' };
  }
  for (const o of BINARY_OPS) {
    if (expr.template === `{0} ${o} {1}` && expr.columnIds[1] && columnIds.has(expr.columnIds[1])) {
      return { leftId: expr.columnIds[0] ?? '', op: o, mode: 'column', literal: '0', rightId: expr.columnIds[1] };
    }
    const literalMatch = new RegExp(`^\\{0\\} \\${o.replace(/[<>]/g, '\\$&')} (.+)$`).exec(expr.template);
    if (literalMatch?.[1] && expr.template.startsWith(`{0} ${o} `)) {
      const lit = literalMatch[1].replace(/^'(.*)'$/, '$1');
      return { leftId: expr.columnIds[0] ?? '', op: o, mode: 'literal', literal: lit, rightId: '' };
    }
  }
  return null;
}
