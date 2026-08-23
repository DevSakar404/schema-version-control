import { describe, it, expect } from 'vitest';
import { buildBaseSchema } from '@/seed/demo';
import { validate } from '@/core/validate';
import { threeWayMerge } from '@/core/merge';
import { applyOps } from '@/core/ops';
import { nanoIdGen } from '@/core/ids';
import type { Schema } from '@/core/schema';

describe("buildBaseSchema — the demo's base schema", () => {
  const schema = buildBaseSchema();

  it('validates completely clean', () => {
    // If this fails, the seed itself would 422 through the real commit path
    // (Task 15's invalid_schema guard) the moment someone tried to branch
    // from it in the editor.
    expect(validate(schema)).toEqual([]);
  });

  it('has all six related tables', () => {
    expect(schema.tables.map((t) => t.name).sort()).toEqual([
      'order_items', 'orders', 'organizations', 'payments', 'products', 'users',
    ]);
  });

  it('has five foreign keys wiring the tables together', () => {
    expect(schema.constraints.filter((c) => c.kind === 'foreign_key')).toHaveLength(5);
  });

  it('has at least one CHECK predicate', () => {
    expect(schema.constraints.some((c) => c.kind === 'check')).toBe(true);
  });

  it('has real indexes beyond what primary/unique keys already imply', () => {
    expect(schema.indexes.length).toBeGreaterThan(0);
  });
});

describe('the three planted scenarios, checked against the real merge engine', () => {
  // Not just "does the seed run" — does each scenario actually produce the
  // outcome the demo claims, using the same threeWayMerge/validate the app
  // itself calls. If these ever drift from what's on screen, this fails
  // before a reviewer notices the demo saying one thing and doing another.
  const main = buildBaseSchema();

  it('scenario 1: a concurrent_rename conflict, with an unrelated retype merging clean', () => {
    const email = schema_col(main, 'users', 'email');

    const branchA = applyOps(main, [
      { kind: 'rename_column', columnId: email, name: 'contact_email' },
    ], nanoIdGen);
    const branchB = applyOps(main, [
      { kind: 'rename_column', columnId: email, name: 'email_address' },
      { kind: 'retype_column', columnId: email, type: { kind: 'text' } },
    ], nanoIdGen);

    const r = threeWayMerge(main, branchA, branchB, [], { oursLabel: 'A', theirsLabel: 'B' });
    expect(r.conflicts.map((c) => c.class)).toEqual(['concurrent_rename']);
    // The retype is a different attribute of the same column and applies
    // without waiting for the rename conflict to be resolved.
    const mergedEmail = r.schema.tables.find((t) => t.name === 'users')!.columns.find((c) => c.id === email)!;
    expect(mergedEmail.type).toEqual({ kind: 'text' });
  });

  it('scenario 2: each branch is independently valid; only the merge is a hazard', () => {

    const usersId = schema_col(main, 'users', 'id');
    const orderUserId = schema_col(main, 'orders', 'user_id');
    const branchA = applyOps(main, [
      { kind: 'retype_column', columnId: usersId, type: { kind: 'uuid' } },
      { kind: 'retype_column', columnId: orderUserId, type: { kind: 'uuid' } },
    ], nanoIdGen);
    expect(validate(branchA)).toEqual([]);

    const paymentsId = main.tables.find((t) => t.name === 'payments')!.id;
    let branchB = applyOps(main, [
      { kind: 'add_column', tableId: paymentsId, name: 'approved_by_user_id', type: { kind: 'int' }, nullable: true, default: null },
    ], nanoIdGen);
    const newColId = branchB.tables.find((t) => t.name === 'payments')!.columns.find((c) => c.name === 'approved_by_user_id')!.id;
    branchB = applyOps(branchB, [
      { kind: 'add_constraint', constraint: { name: 'payments_approved_by_fkey', tableId: paymentsId, kind: 'foreign_key', columnIds: [newColId], referencedTableId: main.tables.find((t) => t.name === 'users')!.id, referencedColumnIds: [usersId], onDelete: 'set_null', onUpdate: 'no_action' } },
    ], nanoIdGen);
    expect(validate(branchB)).toEqual([]);

    const r = threeWayMerge(main, branchA, branchB, [], { oursLabel: 'A', theirsLabel: 'B' });
    expect(r.conflicts).toEqual([]);
    expect(r.hazards.map((h) => h.class)).toContain('foreign_key_type_mismatch');
    const hazard = r.hazards.find((h) => h.class === 'foreign_key_type_mismatch')!;
    expect(hazard.causedBy?.ours.length).toBeGreaterThan(0);
    expect(hazard.causedBy?.theirs.length).toBeGreaterThan(0);
  });

  it('scenario 3: dropping a table vs adding a column to it is a delete_modify conflict', () => {
    const paymentsId = main.tables.find((t) => t.name === 'payments')!.id;

    const branchA = applyOps(main, [{ kind: 'drop_table', tableId: paymentsId }], nanoIdGen);
    const branchB = applyOps(main, [
      { kind: 'add_column', tableId: paymentsId, name: 'refunded', type: { kind: 'boolean' }, nullable: false, default: 'false' },
    ], nanoIdGen);

    const r = threeWayMerge(main, branchA, branchB, [], { oursLabel: 'A', theirsLabel: 'B' });
    expect(r.conflicts.map((c) => c.class)).toEqual(['delete_modify']);
  });
});

function schema_col(schema: Schema, tableName: string, columnName: string): string {
  const t = schema.tables.find((x) => x.name === tableName)!;
  return t.columns.find((c) => c.name === columnName)!.id;
}
