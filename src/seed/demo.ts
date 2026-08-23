/**
 * The seeded demo project (design.md §12 "First run", Task 20).
 *
 * The interesting behavior of this product is invisible until two branches
 * have diverged. A first-time visitor who has to hand-build that divergence
 * before seeing anything a text editor couldn't already do would bounce
 * before reaching the point. This seeds a realistic, related, six-table
 * schema on `main`, then plants three branch pairs — each one an unresolved
 * merge waiting one click away, each one demonstrating something a naive
 * schema-diff tool gets wrong:
 *
 *   1. A genuine rename conflict, alongside an independent retype that
 *      merges cleanly because it touches a different attribute (§6.1) — the
 *      identity payoff, visible in one screen.
 *   2. A zero-conflict merge that is still invalid (§8) — the canonical
 *      hazard example, attributed to both branches.
 *   3. A table dropped on one branch while the other adds a column to it
 *      (§7.2) — the containment case most tools get wrong entirely.
 *
 * Re-running this is a full reset, not an upsert: the demo project uses a
 * fixed id, and seeding deletes any existing project with that id first (the
 * delete cascades to its commits and branches). A reviewer who has broken
 * the demo while exploring the editor recovers by re-seeding, not by asking
 * for a redeploy.
 */

import { createProject } from '../db/projects';
import { insertCommit } from '../db/commits';
import { createBranch } from '../db/branches';
import { db } from '../db/client';
import { applyOps, type SchemaOp } from '../core/ops';
import { emptySchema, type Column, type Schema, type Table } from '../core/schema';
import { nanoIdGen, type Id } from '../core/ids';
import type { Commit } from '../core/history';

export const DEMO_PROJECT_ID = 'demo';

function table(schema: Schema, name: string): Table {
  const found = schema.tables.find((t) => t.name === name);
  if (!found) throw new Error(`seed: table '${name}' not found`);
  return found;
}

function column(schema: Schema, tableName: string, columnName: string): Column {
  const found = table(schema, tableName).columns.find((c) => c.name === columnName);
  if (!found) throw new Error(`seed: column '${tableName}.${columnName}' not found`);
  return found;
}

function apply(schema: Schema, ops: SchemaOp[]): Schema {
  return applyOps(schema, ops, nanoIdGen);
}

/**
 * The base schema: a small storefront. Pure and independently testable —
 * six related tables, five foreign keys, two indexes, one CHECK.
 */
