import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '@/core/merge';
import { applyOps, type SchemaOp } from '@/core/ops';
import { emptySchema, findColumn, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';

/**
 * Fixture ids are stable: t1 = users, c1 = id, c2 = email, c3 = age,
 * k1 = users_pkey, i1 = idx_email.
 */
export function base(): Schema {
  const next = counterIdGen('t');
  let s = applyOps(emptySchema(), [{ kind: 'create_table', name: 'users' }], next);
  const cols = counterIdGen('c');
  s = applyOps(s, [
    { kind: 'add_column', tableId: 't1', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: 't1', name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
    { kind: 'add_column', tableId: 't1', name: 'age', type: { kind: 'int' }, nullable: true, default: null },
  ], cols);
  const k = counterIdGen('k');
  s = applyOps(s, [
    { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: 't1', kind: 'primary_key', columnIds: ['c1'] } },
  ], k);
  const i = counterIdGen('i');
  s = applyOps(s, [
    { kind: 'add_index', index: { name: 'idx_email', tableId: 't1', columnIds: ['c2'], unique: true, method: 'btree', where: null } },
  ], i);
  return s;
}

const branch = (ops: SchemaOp[], prefix = 'n') => applyOps(base(), ops, counterIdGen(prefix));
const merge = (ours: Schema, theirs: Schema) =>
  threeWayMerge(base(), ours, theirs, [], { oursLabel: 'Ana', theirsLabel: 'Ben' });

describe('conflicts — both sides changed the same attribute differently', () => {
  it('concurrent_rename', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'email_address' }]),
    );
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({
      id: 'c2:name', class: 'concurrent_rename', attribute: 'name',
      base: 'email', ours: 'contact_email', theirs: 'email_address',
    });
  });

  it('concurrent_retype', () => {
    const r = merge(
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]),
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'varchar', length: 100 } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['concurrent_retype']);
  });

  it('concurrent_nullability', () => {
    const r = merge(
      branch([{ kind: 'set_column_nullable', columnId: 'c1', nullable: true }]),
      branch([{ kind: 'set_column_nullable', columnId: 'c1', nullable: false }]),
    );
    // ours flips it, theirs is a no-op against base -> only one side changed
    expect(r.conflicts).toHaveLength(0);
    const flipped = merge(
      branch([{ kind: 'set_column_nullable', columnId: 'c3', nullable: false }]),
      branch([{ kind: 'set_column_default', columnId: 'c3', default: '0' }]),
    );
    expect(flipped.conflicts).toHaveLength(0); // different attributes
  });

  it('concurrent_default', () => {
    const r = merge(
      branch([{ kind: 'set_column_default', columnId: 'c3', default: '0' }]),
      branch([{ kind: 'set_column_default', columnId: 'c3', default: '18' }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['concurrent_default']);
  });

  it('constraint_divergence — reachable only because alter_constraint keeps the id (D21)', () => {
    const r = merge(
      branch([{ kind: 'alter_constraint', constraintId: 'k1', patch: { columnIds: ['c2'] } }]),
      branch([{ kind: 'alter_constraint', constraintId: 'k1', patch: { columnIds: ['c3'] } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['constraint_divergence']);
  });

  it('the same edit via drop-plus-add produces NO conflict and two primary keys', () => {
    // Documents why alter_constraint had to exist. Both sides mint a fresh id,
    // so nothing pairs; validate is what catches the result.
    const r = merge(
      branch([
        { kind: 'drop_constraint', constraintId: 'k1' },
        { kind: 'add_constraint', constraint: { name: 'pk_a', tableId: 't1', kind: 'primary_key', columnIds: ['c2'] } },
      ], 'a'),
      branch([
        { kind: 'drop_constraint', constraintId: 'k1' },
        { kind: 'add_constraint', constraint: { name: 'pk_b', tableId: 't1', kind: 'primary_key', columnIds: ['c3'] } },
      ], 'b'),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(r.hazards.map((h) => h.class)).toContain('multiple_primary_keys');
  });

  it('index_divergence', () => {
    const r = merge(
      branch([{ kind: 'alter_index', indexId: 'i1', patch: { unique: false } }]),
      branch([{ kind: 'alter_index', indexId: 'i1', patch: { method: 'hash' } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['index_divergence']);
  });

  it('descriptions name both branches and both changes', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'email_address' }]),
    );
    expect(r.conflicts[0]!.description).toBe(
      'Ana: Renamed column `email` → `contact_email`. Ben: Renamed column `email` → `email_address`.',
    );
  });
});

describe('convergence — deliberately NOT conflicts', () => {
  it('both branches rename to the SAME name', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('contact_email');
  });

  it('both branches drop the same column', () => {
    const r = merge(
      branch([{ kind: 'drop_column', columnId: 'c3' }]),
      branch([{ kind: 'drop_column', columnId: 'c3' }]),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c3')).toBeUndefined();
  });

  it('ANA RENAMES while BEN RETYPES the same column — both apply', () => {
    // The case a line-oriented merge tool gets wrong: one edited "line", two
    // independent attributes (design.md §6.1).
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]),
    );
    expect(r.conflicts).toHaveLength(0);
    const col = findColumn(r.schema, 'c2')!.column;
    expect(col.name).toBe('contact_email');
    expect(col.type).toEqual({ kind: 'text' });
  });

  it('changes to entirely separate tables merge cleanly', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'years' }]),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('contact_email');
    expect(findColumn(r.schema, 'c3')!.column.name).toBe('years');
  });
});

describe('one-sided changes apply without ceremony', () => {
  it('a change on ours alone lands in the merged schema', () => {
    const r = merge(branch([{ kind: 'rename_table', tableId: 't1', name: 'accounts' }]), base());
    expect(r.schema.tables[0]!.name).toBe('accounts');
    expect(r.applied).toHaveLength(1);
  });
});
