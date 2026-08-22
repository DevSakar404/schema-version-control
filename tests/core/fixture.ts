import { applyOps } from '@/core/ops';
import { emptySchema, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';

/**
 * Shared base schema with stable, readable ids:
 *   t1 = users, c1 = id, c2 = email, c3 = age, k1 = users_pkey, i1 = idx_email
 *
 * Lives outside any *.test.ts file on purpose — importing a fixture from a
 * test file makes that file's suites re-run inside every importer.
 */
export function base(): Schema {
  let s = applyOps(emptySchema(), [{ kind: 'create_table', name: 'users' }], counterIdGen('t'));
  s = applyOps(s, [
    { kind: 'add_column', tableId: 't1', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: 't1', name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
    { kind: 'add_column', tableId: 't1', name: 'age', type: { kind: 'int' }, nullable: true, default: null },
  ], counterIdGen('c'));
  s = applyOps(s, [
    { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: 't1', kind: 'primary_key', columnIds: ['c1'] } },
  ], counterIdGen('k'));
  return applyOps(s, [
    { kind: 'add_index', index: { name: 'idx_email', tableId: 't1', columnIds: ['c2'], unique: true, method: 'btree', where: null } },
  ], counterIdGen('i'));
}
