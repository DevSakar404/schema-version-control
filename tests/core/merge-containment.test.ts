import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '@/core/merge';
import { applyOps, type SchemaOp } from '@/core/ops';
import { findColumn, findTable, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

const branch = (ops: SchemaOp[], prefix = 'n') => applyOps(base(), ops, counterIdGen(prefix));
const merge = (ours: Schema, theirs: Schema, resolutions = []) =>
  threeWayMerge(base(), ours, theirs, resolutions, { oursLabel: 'Ana', theirsLabel: 'Ben' });

describe('the headline case (D19)', () => {
  it('Ana drops the users table; Ben adds a column to it', () => {
    // Before containment detection this merged CLEAN and then applied a column
    // to a table that no longer existed. Assert on the conflict count, not
    // merely that nothing threw.
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }]),
      branch([{ kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null }]),
    );
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ class: 'delete_modify', entity: { displayName: 'users' } });
  });

  it('the description warns what dropping would discard', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }]),
      branch([{ kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null }]),
    );
    expect(r.conflicts[0]!.description).toContain("discards Ben's change");
  });

  it('unresolved, the merge keeps the table rather than destroying it', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }]),
      branch([{ kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null }]),
    );
    expect(findTable(r.schema, 't1')).toBeDefined();
  });
});

describe('sibling shapes, each reachable by a real user', () => {
  it('drop a table vs rename one of its columns', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }]),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });

  it('drop a table vs add an index on it', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }]),
      branch([{ kind: 'add_index', index: { name: 'idx_age', tableId: 't1', columnIds: ['c3'], unique: false, method: 'btree', where: null } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });

  it('drop a column vs add a constraint covering it', () => {
    const r = merge(
      branch([{ kind: 'drop_column', columnId: 'c3' }]),
      branch([{ kind: 'add_constraint', constraint: { name: 'age_uq', tableId: 't1', kind: 'unique', columnIds: ['c3'] } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });

  it('drop a column vs retype it', () => {
    const r = merge(
      branch([{ kind: 'drop_column', columnId: 'c2' }]),
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]),
    );
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });

  it('drop a table vs add a foreign key from elsewhere referencing it', () => {
    const withOrders = (extra: SchemaOp[]) => {
      const next = counterIdGen('o');
      let s = applyOps(base(), [{ kind: 'create_table', name: 'orders' }], next);
      s = applyOps(s, [{ kind: 'add_column', tableId: 'o1', name: 'user_id', type: { kind: 'int' }, nullable: false, default: null }], next);
      return applyOps(s, extra, counterIdGen('q'));
    };
    const start = withOrders([]);
    const ours = applyOps(start, [{ kind: 'drop_table', tableId: 't1' }], counterIdGen('a'));
    const theirs = applyOps(start, [{
      kind: 'add_constraint',
      constraint: {
        name: 'orders_user_fkey', tableId: 'o1', kind: 'foreign_key',
        columnIds: ['o2'], referencedTableId: 't1', referencedColumnIds: ['c1'],
        onDelete: 'cascade', onUpdate: 'no_action',
      },
    }], counterIdGen('b'));
    const r = threeWayMerge(start, ours, theirs, [], { oursLabel: 'Ana', theirsLabel: 'Ben' });
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });
});

describe('guards against over-eager closure logic', () => {
  it('both branches drop the same table — convergent, NOT a conflict', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }], 'a'),
      branch([{ kind: 'drop_table', tableId: 't1' }], 'b'),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(r.schema.tables).toHaveLength(0);
  });

  it('drop a table vs drop one of its columns — both deletions, no conflict', () => {
    const r = merge(
      branch([{ kind: 'drop_table', tableId: 't1' }], 'a'),
      branch([{ kind: 'drop_column', columnId: 'c3' }], 'b'),
    );
    expect(r.conflicts).toHaveLength(0);
  });

  it('drop a column vs change an UNRELATED column — no conflict', () => {
    const r = merge(
      branch([{ kind: 'drop_column', columnId: 'c3' }]),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c3')).toBeUndefined();
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('contact_email');
  });
});

describe('symmetry', () => {
  it('the same conflict is reported whichever side holds the deletion', () => {
    const dropper = branch([{ kind: 'drop_table', tableId: 't1' }], 'a');
    const adder = branch([{ kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null }], 'b');
    const forward = merge(dropper, adder);
    const reverse = merge(adder, dropper);
    expect(forward.conflicts).toHaveLength(1);
    expect(reverse.conflicts).toHaveLength(1);
    expect(forward.conflicts[0]!.id).toBe(reverse.conflicts[0]!.id);
    expect(reverse.conflicts[0]!.ours).toBe('kept');
    expect(reverse.conflicts[0]!.theirs).toBe('dropped');
  });
});

describe('resolution', () => {
  const dropper = branch([{ kind: 'drop_table', tableId: 't1' }], 'a');
  const adder = branch([{ kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null }], 'b');

  it('choosing "ours" drops the table and discards the addition', () => {
    const r = threeWayMerge(base(), dropper, adder, [{ conflictId: 't1:__exists', choice: 'ours' }]);
    expect(r.conflicts).toHaveLength(0);
    expect(findTable(r.schema, 't1')).toBeUndefined();
  });

  it('choosing "theirs" keeps the table with the new column', () => {
    const r = threeWayMerge(base(), dropper, adder, [{ conflictId: 't1:__exists', choice: 'theirs' }]);
    expect(r.conflicts).toHaveLength(0);
    expect(findTable(r.schema, 't1')!.columns.map((c) => c.name)).toContain('nickname');
  });
});
