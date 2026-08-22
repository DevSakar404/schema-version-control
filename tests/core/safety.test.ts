import { describe, it, expect } from 'vitest';
import { isWidening, classifyChange } from '@/core/safety';
import type { ColumnType } from '@/core/schema';

const int: ColumnType = { kind: 'int' };
const bigint: ColumnType = { kind: 'bigint' };
const smallint: ColumnType = { kind: 'smallint' };
const text: ColumnType = { kind: 'text' };
const vc = (length: number): ColumnType => ({ kind: 'varchar', length });
const num = (precision: number, scale: number): ColumnType => ({ kind: 'numeric', precision, scale });

describe('isWidening', () => {
  const widens: [string, ColumnType, ColumnType][] = [
    ['smallint -> int', smallint, int],
    ['int -> bigint', int, bigint],
    ['smallint -> bigint', smallint, bigint],
    ['int -> int (identity)', int, int],
    ['varchar(50) -> text', vc(50), text],
    ['varchar(50) -> varchar(100)', vc(50), vc(100)],
    ['varchar(50) -> varchar(50)', vc(50), vc(50)],
    ['numeric(10,2) -> numeric(12,4)', num(10, 2), num(12, 4)],
  ];
  it.each(widens)('%s widens', (_n, from, to) => expect(isWidening(from, to)).toBe(true));

  const narrows: [string, ColumnType, ColumnType][] = [
    ['bigint -> int', bigint, int],
    ['int -> smallint', int, smallint],
    ['text -> varchar(50)', text, vc(50)],
    ['varchar(100) -> varchar(50)', vc(100), vc(50)],
    ['numeric(12,4) -> numeric(10,4)', num(12, 4), num(10, 4)],
    ['numeric(12,4) -> numeric(12,2)', num(12, 4), num(12, 2)],
    ['int -> text (cross-family)', int, text],
    ['text -> int (cross-family)', text, int],
    ['int -> uuid (cross-family)', int, { kind: 'uuid' }],
    ['boolean -> int (cross-family)', { kind: 'boolean' }, int],
  ];
  it.each(narrows)('%s does NOT widen', (_n, from, to) => expect(isWidening(from, to)).toBe(false));
});

describe('classifyChange', () => {
  it('drops are destructive', () => {
    expect(classifyChange({ kind: 'table_dropped', tableId: 't', name: 'users' }).safety).toBe('destructive');
    expect(classifyChange({ kind: 'column_dropped', tableId: 't', columnId: 'c', name: 'email' }).safety).toBe('destructive');
  });

  it('renames are safe — the payoff of tracking them as renames', () => {
    expect(classifyChange({ kind: 'column_renamed', tableId: 't', columnId: 'c', from: 'a', to: 'b' }).safety).toBe('safe');
  });

  it('a nullable added column is safe', () => {
    const col = { id: 'c', name: 'x', type: int, nullable: true, default: null };
    expect(classifyChange({ kind: 'column_added', tableId: 't', columnId: 'c', column: col }).safety).toBe('safe');
  });

  it('a NOT NULL added column WITHOUT a default is lossy', () => {
    const col = { id: 'c', name: 'x', type: int, nullable: false, default: null };
    expect(classifyChange({ kind: 'column_added', tableId: 't', columnId: 'c', column: col }).safety).toBe('lossy');
  });

  it('a NOT NULL added column WITH a default is safe', () => {
    const col = { id: 'c', name: 'x', type: int, nullable: false, default: '0' };
    expect(classifyChange({ kind: 'column_added', tableId: 't', columnId: 'c', column: col }).safety).toBe('safe');
  });

  it('a widening retype is safe, a narrowing one is lossy', () => {
    expect(classifyChange({ kind: 'column_retyped', tableId: 't', columnId: 'c', from: int, to: bigint }).safety).toBe('safe');
    expect(classifyChange({ kind: 'column_retyped', tableId: 't', columnId: 'c', from: text, to: int }).safety).toBe('lossy');
  });

  it('SET NOT NULL is lossy; making a column nullable is safe', () => {
    expect(classifyChange({ kind: 'column_nullability_changed', tableId: 't', columnId: 'c', from: true, to: false }).safety).toBe('lossy');
    expect(classifyChange({ kind: 'column_nullability_changed', tableId: 't', columnId: 'c', from: false, to: true }).safety).toBe('safe');
  });

  it('index creation is blocking', () => {
    const index = { id: 'i', name: 'idx', tableId: 't', columnIds: ['c'], unique: false, method: 'btree' as const, where: null };
    expect(classifyChange({ kind: 'index_added', indexId: 'i', index }).safety).toBe('blocking');
  });

  it('every non-safe classification explains itself', () => {
    // The note renders next to the badge in the migration preview.
    const lossy = classifyChange({ kind: 'column_retyped', tableId: 't', columnId: 'c', from: text, to: int });
    expect(lossy.note).toBeTruthy();
    expect(classifyChange({ kind: 'column_renamed', tableId: 't', columnId: 'c', from: 'a', to: 'b' }).note).toBeNull();
  });
});
