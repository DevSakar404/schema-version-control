import { describe, it, expect } from 'vitest';
import { plan, renderMigration } from '@/core/migrate';
import { applyOps, type SchemaOp } from '@/core/ops';
import { emptySchema, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

const evolve = (from: Schema, ops: SchemaOp[], prefix = 'n') =>
  applyOps(from, ops, counterIdGen(prefix));

/** Index of the first statement whose SQL matches, or -1. */
const indexOf = (statements: { sql: string }[], needle: string | RegExp) =>
  statements.findIndex((s) => (typeof needle === 'string' ? s.sql.includes(needle) : needle.test(s.sql)));

describe('the name-reuse bug (D20)', () => {
  it('RENAME emits before CREATE when a freed table name is reused', () => {
    // Rename users -> accounts, then create a NEW table called users.
    // The end state is valid; emitting CREATE first is not, because the old
    // users still exists at that moment. Assert on position, not membership.
    const to = evolve(base(), [
      { kind: 'rename_table', tableId: 't1', name: 'accounts' },
      { kind: 'create_table', name: 'users' },
    ]);
    const statements = plan(base(), to);
    const rename = indexOf(statements, 'RENAME TO "accounts"');
    const create = indexOf(statements, 'CREATE TABLE "users"');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(rename).toBeLessThan(create);
  });

  it('RENAME COLUMN emits before ADD COLUMN when a freed column name is reused', () => {
    const to = evolve(base(), [
      { kind: 'rename_column', columnId: 'c2', name: 'contact_email' },
      { kind: 'add_column', tableId: 't1', name: 'email', type: { kind: 'text' }, nullable: true, default: null },
    ]);
    const statements = plan(base(), to);
    const rename = indexOf(statements, 'RENAME COLUMN "email" TO "contact_email"');
    const add = indexOf(statements, 'ADD COLUMN "email"');
    expect(rename).toBeLessThan(add);
  });
});

describe('the swap bug (D20)', () => {
  it('a column-name swap emits three statements through a temporary', () => {
    const to = evolve(base(), [
      { kind: 'rename_column', columnId: 'c2', name: 'age' },
      { kind: 'rename_column', columnId: 'c3', name: 'email' },
    ]);
    const statements = plan(base(), to);
    const renames = statements.filter((s) => s.sql.includes('RENAME COLUMN'));
    expect(renames).toHaveLength(3);
    expect(renames.some((s) => s.sql.includes('__tmp_'))).toBe(true);
  });

  it('the temporary statement explains itself', () => {
    const to = evolve(base(), [
      { kind: 'rename_column', columnId: 'c2', name: 'age' },
      { kind: 'rename_column', columnId: 'c3', name: 'email' },
    ]);
    // A reviewer about to run a migration containing __tmp_1 deserves to know why.
    const temp = plan(base(), to).find((s) => s.sql.includes('__tmp_'))!;
    expect(temp.note).toContain('swapping names');
  });
});

describe('dependency ordering', () => {
  it('CREATE TABLE precedes a foreign key into it', () => {
    let to = evolve(base(), [{ kind: 'create_table', name: 'orders' }], 'o');
    to = evolve(to, [{ kind: 'add_column', tableId: 'o1', name: 'user_id', type: { kind: 'int' }, nullable: false, default: null }], 'p');
    to = evolve(to, [{
      kind: 'add_constraint',
      constraint: {
        name: 'orders_user_fkey', tableId: 'o1', kind: 'foreign_key',
        columnIds: ['p1'], referencedTableId: 't1', referencedColumnIds: ['c1'],
        onDelete: 'cascade', onUpdate: 'no_action',
      },
    }], 'q');
    const statements = plan(base(), to);
    expect(indexOf(statements, 'CREATE TABLE "orders"')).toBeLessThan(indexOf(statements, 'FOREIGN KEY'));
  });

  it('DROP INDEX precedes DROP COLUMN for the column it covers', () => {
    const to = evolve(base(), [{ kind: 'drop_column', columnId: 'c2' }]);
    const statements = plan(base(), to);
    expect(indexOf(statements, 'DROP INDEX')).toBeLessThan(indexOf(statements, 'DROP COLUMN'));
  });

  it('a rename precedes a retype of the same column', () => {
    const to = evolve(base(), [
      { kind: 'rename_column', columnId: 'c2', name: 'contact_email' },
      { kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } },
    ]);
    const statements = plan(base(), to);
    expect(indexOf(statements, 'RENAME COLUMN')).toBeLessThan(indexOf(statements, 'TYPE text'));
  });

  it('the retype uses the NEW column name, since renames already ran', () => {
    const to = evolve(base(), [
      { kind: 'rename_column', columnId: 'c2', name: 'contact_email' },
      { kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } },
    ]);
    const retype = plan(base(), to).find((s) => s.sql.includes('TYPE text'))!;
    expect(retype.sql).toContain('"contact_email"');
    expect(retype.sql).not.toContain('"email"');
  });
});

