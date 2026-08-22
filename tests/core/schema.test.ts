import { describe, it, expect } from 'vitest';
import {
  emptySchema,
  findTable,
  findColumn,
  columnsOf,
  constraintsOf,
  indexesOf,
  columnsReferencedBy,
  sameType,
  type Schema,
} from '@/core/schema';
import { counterIdGen } from '@/core/ids';

/** A small fixture: users(id, email), orders(id, user_id -> users.id). */
function fixture(): Schema {
  return {
    tables: [
      {
        id: 't_users',
        name: 'users',
        columns: [
          { id: 'c_uid', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
          { id: 'c_email', name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
          { id: 'c_age', name: 'age', type: { kind: 'int' }, nullable: true, default: null },
        ],
      },
      {
        id: 't_orders',
        name: 'orders',
        columns: [
          { id: 'c_oid', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
          { id: 'c_ouser', name: 'user_id', type: { kind: 'int' }, nullable: false, default: null },
        ],
      },
    ],
    constraints: [
      { id: 'k_upk', name: 'users_pkey', tableId: 't_users', kind: 'primary_key', columnIds: ['c_uid'] },
      {
        id: 'k_ofk', name: 'orders_user_fkey', tableId: 't_orders', kind: 'foreign_key',
        columnIds: ['c_ouser'], referencedTableId: 't_users', referencedColumnIds: ['c_uid'],
        onDelete: 'cascade', onUpdate: 'no_action',
      },
      {
        id: 'k_age', name: 'users_age_positive', tableId: 't_users', kind: 'check',
        expression: { template: '{0} > 0', columnIds: ['c_age'] },
      },
    ],
    indexes: [
      {
        id: 'i_email', name: 'idx_users_email', tableId: 't_users', columnIds: ['c_email'],
        unique: true, method: 'btree', where: { template: '{0} IS NOT NULL', columnIds: ['c_age'] },
      },
    ],
  };
}

describe('emptySchema', () => {
  it('has three empty collections', () => {
    expect(emptySchema()).toEqual({ tables: [], constraints: [], indexes: [] });
  });
});

describe('lookups', () => {
  it('findTable locates a table by id', () => {
    expect(findTable(fixture(), 't_users')?.name).toBe('users');
  });

  it('findColumn returns the column and its owning table', () => {
    const hit = findColumn(fixture(), 'c_email');
    expect(hit?.column.name).toBe('email');
    expect(hit?.table.name).toBe('users');
  });

  it('findColumn returns undefined for an unknown id', () => {
    expect(findColumn(fixture(), 'nope')).toBeUndefined();
  });

  it('columnsOf / constraintsOf / indexesOf scope to one table', () => {
    const s = fixture();
    expect(columnsOf(s, 't_orders').map((c) => c.name)).toEqual(['id', 'user_id']);
    expect(constraintsOf(s, 't_users').map((c) => c.id).sort()).toEqual(['k_age', 'k_upk']);
    expect(indexesOf(s, 't_users').map((i) => i.id)).toEqual(['i_email']);
  });
});

describe('columnsReferencedBy', () => {
  // Every later pass depends on this being exhaustive. A predicate column
  // missed here is a dangling reference nothing downstream will catch.
  const s = fixture();

  it('a foreign key references its local AND its referenced columns', () => {
    const fk = s.constraints.find((c) => c.id === 'k_ofk')!;
    expect(columnsReferencedBy(fk).sort()).toEqual(['c_ouser', 'c_uid']);
  });

  it('a primary key references its columns', () => {
    const pk = s.constraints.find((c) => c.id === 'k_upk')!;
    expect(columnsReferencedBy(pk)).toEqual(['c_uid']);
  });

  it('a CHECK references the columns named in its expression (design.md §3.4)', () => {
    const chk = s.constraints.find((c) => c.id === 'k_age')!;
    expect(columnsReferencedBy(chk)).toEqual(['c_age']);
  });

  it('an index references its columns PLUS any in a partial predicate', () => {
    const idx = s.indexes[0]!;
    expect(columnsReferencedBy(idx).sort()).toEqual(['c_age', 'c_email']);
  });
});

describe('sameType', () => {
  it('compares parameterised types by value, not identity', () => {
    expect(sameType({ kind: 'varchar', length: 255 }, { kind: 'varchar', length: 255 })).toBe(true);
    expect(sameType({ kind: 'varchar', length: 255 }, { kind: 'varchar', length: 100 })).toBe(false);
    expect(sameType({ kind: 'int' }, { kind: 'int' })).toBe(true);
    expect(sameType({ kind: 'int' }, { kind: 'bigint' })).toBe(false);
    expect(sameType({ kind: 'numeric', precision: 10, scale: 2 }, { kind: 'numeric', precision: 10, scale: 2 })).toBe(true);
    expect(sameType({ kind: 'numeric', precision: 10, scale: 2 }, { kind: 'numeric', precision: 10, scale: 4 })).toBe(false);
  });
});

describe('counterIdGen', () => {
  it('yields deterministic sequential ids so tests can assert exact schemas', () => {
    const next = counterIdGen('c');
    expect([next(), next(), next()]).toEqual(['c1', 'c2', 'c3']);
  });
});