export function buildBaseSchema(): Schema {
  let s = emptySchema();

  s = apply(s, [
    { kind: 'create_table', name: 'organizations' },
    { kind: 'create_table', name: 'users' },
    { kind: 'create_table', name: 'products' },
    { kind: 'create_table', name: 'orders' },
    { kind: 'create_table', name: 'order_items' },
    { kind: 'create_table', name: 'payments' },
  ]);

  const orgId = table(s, 'organizations').id;
  const usersId = table(s, 'users').id;
  const productsId = table(s, 'products').id;
  const ordersId = table(s, 'orders').id;
  const itemsId = table(s, 'order_items').id;
  const paymentsId = table(s, 'payments').id;

  s = apply(s, [
    { kind: 'add_column', tableId: orgId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: orgId, name: 'name', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },

    { kind: 'add_column', tableId: usersId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: usersId, name: 'organization_id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: usersId, name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
    { kind: 'add_column', tableId: usersId, name: 'full_name', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
    { kind: 'add_column', tableId: usersId, name: 'created_at', type: { kind: 'timestamptz' }, nullable: false, default: 'now()' },

    { kind: 'add_column', tableId: productsId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: productsId, name: 'sku', type: { kind: 'varchar', length: 64 }, nullable: false, default: null },
    { kind: 'add_column', tableId: productsId, name: 'name', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
    { kind: 'add_column', tableId: productsId, name: 'price_cents', type: { kind: 'int' }, nullable: false, default: null },

    { kind: 'add_column', tableId: ordersId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: ordersId, name: 'user_id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: ordersId, name: 'status', type: { kind: 'varchar', length: 32 }, nullable: false, default: "'pending'" },
    { kind: 'add_column', tableId: ordersId, name: 'total_cents', type: { kind: 'int' }, nullable: false, default: '0' },
    { kind: 'add_column', tableId: ordersId, name: 'created_at', type: { kind: 'timestamptz' }, nullable: false, default: 'now()' },

    { kind: 'add_column', tableId: itemsId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: itemsId, name: 'order_id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: itemsId, name: 'product_id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: itemsId, name: 'quantity', type: { kind: 'int' }, nullable: false, default: '1' },
    { kind: 'add_column', tableId: itemsId, name: 'unit_price_cents', type: { kind: 'int' }, nullable: false, default: null },

    { kind: 'add_column', tableId: paymentsId, name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: paymentsId, name: 'order_id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: paymentsId, name: 'amount_cents', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: paymentsId, name: 'status', type: { kind: 'varchar', length: 32 }, nullable: false, default: "'pending'" },
  ]);

  s = apply(s, [
    { kind: 'add_constraint', constraint: { name: 'organizations_pkey', tableId: orgId, kind: 'primary_key', columnIds: [column(s, 'organizations', 'id').id] } },
    { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: usersId, kind: 'primary_key', columnIds: [column(s, 'users', 'id').id] } },
    { kind: 'add_constraint', constraint: { name: 'products_pkey', tableId: productsId, kind: 'primary_key', columnIds: [column(s, 'products', 'id').id] } },
    { kind: 'add_constraint', constraint: { name: 'orders_pkey', tableId: ordersId, kind: 'primary_key', columnIds: [column(s, 'orders', 'id').id] } },
    { kind: 'add_constraint', constraint: { name: 'order_items_pkey', tableId: itemsId, kind: 'primary_key', columnIds: [column(s, 'order_items', 'id').id] } },
    { kind: 'add_constraint', constraint: { name: 'payments_pkey', tableId: paymentsId, kind: 'primary_key', columnIds: [column(s, 'payments', 'id').id] } },

    { kind: 'add_constraint', constraint: { name: 'users_email_key', tableId: usersId, kind: 'unique', columnIds: [column(s, 'users', 'email').id] } },
    { kind: 'add_constraint', constraint: { name: 'products_sku_key', tableId: productsId, kind: 'unique', columnIds: [column(s, 'products', 'sku').id] } },

    {
      kind: 'add_constraint', constraint: {
        name: 'users_organization_fkey', tableId: usersId, kind: 'foreign_key',
        columnIds: [column(s, 'users', 'organization_id').id], referencedTableId: orgId,
        referencedColumnIds: [column(s, 'organizations', 'id').id], onDelete: 'cascade', onUpdate: 'no_action',
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'orders_user_fkey', tableId: ordersId, kind: 'foreign_key',
        columnIds: [column(s, 'orders', 'user_id').id], referencedTableId: usersId,
        referencedColumnIds: [column(s, 'users', 'id').id], onDelete: 'cascade', onUpdate: 'no_action',
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'order_items_order_fkey', tableId: itemsId, kind: 'foreign_key',
        columnIds: [column(s, 'order_items', 'order_id').id], referencedTableId: ordersId,
        referencedColumnIds: [column(s, 'orders', 'id').id], onDelete: 'cascade', onUpdate: 'no_action',
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'order_items_product_fkey', tableId: itemsId, kind: 'foreign_key',
        columnIds: [column(s, 'order_items', 'product_id').id], referencedTableId: productsId,
        referencedColumnIds: [column(s, 'products', 'id').id], onDelete: 'restrict', onUpdate: 'no_action',
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'payments_order_fkey', tableId: paymentsId, kind: 'foreign_key',
        columnIds: [column(s, 'payments', 'order_id').id], referencedTableId: ordersId,
        referencedColumnIds: [column(s, 'orders', 'id').id], onDelete: 'cascade', onUpdate: 'no_action',
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'orders_total_nonnegative', tableId: ordersId, kind: 'check',
        expression: { template: '{0} >= 0', columnIds: [column(s, 'orders', 'total_cents').id] },
      },
    },
    {
      kind: 'add_constraint', constraint: {
        name: 'order_items_quantity_positive', tableId: itemsId, kind: 'check',
        expression: { template: '{0} > 0', columnIds: [column(s, 'order_items', 'quantity').id] },
      },
    },
  ]);

  s = apply(s, [
    { kind: 'add_index', index: { name: 'idx_orders_user', tableId: ordersId, columnIds: [column(s, 'orders', 'user_id').id], unique: false, method: 'btree', where: null } },
    { kind: 'add_index', index: { name: 'idx_order_items_order', tableId: itemsId, columnIds: [column(s, 'order_items', 'order_id').id], unique: false, method: 'btree', where: null } },
    { kind: 'add_index', index: { name: 'idx_payments_order', tableId: paymentsId, columnIds: [column(s, 'payments', 'order_id').id], unique: false, method: 'btree', where: null } },
  ]);

  return s;
}

interface Scenario {
  name: string;
  build: (main: Schema) => { branchA: { name: string; message: string; author: string; schema: Schema }; branchB: { name: string; message: string; author: string; schema: Schema } };
}

/**
 * Scenario 1 — a genuine concurrent_rename conflict, alongside an
 * independent retype that merges cleanly because it touches a different
 * attribute of the same column (§6.1), plus a lossy ADD COLUMN.
 *
 * The plan's original one-line description of this scenario read as if the
 * rename+retype pair ITSELF were the conflict — it isn't, by design (Task 7
 * proved exactly that pairing merges clean). The real conflict here is that
 * BOTH branches rename `email`, to different names; the retype rides along
 * on one of them, unconflicted, and is what actually demonstrates the
 * payoff once the rename is resolved.
 */
const renameConflict: Scenario = {
  name: 'rename-conflict',
  build: (main) => {
    const email = column(main, 'users', 'email').id;
    const branchA = apply(main, [
      { kind: 'rename_column', columnId: email, name: 'contact_email' },
      { kind: 'add_index', index: { name: 'idx_users_contact_email', tableId: table(main, 'users').id, columnIds: [email], unique: true, method: 'btree', where: null } },
    ]);
    const branchB = apply(main, [
      { kind: 'rename_column', columnId: email, name: 'email_address' },
      { kind: 'retype_column', columnId: email, type: { kind: 'text' } },
      { kind: 'add_column', tableId: table(main, 'users').id, name: 'phone', type: { kind: 'varchar', length: 32 }, nullable: false, default: null },
    ]);
    return {
      branchA: { name: 'feature/rename-contact-email', message: 'Rename email to contact_email, index it', author: 'Priya', schema: branchA },
      branchB: { name: 'feature/normalize-email', message: 'Rename email, widen to text, add phone', author: 'Marcus', schema: branchB },
    };
  },
};

/**
 * Scenario 2 — the canonical hazard (design.md §8, D9/D19): a zero-conflict
 * merge that is still invalid. Both branches are independently valid; only
 * their combination breaks. Neither deletes anything and neither edits the
 * same attribute twice, so containment (§7.2) and Pass 2 both correctly stay
 * quiet — this is exactly the case validate() exists to catch after they
 * combine.
 */
const hazardMerge: Scenario = {
  name: 'hazard',
  build: (main) => {
    const usersId = table(main, 'users').id;
    const paymentsId = table(main, 'payments').id;

    // Branch A retypes BOTH ends of the existing users<->orders relationship
    // together, so it stays internally consistent and valid on its own.
    const branchA = apply(main, [
      { kind: 'retype_column', columnId: column(main, 'users', 'id').id, type: { kind: 'uuid' } },
      { kind: 'retype_column', columnId: column(main, 'orders', 'user_id').id, type: { kind: 'uuid' } },
    ]);

    // Branch B never touches users.id, so its new int-typed FK is valid
    // against the base schema in isolation.
    const branchBPre = apply(main, [
      { kind: 'add_column', tableId: paymentsId, name: 'approved_by_user_id', type: { kind: 'int' }, nullable: true, default: null },
    ]);
    const branchB = apply(branchBPre, [
      {
        kind: 'add_constraint', constraint: {
          name: 'payments_approved_by_fkey', tableId: paymentsId, kind: 'foreign_key',
          columnIds: [column(branchBPre, 'payments', 'approved_by_user_id').id], referencedTableId: usersId,
          referencedColumnIds: [column(branchBPre, 'users', 'id').id], onDelete: 'set_null', onUpdate: 'no_action',
        },
      },
    ]);

    return {
      branchA: { name: 'feature/uuid-user-ids', message: 'Switch users.id and orders.user_id to uuid', author: 'Devon', schema: branchA },
      branchB: { name: 'feature/payment-approvals', message: 'Track which user approved a payment', author: 'Sana', schema: branchB },
    };
  },
};

/**
 * Scenario 3 — containment (D19): one branch drops a table entirely while
 * the other adds a column to it. Key-by-key comparison finds no overlap at
 * all here; this is the case most tools get wrong outright.
 */
const containmentConflict: Scenario = {
  name: 'containment-conflict',
  build: (main) => {
    const paymentsId = table(main, 'payments').id;
    const branchA = apply(main, [{ kind: 'drop_table', tableId: paymentsId }]);
    const branchB = apply(main, [
      { kind: 'add_column', tableId: paymentsId, name: 'refunded', type: { kind: 'boolean' }, nullable: false, default: 'false' },
    ]);
    return {
      branchA: { name: 'feature/drop-payments', message: 'Remove the payments table (moving to a payment processor)', author: 'Priya', schema: branchA },
      branchB: { name: 'feature/refund-flag', message: 'Track whether a payment was refunded', author: 'Marcus', schema: branchB },
    };
  },
};

export async function seedDemo(): Promise<{ projectId: Id }> {
  await db()`delete from projects where id = ${DEMO_PROJECT_ID}`; // cascades to commits and branches

  await createProject('Storefront', DEMO_PROJECT_ID);

  const baseSchema = buildBaseSchema();
  const root: Commit = {
    id: nanoIdGen(), projectId: DEMO_PROJECT_ID, parentIds: [], schema: baseSchema,
    message: 'Initial schema: organizations, users, products, orders, order_items, payments',
    author: 'seed', createdAt: new Date().toISOString(),
  };
  await insertCommit(root);
  await createBranch(DEMO_PROJECT_ID, 'main', root.id);

  for (const scenario of [renameConflict, hazardMerge, containmentConflict]) {
    const { branchA, branchB } = scenario.build(baseSchema);
    for (const branch of [branchA, branchB]) {
      const commit: Commit = {
        id: nanoIdGen(), projectId: DEMO_PROJECT_ID, parentIds: [root.id], schema: branch.schema,
        message: branch.message, author: branch.author, createdAt: new Date().toISOString(),
      };
      await insertCommit(commit);
      await createBranch(DEMO_PROJECT_ID, branch.name, commit.id);
    }
  }

  return { projectId: DEMO_PROJECT_ID };
}