describe('circular foreign keys — the case a topological sort cannot handle', () => {
  it('produces a valid plan and terminates', () => {
    let start = evolve(emptySchema(), [{ kind: 'create_table', name: 'users' }, { kind: 'create_table', name: 'orgs' }], 'a');
    start = evolve(start, [
      { kind: 'add_column', tableId: 'a1', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
      { kind: 'add_column', tableId: 'a1', name: 'org_id', type: { kind: 'int' }, nullable: false, default: null },
      { kind: 'add_column', tableId: 'a2', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
      { kind: 'add_column', tableId: 'a2', name: 'owner_id', type: { kind: 'int' }, nullable: false, default: null },
    ], 'b');
    const to = evolve(start, [
      { kind: 'add_constraint', constraint: { name: 'users_org_fkey', tableId: 'a1', kind: 'foreign_key', columnIds: ['b2'], referencedTableId: 'a2', referencedColumnIds: ['b3'], onDelete: 'no_action', onUpdate: 'no_action' } },
      { kind: 'add_constraint', constraint: { name: 'orgs_owner_fkey', tableId: 'a2', kind: 'foreign_key', columnIds: ['b4'], referencedTableId: 'a1', referencedColumnIds: ['b1'], onDelete: 'no_action', onUpdate: 'no_action' } },
    ], 'c');

    const statements = plan(start, to);
    expect(statements.filter((s) => s.sql.includes('FOREIGN KEY'))).toHaveLength(2);
  });

  it('creates BOTH tables before either foreign key', () => {
    let to = evolve(emptySchema(), [{ kind: 'create_table', name: 'users' }, { kind: 'create_table', name: 'orgs' }], 'a');
    to = evolve(to, [
      { kind: 'add_column', tableId: 'a1', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
      { kind: 'add_column', tableId: 'a2', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    ], 'b');
    to = evolve(to, [
      { kind: 'add_constraint', constraint: { name: 'u_pk', tableId: 'a1', kind: 'primary_key', columnIds: ['b1'] } },
      { kind: 'add_constraint', constraint: { name: 'o_fk', tableId: 'a2', kind: 'foreign_key', columnIds: ['b2'], referencedTableId: 'a1', referencedColumnIds: ['b1'], onDelete: 'no_action', onUpdate: 'no_action' } },
    ], 'c');

    const statements = plan(emptySchema(), to);
    const lastCreate = statements.map((s) => s.sql).reduce((acc, sql, i) => (sql.startsWith('CREATE TABLE') ? i : acc), -1);
    expect(lastCreate).toBeLessThan(indexOf(statements, 'FOREIGN KEY'));
  });
});

describe('safety classification reaches the statements', () => {
  it('a dropped column is marked destructive', () => {
    const to = evolve(base(), [{ kind: 'drop_column', columnId: 'c3' }]);
    const drop = plan(base(), to).find((s) => s.sql.includes('DROP COLUMN'))!;
    expect(drop.safety).toBe('destructive');
    expect(drop.note).toBeTruthy();
  });

  it('a narrowing retype is marked lossy', () => {
    const to = evolve(base(), [{ kind: 'retype_column', columnId: 'c2', type: { kind: 'int' } }]);
    expect(plan(base(), to).find((s) => s.sql.includes('TYPE int'))!.safety).toBe('lossy');
  });

  it('a rename is safe — the payoff of tracking renames as renames', () => {
    const to = evolve(base(), [{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]);
    const statements = plan(base(), to);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.safety).toBe('safe');
    expect(statements[0]!.sql).toContain('RENAME COLUMN');
  });
});

describe('degenerate cases', () => {
  it('plan(s, s) is empty', () => {
    expect(plan(base(), base())).toEqual([]);
  });

  it('renderMigration annotates only the statements that need it', () => {
    const to = evolve(base(), [{ kind: 'drop_column', columnId: 'c3' }]);
    const sql = renderMigration(plan(base(), to));
    expect(sql).toContain('-- DESTRUCTIVE');
  });
});
