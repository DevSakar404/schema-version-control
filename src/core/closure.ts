import type { Id } from './ids';
import { columnsReferencedBy, findColumn, findTable, type Schema } from './schema';

/**
 * The dependency closure of an entity (design.md §7.2).
 *
 * Everything an entity contains, plus everything that references it. Merge
 * uses this to detect delete/modify conflicts across containment: comparing
 * changes key by key only finds people who touched the *same* entity, and the
 * more common real conflict is two people touching *related* ones.
 */
export function closureOf(schema: Schema, entityId: Id): Set<Id> {
  const table = findTable(schema, entityId);
  if (table) {
    const columnIds = new Set(table.columns.map((c) => c.id));
    const closure = new Set<Id>([table.id, ...columnIds]);

    for (const c of schema.constraints) {
      const onTable = c.tableId === table.id;
      const pointsAtTable = c.kind === 'foreign_key' && c.referencedTableId === table.id;
      const usesColumn = columnsReferencedBy(c).some((id) => columnIds.has(id));
      if (onTable || pointsAtTable || usesColumn) closure.add(c.id);
    }
    for (const i of schema.indexes) {
      if (i.tableId === table.id || columnsReferencedBy(i).some((id) => columnIds.has(id))) {
        closure.add(i.id);
      }
    }
    return closure;
  }

  const column = findColumn(schema, entityId);
  if (column) {
    const closure = new Set<Id>([entityId]);
    for (const c of schema.constraints) {
      if (columnsReferencedBy(c).includes(entityId)) closure.add(c.id);
    }
    for (const i of schema.indexes) {
      if (columnsReferencedBy(i).includes(entityId)) closure.add(i.id);
    }
    return closure;
  }

  // Constraints and indexes contain nothing and are referenced by nothing.
  return new Set<Id>([entityId]);
}

/**
 * Whether a newly added entity would live inside, or point at, the closure of
 * something being deleted.
 *
 * Additions need their own check: an entity created on the other branch does
 * not exist in the base schema, so it can never appear in a base-computed
 * closure. This is precisely the "I dropped `users`, you added a column to
 * `users`" case.
 */
export function addedInto(
  added: { tableId?: Id; referencedTableId?: Id; columnIds?: Id[] },
  deletedId: Id,
  deletedClosure: ReadonlySet<Id>,
): boolean {
  const touches = (id: Id | undefined) => id !== undefined && (id === deletedId || deletedClosure.has(id));
  return (
    touches(added.tableId) ||
    touches(added.referencedTableId) ||
    (added.columnIds ?? []).some(touches)
  );
}
