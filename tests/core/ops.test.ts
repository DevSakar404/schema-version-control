import { describe, it, expect } from 'vitest';
import { applyOp, applyOps, type SchemaOp } from '@/core/ops';
import { emptySchema, findColumn, findTable, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';

/** Build users(id, email, age) + orders(id, user_id -> users.id) via ops. */
function build(): { schema: Schema; ids: Record<string, string> } {
  const next = counterIdGen('x');
  let s = emptySchema();
  s = applyOp(s, { kind: 'create_table', name: 'users' }, next);
  const users = s.tables[0]!.id;
  s = applyOp(s, { kind: 'add_column', tableId: users, name: 'id', type: { kind: 'int' }, nullable: false, default: null }, next);
  s = applyOp(s, { kind: 'add_column', tableId: users, name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null }, next);
  s = applyOp(s, { kind: 'add_column', tableId: users, name: 'age', type: { kind: 'int' }, nullable: true, default: null }, next);
  const [uid, uemail, uage] = s.tables[0]!.columns.map((c) => c.id) as [string, string, string];

  s = applyOp(s, { kind: 'create_table', name: 'orders' }, next);
  const orders = s.tables[1]!.id;
  s = applyOp(s, { kind: 'add_column', tableId: orders, name: 'id', type: { kind: 'int' }, nullable: false, default: null }, next);
  s = applyOp(s, { kind: 'add_column', tableId: orders, name: 'user_id', type: { kind: 'int' }, nullable: false, default: null }, next);
  const ouser = s.tables[1]!.columns[1]!.id;

  s = applyOp(s, { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: users, kind: 'primary_key', columnIds: [uid] } }, next);
  s = applyOp(s, { kind: 'add_constraint', constraint: { name: 'users_email_age_uq', tableId: users, kind: 'unique', columnIds: [uemail, uage] } }, next);
  s = applyOp(s, { kind: 'add_constraint', constraint: { name: 'age_positive', tableId: users, kind: 'check', expression: { template: '{0} > 0', columnIds: [uage] } } }, next);
  s = applyOp(s, { kind: 'add_constraint', constraint: { name: 'orders_user_fkey', tableId: orders, kind: 'foreign_key', columnIds: [ouser], referencedTableId: users, referencedColumnIds: [uid], onDelete: 'cascade', onUpdate: 'no_action' } }, next);
  s = applyOp(s, { kind: 'add_index', index: { name: 'idx_users_email', tableId: users, columnIds: [uemail], unique: true, method: 'btree', where: null } }, next);
  s = applyOp(s, { kind: 'add_index', index: { name: 'idx_users_partial', tableId: users, columnIds: [uemail], unique: false, method: 'btree', where: { template: '{0} IS NOT NULL', columnIds: [uage] } } }, next);

  return { schema: s, ids: { users, orders, uid, uemail, uage, ouser } };
}

describe('purity', () => {
  it('applyOp never mutates its input', () => {
    const { schema, ids } = build();
    const before = structuredClone(schema);
    applyOp(schema, { kind: 'rename_table', tableId: ids.users!, name: 'accounts' }, counterIdGen('z'));
    expect(schema).toEqual(before);
  });

  it('applyOps threads a sequence and returns the final schema', () => {
    const next = counterIdGen('y');
    const ops: SchemaOp[] = [
      { kind: 'create_table', name: 'a' },
      { kind: 'create_table', name: 'b' },
    ];
    expect(applyOps(emptySchema(), ops, next).tables.map((t) => t.name)).toEqual(['a', 'b']);
  });
});

describe('identity — the property the whole project rests on', () => {
  it('rename_column changes only the name, never the id', () => {
    const { schema, ids } = build();
    const before = findColumn(schema, ids.uemail!)!.column;
    const after = findColumn(
      applyOp(schema, { kind: 'rename_column', columnId: ids.uemail!, name: 'contact_email' }, counterIdGen('z')),
      ids.uemail!,
    )!.column;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('contact_email');
    expect(before.name).toBe('email');
  });

  it('rename_table changes only the name, never the id', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'rename_table', tableId: ids.users!, name: 'accounts' }, counterIdGen('z'));
    expect(findTable(after, ids.users!)!.name).toBe('accounts');
  });

  it('a rename leaves every constraint and index untouched — they reference by id', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'rename_column', columnId: ids.uemail!, name: 'contact_email' }, counterIdGen('z'));
    expect(after.constraints).toEqual(schema.constraints);
    expect(after.indexes).toEqual(schema.indexes);
  });
});

describe('column operations', () => {
  it('retype, nullability and default each change one attribute', () => {
    const { schema, ids } = build();
    const next = counterIdGen('z');
    let s = applyOp(schema, { kind: 'retype_column', columnId: ids.uemail!, type: { kind: 'text' } }, next);
    s = applyOp(s, { kind: 'set_column_nullable', columnId: ids.uemail!, nullable: true }, next);
    s = applyOp(s, { kind: 'set_column_default', columnId: ids.uemail!, default: "''" }, next);
    const c = findColumn(s, ids.uemail!)!.column;
    expect(c).toEqual({ id: ids.uemail, name: 'email', type: { kind: 'text' }, nullable: true, default: "''" });
  });
});

