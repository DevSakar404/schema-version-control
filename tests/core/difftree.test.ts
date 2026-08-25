import { describe, it, expect } from 'vitest';
import { buildDiffTree } from '@/core/difftree';
import { applyOps, type SchemaOp } from '@/core/ops';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

const branch = (ops: SchemaOp[], prefix = 'n') => applyOps(base(), ops, counterIdGen(prefix));
const tree = (ops: SchemaOp[]) => buildDiffTree(base(), branch(ops));
const users = (t: ReturnType<typeof tree>) => t.tables.find((x) => x.name === 'users' || x.id === 't1')!;

describe('context — the whole point of the tree', () => {
  it('includes UNCHANGED columns alongside the changed one', () => {
    // A flat change list says "renamed email". The tree has to also show id
    // and age sitting either side of it, untouched, or a reader has no idea
    // what the table looks like.
    const t = users(tree([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]));
    expect(t.columns.map((c) => [c.after?.name, c.status])).toEqual([
      ['id', 'unchanged'],
      ['contact_email', 'modified'],
      ['age', 'unchanged'],
    ]);
  });

  it('includes unchanged constraints and indexes too', () => {
    const t = users(tree([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]));
    expect(t.constraints.map((c) => c.status)).toEqual(['unchanged']);
    expect(t.indexes.map((i) => i.status)).toEqual(['unchanged']);
  });

  it('a table with no changes at all is still present, so it can be shown as context', () => {
    const t = buildDiffTree(base(), base());
    expect(t.tables).toHaveLength(1);
    expect(t.tables[0]!.changeCount).toBe(0);
    expect(t.unchangedTables).toBe(1);
    expect(t.totalChanges).toBe(0);
  });
});

describe('row status', () => {
  it('a renamed column is modified and remembers its old name', () => {
    const t = users(tree([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]));
    const row = t.columns.find((c) => c.id === 'c2')!;
    expect(row.status).toBe('modified');
    expect(row.renamedFrom).toBe('email');
    expect(row.before?.name).toBe('email');
    expect(row.after?.name).toBe('contact_email');
  });

  it('a retyped column is modified but NOT renamed', () => {
    const row = users(tree([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]))
      .columns.find((c) => c.id === 'c2')!;
    expect(row.status).toBe('modified');
    expect(row.renamedFrom).toBeNull();
    expect(row.notes.join(' ')).toContain('text');
  });

  it('an added column has no before, a dropped column has no after', () => {
    const added = users(tree([
      { kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null },
    ])).columns.find((c) => c.after?.name === 'nickname')!;
    expect(added.status).toBe('added');
    expect(added.before).toBeNull();

    const dropped = users(tree([{ kind: 'drop_column', columnId: 'c3' }]))
      .columns.find((c) => c.id === 'c3')!;
    expect(dropped.status).toBe('dropped');
    expect(dropped.after).toBeNull();
    expect(dropped.before?.name).toBe('age');
  });
});

describe('a dropped table still shows what was inside it', () => {
  // This is the case from the screenshot that prompted the feature: a flat
  // list read "dropped table, dropped constraint, dropped constraint,
  // dropped index" with no indication they were all the same table.
  const t = users(tree([{ kind: 'drop_table', tableId: 't1' }]));

  it('marks the table dropped and keeps its old name', () => {
    expect(t.status).toBe('dropped');
    expect(t.name).toBe('users');
  });

  it('lists every column it contained, each dropped', () => {
    expect(t.columns.map((c) => [c.before?.name, c.status])).toEqual([
      ['id', 'dropped'],
      ['email', 'dropped'],
      ['age', 'dropped'],
    ]);
  });

  it('lists its constraints and indexes as dropped, under the table they belonged to', () => {
    expect(t.constraints.map((c) => [c.before?.name, c.status])).toEqual([['users_pkey', 'dropped']]);
    expect(t.indexes.map((i) => [i.before?.name, i.status])).toEqual([['idx_email', 'dropped']]);
  });
});

