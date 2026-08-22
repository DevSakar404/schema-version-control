import { describe, it, expect } from 'vitest';
import { quoteIdent, renderType, renderExpression, namerFor } from '@/core/dialects/postgres';
import { plan } from '@/core/migrate';
import { applyOps, type SchemaOp } from '@/core/ops';
import { type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

const evolve = (from: Schema, ops: SchemaOp[], prefix = 'n') => applyOps(from, ops, counterIdGen(prefix));
const sqlFor = (ops: SchemaOp[], prefix = 'n') => plan(base(), evolve(base(), ops, prefix)).map((s) => s.sql);
const oneOf = (ops: SchemaOp[], needle: string, prefix = 'n') =>
  sqlFor(ops, prefix).find((s) => s.includes(needle));

describe('identifier quoting is a trust boundary', () => {
  it('quotes plain identifiers so reserved words and mixed case survive', () => {
    expect(quoteIdent('order')).toBe('"order"');
    expect(quoteIdent('MyTable')).toBe('"MyTable"');
  });

  it('escapes an embedded double quote rather than interpolating it raw', () => {
    // Names are user input. This value must be inert, not executable.
    expect(quoteIdent('users"; DROP TABLE x; --')).toBe('"users""; DROP TABLE x; --"');
  });

  it('a hostile table name renders inert in real DDL', () => {
    const sql = oneOf([{ kind: 'rename_table', tableId: 't1', name: 'x"; DROP TABLE y; --' }], 'RENAME TO')!;
    expect(sql).toContain('"x""; DROP TABLE y; --"');
    // The payload never appears as a bare statement boundary.
    expect(sql.replace(/"[^"]*(?:""[^"]*)*"/g, '<ident>')).not.toContain('DROP TABLE y');
  });
});

describe('renderType', () => {
  it('renders parameterised types with their parameters', () => {
    expect(renderType({ kind: 'varchar', length: 255 })).toBe('varchar(255)');
    expect(renderType({ kind: 'numeric', precision: 10, scale: 2 })).toBe('numeric(10,2)');
    expect(renderType({ kind: 'bigint' })).toBe('bigint');
    expect(renderType({ kind: 'timestamptz' })).toBe('timestamptz');
  });
});

describe('renderExpression — the payoff of storing predicates by reference', () => {
  const namer = namerFor(base(), base());

  it('substitutes current column names into the template', () => {
    expect(renderExpression({ template: '{0} > 0', columnIds: ['c3'] }, namer)).toBe('"age" > 0');
  });

  it('handles multiple placeholders', () => {
    expect(renderExpression({ template: '{0} > 0 AND {1} IS NOT NULL', columnIds: ['c3', 'c2'] }, namer))
      .toBe('"age" > 0 AND "email" IS NOT NULL');
  });

  it('a renamed column renders with its NEW name, with no migration of the constraint', () => {
    // The whole reason CHECK predicates hold ids rather than text (design.md §3.4).
    const renamed = evolve(base(), [{ kind: 'rename_column', columnId: 'c3', name: 'years' }]);
    const after = namerFor(base(), renamed);
    expect(renderExpression({ template: '{0} > 0', columnIds: ['c3'] }, after)).toBe('"years" > 0');
  });
});

describe('statement rendering', () => {
  it('ALTER TABLE ... RENAME COLUMN, never a drop plus an add', () => {
    const sql = sqlFor([{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }]);
    expect(sql).toEqual(['ALTER TABLE "users" RENAME COLUMN "email" TO "contact_email";']);
  });

  it('CREATE TABLE inlines the new table\'s columns', () => {
    let to = evolve(base(), [{ kind: 'create_table', name: 'orders' }], 'o');
    to = evolve(to, [
      { kind: 'add_column', tableId: 'o1', name: 'id', type: { kind: 'bigint' }, nullable: false, default: null },
      { kind: 'add_column', tableId: 'o1', name: 'note', type: { kind: 'text' }, nullable: true, default: "''" },
    ], 'p');
    const create = plan(base(), to).map((s) => s.sql).find((s) => s.startsWith('CREATE TABLE'))!;
    expect(create).toContain('"id" bigint NOT NULL');
    expect(create).toContain(`"note" text DEFAULT ''`);
  });

  it('ADD COLUMN carries nullability and default', () => {
    expect(oneOf([{ kind: 'add_column', tableId: 't1', name: 'flag', type: { kind: 'boolean' }, nullable: false, default: 'false' }], 'ADD COLUMN'))
      .toBe('ALTER TABLE "users" ADD COLUMN "flag" boolean NOT NULL DEFAULT false;');
  });

  it('ALTER COLUMN TYPE includes an explicit USING cast', () => {
    expect(oneOf([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }], 'TYPE text'))
      .toBe('ALTER TABLE "users" ALTER COLUMN "email" TYPE text USING "email"::text;');
  });

  it('SET / DROP NOT NULL', () => {
    expect(oneOf([{ kind: 'set_column_nullable', columnId: 'c1', nullable: true }], 'NOT NULL'))
      .toBe('ALTER TABLE "users" ALTER COLUMN "id" DROP NOT NULL;');
    expect(oneOf([{ kind: 'set_column_nullable', columnId: 'c3', nullable: false }], 'NOT NULL'))
      .toBe('ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL;');
  });

  it('SET / DROP DEFAULT', () => {
    expect(oneOf([{ kind: 'set_column_default', columnId: 'c3', default: '0' }], 'DEFAULT'))
      .toBe('ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0;');
  });

  it('DROP COLUMN and DROP TABLE', () => {
    expect(oneOf([{ kind: 'drop_column', columnId: 'c3' }], 'DROP COLUMN'))
      .toBe('ALTER TABLE "users" DROP COLUMN "age";');
    expect(oneOf([{ kind: 'drop_table', tableId: 't1' }], 'DROP TABLE'))
      .toBe('DROP TABLE "users";');
  });

  it('renders each constraint kind', () => {
    expect(oneOf([{ kind: 'add_constraint', constraint: { name: 'age_uq', tableId: 't1', kind: 'unique', columnIds: ['c3'] } }], 'UNIQUE'))
      .toBe('ALTER TABLE "users" ADD CONSTRAINT "age_uq" UNIQUE ("age");');

    expect(oneOf([{ kind: 'add_constraint', constraint: { name: 'age_ok', tableId: 't1', kind: 'check', expression: { template: '{0} > 0', columnIds: ['c3'] } } }], 'CHECK'))
      .toBe('ALTER TABLE "users" ADD CONSTRAINT "age_ok" CHECK ("age" > 0);');
  });

  it('renders a unique and a partial index', () => {
    expect(oneOf([{ kind: 'add_index', index: { name: 'idx_age', tableId: 't1', columnIds: ['c3'], unique: true, method: 'btree', where: null } }], 'CREATE UNIQUE INDEX'))
      .toBe('CREATE UNIQUE INDEX "idx_age" ON "users" ("age");');

    expect(oneOf([{ kind: 'add_index', index: { name: 'idx_partial', tableId: 't1', columnIds: ['c2'], unique: false, method: 'btree', where: { template: '{0} IS NOT NULL', columnIds: ['c3'] } } }], 'WHERE'))
      .toBe('CREATE INDEX "idx_partial" ON "users" ("email") WHERE "age" IS NOT NULL;');
  });

  it('renders a non-btree index method', () => {
    expect(oneOf([{ kind: 'add_index', index: { name: 'idx_gin', tableId: 't1', columnIds: ['c2'], unique: false, method: 'gin', where: null } }], 'USING gin'))
      .toBe('CREATE INDEX "idx_gin" ON "users" USING gin ("email");');
  });
});
