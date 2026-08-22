import { describe, it, expect } from 'vitest';
import { closureOf } from '@/core/closure';
import { base } from './fixture';

describe('closureOf', () => {
  const s = base(); // users(c1 id, c2 email, c3 age), k1 pkey(c1), i1 idx_email(c2)

  it('a table contains its columns, constraints and indexes', () => {
    expect([...closureOf(s, 't1')].sort()).toEqual(['c1', 'c2', 'c3', 'i1', 'k1', 't1']);
  });

  it('a column contains the constraints and indexes covering it', () => {
    expect([...closureOf(s, 'c1')].sort()).toEqual(['c1', 'k1']);
    expect([...closureOf(s, 'c2')].sort()).toEqual(['c2', 'i1']);
  });

  it('a column nobody references closes over just itself', () => {
    expect([...closureOf(s, 'c3')]).toEqual(['c3']);
  });

  it('reaches through a CHECK predicate and a partial index (design.md §3.4)', () => {
    const withPredicates = {
      ...s,
      constraints: [
        ...s.constraints,
        { id: 'k9', name: 'age_ok', tableId: 't1', kind: 'check' as const, expression: { template: '{0} > 0', columnIds: ['c3'] } },
      ],
      indexes: [
        ...s.indexes,
        { id: 'i9', name: 'idx_partial', tableId: 't1', columnIds: ['c1'], unique: false, method: 'btree' as const, where: { template: '{0} IS NOT NULL', columnIds: ['c3'] } },
      ],
    };
    expect([...closureOf(withPredicates, 'c3')].sort()).toEqual(['c3', 'i9', 'k9']);
  });

  it('a foreign key pointing AT a table is in that table\'s closure', () => {
    const withFk = {
      ...s,
      tables: [...s.tables, { id: 't2', name: 'orders', columns: [{ id: 'c9', name: 'user_id', type: { kind: 'int' as const }, nullable: false, default: null }] }],
      constraints: [
        ...s.constraints,
        {
          id: 'k8', name: 'orders_user_fkey', tableId: 't2', kind: 'foreign_key' as const,
          columnIds: ['c9'], referencedTableId: 't1', referencedColumnIds: ['c1'],
          onDelete: 'cascade' as const, onUpdate: 'no_action' as const,
        },
      ],
    };
    expect([...closureOf(withFk, 't1')]).toContain('k8');
  });

  it('an unknown id closes over just itself', () => {
    expect([...closureOf(s, 'nope')]).toEqual(['nope']);
  });
});