describe('a created table', () => {
  it('is added, with all of its columns added', () => {
    const next = counterIdGen('z');
    let head = applyOps(base(), [{ kind: 'create_table', name: 'orders' }], next);
    const ordersId = head.tables[1]!.id;
    head = applyOps(head, [
      { kind: 'add_column', tableId: ordersId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    ], next);

    const orders = buildDiffTree(base(), head).tables.find((x) => x.name === 'orders')!;
    expect(orders.status).toBe('added');
    expect(orders.columns.map((c) => c.status)).toEqual(['added']);
  });
});

describe('counts', () => {
  it('changeCount rolls up everything inside the table, not just the table row', () => {
    const t = users(tree([
      { kind: 'rename_column', columnId: 'c2', name: 'contact_email' },
      { kind: 'retype_column', columnId: 'c3', type: { kind: 'bigint' } },
    ]));
    expect(t.changeCount).toBe(2);
  });

  it('separates changed from unchanged tables', () => {
    const next = counterIdGen('z');
    const head = applyOps(base(), [{ kind: 'create_table', name: 'untouched_later' }], next);
    const t = buildDiffTree(base(), head);
    expect(t.changedTables).toBe(1);   // the new table
    expect(t.unchangedTables).toBe(1); // users
  });
});

describe('ordering', () => {
  it('keeps the base schema order so unchanged rows stay where the reader last saw them', () => {
    const t = users(tree([
      { kind: 'add_column', tableId: 't1', name: 'zzz_new', type: { kind: 'text' }, nullable: true, default: null },
    ]));
    expect(t.columns.map((c) => c.after?.name)).toEqual(['id', 'email', 'age', 'zzz_new']);
  });
});

describe('labels — the before/after lines that make it read like a code diff', () => {
  it('a modified column carries BOTH the old line and the new one', () => {
    const row = users(tree([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]))
      .columns.find((c) => c.id === 'c2')!;
    expect(row.beforeLabel).toBe('email varchar(255) NOT NULL');
    expect(row.afterLabel).toBe('email text NOT NULL');
  });

  it('an added row has no before line; a dropped row has no after line', () => {
    const added = users(tree([
      { kind: 'add_column', tableId: 't1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null },
    ])).columns.find((c) => c.after?.name === 'nickname')!;
    expect(added.beforeLabel).toBeNull();
    expect(added.afterLabel).toBe('nickname text');

    const dropped = users(tree([{ kind: 'drop_column', columnId: 'c3' }]))
      .columns.find((c) => c.id === 'c3')!;
    expect(dropped.beforeLabel).toBe('age int');
    expect(dropped.afterLabel).toBeNull();
  });

  it('resolves column names inside a constraint, not raw ids', () => {
    const row = users(buildDiffTree(base(), base())).constraints[0]!;
    expect(row.afterLabel).toBe('CONSTRAINT users_pkey PRIMARY KEY (id)');
  });

  it('resolves an index, including uniqueness', () => {
    const row = users(buildDiffTree(base(), base())).indexes[0]!;
    expect(row.afterLabel).toBe('UNIQUE INDEX idx_email (email)');
  });

  it('a renamed column propagates into the constraint label, using each side\'s own names', () => {
    // The constraint itself never changed — it references the column by id.
    // Its rendering still has to differ across the two sides, because the
    // column it points at has a different name on each. This is the whole
    // reason labels are built per-side rather than once.
    const t = users(tree([{ kind: 'rename_column', columnId: 'c1', name: 'user_id' }]));
    const pkey = t.constraints[0]!;
    expect(pkey.status).toBe('unchanged');
    expect(pkey.beforeLabel).toBe('CONSTRAINT users_pkey PRIMARY KEY (id)');
    expect(pkey.afterLabel).toBe('CONSTRAINT users_pkey PRIMARY KEY (user_id)');
  });
});