describe('deletion cascade — the only cascade logic in the codebase', () => {
  it('drop_table removes its columns, constraints, indexes AND inbound foreign keys', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'drop_table', tableId: ids.users! }, counterIdGen('z'));
    expect(after.tables.map((t) => t.name)).toEqual(['orders']);
    // users_pkey, users_email_age_uq, age_positive all belonged to users;
    // orders_user_fkey pointed AT users from another table and must go too.
    expect(after.constraints).toEqual([]);
    expect(after.indexes).toEqual([]);
  });

  it('drop_column prunes a multi-column constraint that still covers others', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'drop_column', columnId: ids.uage! }, counterIdGen('z'));
    const uq = after.constraints.find((c) => c.name === 'users_email_age_uq');
    expect(uq && 'columnIds' in uq ? uq.columnIds : null).toEqual([ids.uemail]);
  });

  it('drop_column removes a CHECK whose Expression names it (design.md §3.4)', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'drop_column', columnId: ids.uage! }, counterIdGen('z'));
    expect(after.constraints.find((c) => c.name === 'age_positive')).toBeUndefined();
  });

  it('drop_column removes an index whose partial predicate names it', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'drop_column', columnId: ids.uage! }, counterIdGen('z'));
    expect(after.indexes.map((i) => i.name)).toEqual(['idx_users_email']);
  });

  it('drop_column removes a constraint left covering nothing', () => {
    const { schema, ids } = build();
    const after = applyOp(schema, { kind: 'drop_column', columnId: ids.uid! }, counterIdGen('z'));
    expect(after.constraints.find((c) => c.name === 'users_pkey')).toBeUndefined();
    // the FK referenced users.id — arity must match, so it cannot be pruned
    expect(after.constraints.find((c) => c.name === 'orders_user_fkey')).toBeUndefined();
  });
});

describe('alter_constraint / alter_index (design.md §4.1)', () => {
  it('altering a primary key PRESERVES the constraint id', () => {
    const { schema, ids } = build();
    const pk = schema.constraints.find((c) => c.name === 'users_pkey')!;
    const after = applyOp(schema, { kind: 'alter_constraint', constraintId: pk.id, patch: { columnIds: [ids.uemail!] } }, counterIdGen('z'));
    const altered = after.constraints.find((c) => c.id === pk.id)!;
    expect(altered.id).toBe(pk.id);
    expect('columnIds' in altered ? altered.columnIds : null).toEqual([ids.uemail]);
  });

  it('the SAME edit as drop-plus-add produces a DIFFERENT id', () => {
    // This is why alter_constraint exists. Without it, "change the primary
    // key" churns the id, so a diff reads as an unrelated delete + create and
    // constraint_divergence can never fire (D21).
    const { schema, ids } = build();
    const pk = schema.constraints.find((c) => c.name === 'users_pkey')!;
    const next = counterIdGen('z');
    let s = applyOp(schema, { kind: 'drop_constraint', constraintId: pk.id }, next);
    s = applyOp(s, { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: ids.users!, kind: 'primary_key', columnIds: [ids.uemail!] } }, next);
    expect(s.constraints.find((c) => c.name === 'users_pkey')!.id).not.toBe(pk.id);
  });

  it('alter_index preserves the index id', () => {
    const { schema } = build();
    const idx = schema.indexes[0]!;
    const after = applyOp(schema, { kind: 'alter_index', indexId: idx.id, patch: { unique: false } }, counterIdGen('z'));
    const altered = after.indexes.find((i) => i.id === idx.id)!;
    expect(altered.id).toBe(idx.id);
    expect(altered.unique).toBe(false);
  });
});

describe('unknown ids fail loudly', () => {
  const cases: SchemaOp[] = [
    { kind: 'drop_table', tableId: 'nope' },
    { kind: 'rename_table', tableId: 'nope', name: 'x' },
    { kind: 'drop_column', columnId: 'nope' },
    { kind: 'rename_column', columnId: 'nope', name: 'x' },
    { kind: 'retype_column', columnId: 'nope', type: { kind: 'int' } },
    { kind: 'drop_constraint', constraintId: 'nope' },
    { kind: 'alter_constraint', constraintId: 'nope', patch: {} },
    { kind: 'drop_index', indexId: 'nope' },
    { kind: 'alter_index', indexId: 'nope', patch: {} },
    { kind: 'add_column', tableId: 'nope', name: 'x', type: { kind: 'int' }, nullable: true, default: null },
  ];

  it.each(cases)('throws rather than silently no-op\'ing: $kind', (op) => {
    const { schema } = build();
    expect(() => applyOp(schema, op, counterIdGen('z'))).toThrow(/nope/);
  });
});
