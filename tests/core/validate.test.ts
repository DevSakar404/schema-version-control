import { describe, it, expect } from 'vitest';
import { validate, type HazardClass } from '@/core/validate';
import type { Schema } from '@/core/schema';

/** A schema that must validate completely clean. Everything below breaks a copy. */
function healthy(): Schema {
  return {
    tables: [
      {
        id: 't_users', name: 'users',
        columns: [
          { id: 'c_uid', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
          { id: 'c_email', name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
          { id: 'c_age', name: 'age', type: { kind: 'int' }, nullable: true, default: '0' },
        ],
      },
      {
        id: 't_orders', name: 'orders',
        columns: [
          { id: 'c_oid', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
          { id: 'c_ouser', name: 'user_id', type: { kind: 'int' }, nullable: false, default: null },
        ],
      },
    ],
    constraints: [
      { id: 'k_upk', name: 'users_pkey', tableId: 't_users', kind: 'primary_key', columnIds: ['c_uid'] },
      { id: 'k_opk', name: 'orders_pkey', tableId: 't_orders', kind: 'primary_key', columnIds: ['c_oid'] },
      { id: 'k_chk', name: 'age_positive', tableId: 't_users', kind: 'check', expression: { template: '{0} > 0', columnIds: ['c_age'] } },
      {
        id: 'k_fk', name: 'orders_user_fkey', tableId: 't_orders', kind: 'foreign_key',
        columnIds: ['c_ouser'], referencedTableId: 't_users', referencedColumnIds: ['c_uid'],
        onDelete: 'cascade', onUpdate: 'no_action',
      },
    ],
    indexes: [
      { id: 'i_email', name: 'idx_users_email', tableId: 't_users', columnIds: ['c_email'], unique: false, method: 'btree', where: null },
    ],
  };
}

function classesOf(s: Schema): HazardClass[] {
  return validate(s).map((h) => h.class).sort();
}

describe('the negative case, which matters most', () => {
  it('a healthy multi-table schema with FKs, indexes and a CHECK returns no hazards', () => {
    // A validator that fires on healthy input is worse than none.
    expect(validate(healthy())).toEqual([]);
  });
});

describe('dangling references', () => {
  it('dangling_foreign_key when the referenced table is gone', () => {
    const s = healthy();
    s.tables = s.tables.filter((t) => t.id !== 't_users');
    expect(classesOf(s)).toContain('dangling_foreign_key');
  });

  it('constraint_on_missing_column when a CHECK names a removed column (design.md §3.4)', () => {
    const s = healthy();
    s.tables[0]!.columns = s.tables[0]!.columns.filter((c) => c.id !== 'c_age');
    expect(classesOf(s)).toContain('constraint_on_missing_column');
  });

  it('index_on_missing_column when an index covers a removed column', () => {
    const s = healthy();
    s.tables[0]!.columns = s.tables[0]!.columns.filter((c) => c.id !== 'c_email');
    expect(classesOf(s)).toContain('index_on_missing_column');
  });

  it('index_on_missing_column when a PARTIAL PREDICATE names a removed column', () => {
    const s = healthy();
    s.indexes[0]!.where = { template: '{0} IS NOT NULL', columnIds: ['c_gone'] };
    expect(classesOf(s)).toContain('index_on_missing_column');
  });
});

describe('duplicate names', () => {
  it('duplicate_name for two tables', () => {
    const s = healthy();
    s.tables[1]!.name = 'users';
    expect(classesOf(s)).toContain('duplicate_name');
  });

  it('duplicate_name for two columns in one table', () => {
    const s = healthy();
    s.tables[0]!.columns[1]!.name = 'id';
    expect(classesOf(s)).toContain('duplicate_name');
  });

  it('the same column name in DIFFERENT tables is fine', () => {
    expect(validate(healthy())).toEqual([]); // both tables already have an "id"
  });

  it('duplicate_constraint_name — Postgres namespaces these per schema, not per table', () => {
    const s = healthy();
    s.constraints[1]!.name = 'users_pkey';
    expect(classesOf(s)).toContain('duplicate_constraint_name');
  });

  it('duplicate_index_name', () => {
    const s = healthy();
    s.indexes.push({ ...s.indexes[0]!, id: 'i_dup', columnIds: ['c_age'] });
    expect(classesOf(s)).toContain('duplicate_index_name');
  });
});

describe('what Postgres would reject (D23)', () => {
  it('multiple_primary_keys', () => {
    const s = healthy();
    s.constraints.push({ id: 'k_pk2', name: 'users_pkey2', tableId: 't_users', kind: 'primary_key', columnIds: ['c_email'] });
    expect(classesOf(s)).toContain('multiple_primary_keys');
  });

  it('primary_key_nullable', () => {
    const s = healthy();
    s.tables[0]!.columns[0]!.nullable = true;
    expect(classesOf(s)).toContain('primary_key_nullable');
  });

  it('default_type_mismatch — a string literal on an int column', () => {
    const s = healthy();
    s.tables[0]!.columns[2]!.default = "'hello'";
    expect(classesOf(s)).toContain('default_type_mismatch');
  });

  it('default_type_mismatch — a non-boolean default on a boolean column', () => {
    const s = healthy();
    s.tables[0]!.columns.push({ id: 'c_flag', name: 'flag', type: { kind: 'boolean' }, nullable: true, default: '7' });
    expect(classesOf(s)).toContain('default_type_mismatch');
  });

  it('function-call defaults are NOT flagged', () => {
    const s = healthy();
    s.tables[0]!.columns.push({ id: 'c_at', name: 'created_at', type: { kind: 'timestamptz' }, nullable: false, default: 'now()' });
    s.tables[0]!.columns.push({ id: 'c_n', name: 'n', type: { kind: 'bigint' }, nullable: false, default: "nextval('s')" });
    expect(validate(s)).toEqual([]);
  });

  it('foreign_key_target_not_unique — Postgres rejects an FK onto a non-unique column', () => {
    const s = healthy();
    s.constraints = s.constraints.filter((c) => c.id !== 'k_upk'); // users.id no longer unique
    expect(classesOf(s)).toContain('foreign_key_target_not_unique');
  });

  it('foreign_key_type_mismatch', () => {
    const s = healthy();
    s.tables[1]!.columns[1]!.type = { kind: 'uuid' }; // orders.user_id : uuid -> users.id : int
    expect(classesOf(s)).toContain('foreign_key_type_mismatch');
  });

  it('foreign_key_arity_mismatch', () => {
    const s = healthy();
    const fk = s.constraints.find((c) => c.id === 'k_fk')!;
    if (fk.kind === 'foreign_key') fk.referencedColumnIds = ['c_uid', 'c_email'];
    expect(classesOf(s)).toContain('foreign_key_arity_mismatch');
  });
});

describe('warnings', () => {
  it('empty_table', () => {
    const s = healthy();
    s.tables.push({ id: 't_empty', name: 'empty', columns: [] });
    const hazards = validate(s);
    expect(hazards.map((h) => h.class)).toContain('empty_table');
    expect(hazards.find((h) => h.class === 'empty_table')!.severity).toBe('warning');
  });

  it('no_primary_key is a warning, not an error', () => {
    const s = healthy();
    s.constraints = s.constraints.filter((c) => c.id !== 'k_opk');
    const pk = validate(s).find((h) => h.class === 'no_primary_key');
    expect(pk?.severity).toBe('warning');
  });
});

describe('descriptions render directly in the UI', () => {
  it('names the specific entities involved', () => {
    const s = healthy();
    s.tables[0]!.columns = s.tables[0]!.columns.filter((c) => c.id !== 'c_email');
    const h = validate(s).find((x) => x.class === 'index_on_missing_column')!;
    expect(h.description).toContain('idx_users_email');
  });

  it('carries no author or provenance — validate sees only a final state (D24)', () => {
    const s = healthy();
    s.tables[0]!.columns[0]!.nullable = true;
    expect(validate(s)[0]).not.toHaveProperty('causedBy');
  });
});
