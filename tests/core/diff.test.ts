import { describe, it, expect } from 'vitest';
import { diff, describeChange, tableOf, type Change } from '@/core/diff';
import { applyOp, applyOps, type SchemaOp } from '@/core/ops';
import { emptySchema, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';

/** Ids for the base fixture: x1, x2, … Tests below refer to these by name. */
const gen = () => counterIdGen('x');

/**
 * Ids for entities created *after* the base fixture. A separate prefix so a
 * newly minted id can never collide with a fixture id — a collision makes a
 * creation look like a rename, which is exactly what diff is supposed to tell
 * apart.
 */
const genNew = () => counterIdGen('n');

function base(): { s: Schema; ids: Record<string, string> } {
  const next = gen();
  let s = applyOps(emptySchema(), [
    { kind: 'create_table', name: 'users' },
  ], next);
  const users = s.tables[0]!.id;
  s = applyOps(s, [
    { kind: 'add_column', tableId: users, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: users, name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
  ], next);
  const [uid, uemail] = s.tables[0]!.columns.map((c) => c.id) as [string, string];
  s = applyOps(s, [
    { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: users, kind: 'primary_key', columnIds: [uid] } },
    { kind: 'add_index', index: { name: 'idx_email', tableId: users, columnIds: [uemail], unique: true, method: 'btree', where: null } },
  ], next);
  return { s, ids: { users, uid, uemail } };
}

function after(ops: SchemaOp[]): { changes: Change[]; ids: Record<string, string> } {
  const { s, ids } = base();
  return { changes: diff(s, applyOps(s, ops, genNew())), ids };
}

describe('the load-bearing test', () => {
  it('a rename is ONE change — never a drop plus an add', () => {
    const { s, ids } = base();
    const changes = diff(s, applyOp(s, { kind: 'rename_column', columnId: ids.uemail!, name: 'contact_email' }, genNew()));
    expect(changes).toEqual([
      { kind: 'column_renamed', tableId: ids.users, columnId: ids.uemail, from: 'email', to: 'contact_email' },
    ]);
    expect(changes.map((c) => c.kind)).not.toContain('column_dropped');
    expect(changes.map((c) => c.kind)).not.toContain('column_added');
  });
});

describe('attribute-level granularity (design.md §6.1)', () => {
  it('a column both renamed AND retyped yields TWO changes, not one', () => {
    // This sets merge granularity: two people editing different attributes of
    // one column must not conflict.
    const { changes } = after([
      { kind: 'rename_column', columnId: 'x2', name: 'contact_email' },
      { kind: 'retype_column', columnId: 'x2', type: { kind: 'text' } },
    ]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['column_renamed', 'column_retyped']);
  });

  it('diff(s, s) is empty for a non-trivial schema', () => {
    expect(diff(base().s, base().s)).toEqual([]);
  });
});

describe('rename propagation', () => {
  it('renaming a column covered by a constraint and an index reports ONLY the rename', () => {
    const { changes } = after([{ kind: 'rename_column', columnId: 'x2', name: 'contact_email' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('column_renamed');
  });
});

describe('creation and deletion', () => {
  it('dropping a table reports table_dropped without a column_dropped per column', () => {
    const { changes, ids } = after([{ kind: 'drop_table', tableId: 'x1' }]);
    expect(changes.filter((c) => c.kind === 'column_dropped')).toEqual([]);
    expect(changes.find((c) => c.kind === 'table_dropped')).toMatchObject({ tableId: ids.users, name: 'users' });
  });

  it('creating a table reports table_created plus a column_added per column', () => {
    const { s } = base();
    const next = genNew();
    let t = applyOp(s, { kind: 'create_table', name: 'orders' }, next);
    const orders = t.tables[1]!.id;
    t = applyOp(t, { kind: 'add_column', tableId: orders, name: 'id', type: { kind: 'int' }, nullable: false, default: null }, next);
    const kinds = diff(s, t).map((c) => c.kind);
    expect(kinds).toContain('table_created');
    expect(kinds).toContain('column_added');
  });

  it('reports table_renamed', () => {
    const { changes } = after([{ kind: 'rename_table', tableId: 'x1', name: 'accounts' }]);
    expect(changes).toMatchObject([{ kind: 'table_renamed', from: 'users', to: 'accounts' }]);
  });

  it('reports nullability and default changes separately', () => {
    const { changes } = after([
      { kind: 'set_column_nullable', columnId: 'x2', nullable: true },
      { kind: 'set_column_default', columnId: 'x2', default: "''" },
    ]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['column_default_changed', 'column_nullability_changed']);
  });
});

describe('constraints and indexes', () => {
  it('altering a primary key yields constraint_changed, not a drop plus an add', () => {
    // Reachable only because alter_constraint preserves the id (D21).
    const { changes } = after([{ kind: 'alter_constraint', constraintId: 'x4', patch: { columnIds: ['x3'] } }]);
    expect(changes.map((c) => c.kind)).toEqual(['constraint_changed']);
  });

  it('altering an index yields index_changed', () => {
    const { changes } = after([{ kind: 'alter_index', indexId: 'x5', patch: { unique: false } }]);
    expect(changes.map((c) => c.kind)).toEqual(['index_changed']);
  });

  it('drop-plus-add of a constraint yields a drop AND an add', () => {
    const { changes } = after([
      { kind: 'drop_constraint', constraintId: 'x4' },
      { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: 'x1', kind: 'primary_key', columnIds: ['x3'] } },
    ]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['constraint_added', 'constraint_dropped']);
  });
});

describe('describeChange', () => {
  it('renders a rename in words, showing both names', () => {
    const { changes } = after([{ kind: 'rename_column', columnId: 'x2', name: 'contact_email' }]);
    const text = describeChange(changes[0]!);
    expect(text).toContain('email');
    expect(text).toContain('contact_email');
  });
});

describe('tableOf — resolving a change back to its table', () => {
  it('table_* changes resolve to the table itself', () => {
    const { s } = base();
    const { changes, ids } = after([{ kind: 'rename_table', tableId: 'x1', name: 'accounts' }]);
    const head = { ...s, tables: [{ ...s.tables[0]!, name: 'accounts' }] };
    expect(tableOf(changes[0]!, s, head)).toEqual({ id: ids.users, name: 'accounts' });
  });

  it('column_* changes resolve via the tableId they carry', () => {
    const { s } = base();
    const { changes } = after([{ kind: 'rename_column', columnId: 'x2', name: 'contact_email' }]);
    expect(tableOf(changes[0]!, s, s)?.name).toBe('users');
  });

  it('constraint_added resolves via the constraint object it carries', () => {
    const { s, ids } = base();
    const head = applyOp(s, { kind: 'add_constraint', constraint: { name: 'x', tableId: ids.users!, kind: 'unique', columnIds: [ids.uemail!] } }, gen());
    const change = diff(s, head)[0]!;
    expect(tableOf(change, s, head)?.name).toBe('users');
  });

  it('constraint_dropped resolves via the BASE schema, since the constraint is gone from head', () => {
    const { s } = base();
    const head = applyOp(s, { kind: 'drop_constraint', constraintId: 'x4' }, gen());
    const change = diff(s, head)[0]!;
    expect(change.kind).toBe('constraint_dropped');
    expect(tableOf(change, s, head)?.name).toBe('users');
  });

  it('index_dropped resolves via the BASE schema', () => {
    const { s } = base();
    const head = applyOp(s, { kind: 'drop_index', indexId: 'x5' }, gen());
    const change = diff(s, head)[0]!;
    expect(change.kind).toBe('index_dropped');
    expect(tableOf(change, s, head)?.name).toBe('users');
  });

  it('constraint_changed resolves via `to`, without needing either schema', () => {
    const { s } = base();
    const head = applyOp(s, { kind: 'alter_constraint', constraintId: 'x4', patch: { columnIds: ['x3'] } }, gen());
    const change = diff(s, head)[0]!;
    expect(change.kind).toBe('constraint_changed');
    expect(tableOf(change, emptySchema(), emptySchema())?.id).toBe('x1');
  });
});

describe('describeChange — schema-aware column naming', () => {
  // column_retyped, column_nullability_changed, and column_default_changed
  // carry only a columnId, no name. Without a schema the id is all there is
  // to print — technically correct, practically useless on a screen. This
  // pins the fallback AND the resolved form so neither regresses silently.
  // Fixture: x2 = users.id (int), x3 = users.email (varchar(255)).
  it('falls back to the raw id when no schema is given', () => {
    const { changes } = after([{ kind: 'retype_column', columnId: 'x3', type: { kind: 'text' } }]);
    expect(describeChange(changes[0]!)).toBe('Changed type of `x3` from varchar(255) to text');
  });

  it('resolves the CURRENT column name when a schema is given', () => {
    const { s } = base();
    const { changes } = after([{ kind: 'retype_column', columnId: 'x3', type: { kind: 'text' } }]);
    expect(describeChange(changes[0]!, s)).toBe('Changed type of `email` from varchar(255) to text');
  });

  it('nullability and default changes also name the column, not just the direction', () => {
    const { s } = base();
    const nullable = after([{ kind: 'set_column_nullable', columnId: 'x2', nullable: true }]);
    expect(describeChange(nullable.changes[0]!, s)).toBe('Made `id` nullable');

    const dflt = after([{ kind: 'set_column_default', columnId: 'x2', default: '0' }]);
    expect(describeChange(dflt.changes[0]!, s)).toBe('Set default of `id` to `0`');
  });
});
