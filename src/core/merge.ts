import type { Id } from './ids';
import { attributeOf, describeChange, diff, subjectOf, type Change } from './diff';
import { addedInto, closureOf } from './closure';
import { columnsReferencedBy } from './schema';
import { validate, type Hazard } from './validate';
import type { ColumnType, Schema, Table } from './schema';

/**
 * Three-way merge (design.md §7).
 *
 * Changes are paired by (entity, attribute), not by entity. That granularity
 * is the point: Ana renaming `email` and Ben retyping `email` touch different
 * attributes of one column and merge cleanly, where a line-oriented tool sees
 * one edited line and reports a conflict.
 */
export type ConflictClass =
  | 'concurrent_rename'
  | 'concurrent_retype'
  | 'concurrent_nullability'
  | 'concurrent_default'
  | 'delete_modify'
  | 'name_collision'
  | 'constraint_divergence'
  | 'index_divergence';

export interface Conflict {
  /** `${entityId}:${attribute}` — stable across previews, so the UI can key on it. */
  id: string;
  class: ConflictClass;
  entity: { kind: 'table' | 'column' | 'constraint' | 'index'; id: Id; displayName: string };
  attribute: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  /** Plain language, naming both sides. Rendered directly in the UI. */
  description: string;
}

export type Resolution =
  | { conflictId: string; choice: 'ours' }
  | { conflictId: string; choice: 'theirs' }
  | { conflictId: string; choice: 'custom'; value: unknown };

export interface MergeResult {
  schema: Schema;
  /** Unresolved only. */
  conflicts: Conflict[];
  hazards: Hazard[];
  /** Auto-merged changes, for display. */
  applied: Change[];
}

export interface MergeOptions {
  /** Branch labels used in conflict descriptions. */
  oursLabel?: string;
  theirsLabel?: string;
}

export function threeWayMerge(
  base: Schema,
  ours: Schema,
  theirs: Schema,
  resolutions: Resolution[] = [],
  options: MergeOptions = {},
): MergeResult {
  const oursLabel = options.oursLabel ?? 'ours';
  const theirsLabel = options.theirsLabel ?? 'theirs';
  const labels = { ours: oursLabel, theirs: theirsLabel };

  const oursChanges = keyChanges(diff(base, ours));
  const theirsChanges = keyChanges(diff(base, theirs));
  const byResolution = new Map(resolutions.map((r) => [r.conflictId, r]));

  const conflicts: Conflict[] = [];
  const applied: Change[] = [];

  // Pass 1 — deletions versus anything in their dependency closure. Runs
  // first because it decides which keys the pairwise pass must leave alone.
  const groups = findContainmentConflicts(base, oursChanges, theirsChanges, labels);
  const claimed = new Set<string>();
  for (const group of groups) {
    claimed.add(group.deletionKey);
    for (const key of group.counterpartKeys) claimed.add(key);

    const resolution = byResolution.get(group.conflict.id);
    if (!resolution) {
      // Unresolved: keep the entity rather than destroy it. The merge is
      // provisional until a human decides, and the recoverable choice is the
      // one that does not discard a colleague's work.
      conflicts.push(group.conflict);
      applied.push(...group.counterparts);
      continue;
    }
    if (resolution.choice === 'ours') applied.push(group.deletion);
    else applied.push(...group.counterparts);
  }

  // Pass 2 — both sides changed the same attribute of the same entity.
  for (const key of new Set([...oursChanges.keys(), ...theirsChanges.keys()])) {
    if (claimed.has(key)) continue;

    const mine = oursChanges.get(key);
    const yours = theirsChanges.get(key);

    if (mine && !yours) { applied.push(mine); continue; }
    if (yours && !mine) { applied.push(yours); continue; }
    if (!mine || !yours) continue;

    // Identical targets are convergent — two people reaching the same
    // conclusion is agreement, not conflict.
    if (sameTarget(mine, yours)) { applied.push(mine); continue; }

    const conflict = describeConflict(key, base, mine, yours, oursLabel, theirsLabel);
    const resolution = byResolution.get(conflict.id);
    if (!resolution) { conflicts.push(conflict); continue; }

    const chosen = resolveTo(resolution, mine, yours);
    if (chosen) applied.push(chosen);
  }

  const schema = applyChanges(base, applied);
  return { schema, conflicts, hazards: validate(schema), applied };
}

/* -------------------------------------------------- containment (§7.2) */

interface ContainmentGroup {
  conflict: Conflict;
  deletionKey: string;
  deletion: Change;
  counterparts: Change[];
  counterpartKeys: string[];
}

const isDeletion = (c: Change): boolean => c.kind.endsWith('_dropped');
const isAddition = (c: Change): boolean =>
  c.kind.endsWith('_added') || c.kind === 'table_created';

/** What a newly created entity attaches to, so additions can be tested against a closure. */
function addedRefs(change: Change): { tableId?: Id; referencedTableId?: Id; columnIds?: Id[] } {
  switch (change.kind) {
    case 'column_added':
      return { tableId: change.tableId };
    case 'constraint_added':
      return {
        tableId: change.constraint.tableId,
        referencedTableId:
          change.constraint.kind === 'foreign_key' ? change.constraint.referencedTableId : undefined,
        columnIds: columnsReferencedBy(change.constraint),
      };
    case 'index_added':
      return { tableId: change.index.tableId, columnIds: columnsReferencedBy(change.index) };
    default:
      return {};
  }
}

/**
 * Deleting an entity conflicts with any change to anything it contains or
 * that references it.
 *
 * Without this, dropping `users` on one branch while another adds a column to
 * `users` produces no overlapping key at all — the merge reports clean and
 * then applies a column to a table that no longer exists.
 */
function findContainmentConflicts(
  base: Schema,
  oursChanges: Map<string, Change>,
  theirsChanges: Map<string, Change>,
  labels: { ours: string; theirs: string },
): ContainmentGroup[] {
  const groups: ContainmentGroup[] = [];

  const scan = (
    deleting: Map<string, Change>,
    other: Map<string, Change>,
    deletingSide: 'ours' | 'theirs',
  ) => {
    for (const [deletionKey, deletion] of deleting) {
      if (!isDeletion(deletion)) continue;
      const deletedId = subjectOf(deletion);
      const closure = closureOf(base, deletedId);

      const counterpartKeys: string[] = [];
      const counterparts: Change[] = [];
      for (const [key, change] of other) {
        // Both sides deleting is convergent, not a conflict.
        if (isDeletion(change)) continue;
        const inClosure = closure.has(subjectOf(change));
        const attachesToClosure = isAddition(change) && addedInto(addedRefs(change), deletedId, closure);
        if (inClosure || attachesToClosure) {
          counterpartKeys.push(key);
          counterparts.push(change);
        }
      }
      if (!counterparts.length) continue;

      const entity = entityOf(deletion, base);
      const deletingLabel = deletingSide === 'ours' ? labels.ours : labels.theirs;
      const otherLabel = deletingSide === 'ours' ? labels.theirs : labels.ours;
      const summary = counterparts.map(describeChange).join('; ');

      groups.push({
        conflict: {
          id: deletionKey,
          class: 'delete_modify',
          entity,
          attribute: '__exists',
          base: 'present',
          ours: deletingSide === 'ours' ? 'dropped' : 'kept',
          theirs: deletingSide === 'ours' ? 'kept' : 'dropped',
          description:
            `${deletingLabel}: ${describeChange(deletion)}. ${otherLabel}: ${summary}. ` +
            `Dropping it discards ${otherLabel}'s ${counterparts.length === 1 ? 'change' : `${counterparts.length} changes`}.`,
        },
        deletionKey,
        deletion,
        counterparts,
        counterpartKeys,
      });
    }
  };

  scan(oursChanges, theirsChanges, 'ours');
  scan(theirsChanges, oursChanges, 'theirs');
  return groups;
}

/* ------------------------------------------------------------- pairing */

function keyChanges(changes: Change[]): Map<string, Change> {
  return new Map(changes.map((c) => [`${subjectOf(c)}:${attributeOf(c)}`, c]));
}

/** The value a change moves an attribute *to*. */
function targetOf(change: Change): unknown {
  switch (change.kind) {
    case 'table_created':
    case 'column_added':
    case 'constraint_added':
    case 'index_added':
      return 'created';
    case 'table_dropped':
    case 'column_dropped':
    case 'constraint_dropped':
    case 'index_dropped':
      return 'dropped';
    case 'table_renamed':
    case 'column_renamed':
    case 'column_retyped':
    case 'column_nullability_changed':
    case 'column_default_changed':
    case 'constraint_changed':
    case 'index_changed':
      return change.to;
  }
}

/** The value the attribute held in the merge base. */
function originOf(change: Change): unknown {
  return 'from' in change ? change.from : null;
}

function sameTarget(a: Change, b: Change): boolean {
  return JSON.stringify(targetOf(a)) === JSON.stringify(targetOf(b));
}

function resolveTo(resolution: Resolution, ours: Change, theirs: Change): Change | null {
  if (resolution.choice === 'ours') return ours;
  if (resolution.choice === 'theirs') return theirs;
  return withTarget(ours, resolution.value);
}

/** Rebuild a change carrying a value neither branch proposed (design.md §7.5). */
function withTarget(change: Change, value: unknown): Change | null {
  switch (change.kind) {
    case 'table_renamed':
    case 'column_renamed':
      return { ...change, to: value as string };
    case 'column_retyped':
      return { ...change, to: value as ColumnType };
    case 'column_nullability_changed':
      return { ...change, to: value as boolean };
    case 'column_default_changed':
      return { ...change, to: value as string | null };
    case 'constraint_changed':
      return { ...change, to: value as (Change & { kind: 'constraint_changed' })['to'] };
    case 'index_changed':
      return { ...change, to: value as (Change & { kind: 'index_changed' })['to'] };
    default:
      // Existence conflicts resolve by choosing a side, not by inventing a value.
      return null;
  }
}

/* -------------------------------------------------------- classification */

function classOf(change: Change, attribute: string): ConflictClass {
  switch (attribute) {
    case 'name': return 'concurrent_rename';
    case 'type': return 'concurrent_retype';
    case 'nullable': return 'concurrent_nullability';
    case 'default': return 'concurrent_default';
    case 'definition':
      return change.kind === 'index_changed' ? 'index_divergence' : 'constraint_divergence';
    default: return 'delete_modify';
  }
}

function entityOf(change: Change, base: Schema): Conflict['entity'] {
  const id = subjectOf(change);
  if ('columnId' in change) {
    const found = base.tables.flatMap((t: Table) => t.columns).find((c) => c.id === id);
    return { kind: 'column', id, displayName: found?.name ?? id };
  }
  if ('constraintId' in change) {
    return { kind: 'constraint', id, displayName: base.constraints.find((c) => c.id === id)?.name ?? id };
  }
  if ('indexId' in change) {
    return { kind: 'index', id, displayName: base.indexes.find((i) => i.id === id)?.name ?? id };
  }
  return { kind: 'table', id, displayName: base.tables.find((t) => t.id === id)?.name ?? id };
}

function describeConflict(
  key: string,
  base: Schema,
  ours: Change,
  theirs: Change,
  oursLabel: string,
  theirsLabel: string,
): Conflict {
  const attribute = attributeOf(ours);
  const entity = entityOf(ours, base);
  return {
    id: key,
    class: classOf(ours, attribute),
    entity,
    attribute,
    base: originOf(ours),
    ours: targetOf(ours),
    theirs: targetOf(theirs),
    description: `${oursLabel}: ${describeChange(ours)}. ${theirsLabel}: ${describeChange(theirs)}.`,
  };
}

/* ------------------------------------------------------------ applying */

/**
 * Apply resolved changes to the base schema.
 *
 * Ordered so a change never lands on something that does not exist yet:
 * creations, then modifications, then deletions.
 */
function applyChanges(base: Schema, changes: Change[]): Schema {
  const phase = (c: Change): number => {
    switch (c.kind) {
      case 'table_created': return 0;
      case 'column_added': return 1;
      case 'table_renamed':
      case 'column_renamed':
      case 'column_retyped':
      case 'column_nullability_changed':
      case 'column_default_changed': return 2;
      case 'constraint_added':
      case 'index_added': return 3;
      case 'constraint_changed':
      case 'index_changed': return 4;
      case 'constraint_dropped':
      case 'index_dropped': return 5;
      case 'column_dropped': return 6;
      case 'table_dropped': return 7;
    }
  };

  return [...changes].sort((a, b) => phase(a) - phase(b)).reduce(applyChange, base);
}

function applyChange(schema: Schema, change: Change): Schema {
  const mapTable = (id: Id, fn: (t: Table) => Table): Schema => ({
    ...schema,
    tables: schema.tables.map((t) => (t.id === id ? fn(t) : t)),
  });

  switch (change.kind) {
    case 'table_created':
      return schema.tables.some((t) => t.id === change.tableId)
        ? schema
        : { ...schema, tables: [...schema.tables, { id: change.tableId, name: change.name, columns: [] }] };

    case 'table_dropped':
      return {
        tables: schema.tables.filter((t) => t.id !== change.tableId),
        constraints: schema.constraints.filter((c) => c.tableId !== change.tableId),
        indexes: schema.indexes.filter((i) => i.tableId !== change.tableId),
      };

    case 'table_renamed':
      return mapTable(change.tableId, (t) => ({ ...t, name: change.to }));

    case 'column_added':
      return mapTable(change.tableId, (t) =>
        t.columns.some((c) => c.id === change.columnId) ? t : { ...t, columns: [...t.columns, change.column] },
      );

    case 'column_dropped':
      return mapTable(change.tableId, (t) => ({
        ...t,
        columns: t.columns.filter((c) => c.id !== change.columnId),
      }));

    case 'column_renamed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, name: change.to }));
    case 'column_retyped':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, type: change.to }));
    case 'column_nullability_changed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, nullable: change.to }));
    case 'column_default_changed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, default: change.to }));

    case 'constraint_added':
      return schema.constraints.some((c) => c.id === change.constraintId)
        ? schema
        : { ...schema, constraints: [...schema.constraints, change.constraint] };
    case 'constraint_dropped':
      return { ...schema, constraints: schema.constraints.filter((c) => c.id !== change.constraintId) };
    case 'constraint_changed':
      return {
        ...schema,
        constraints: schema.constraints.map((c) => (c.id === change.constraintId ? change.to : c)),
      };

    case 'index_added':
      return schema.indexes.some((i) => i.id === change.indexId)
        ? schema
        : { ...schema, indexes: [...schema.indexes, change.index] };
    case 'index_dropped':
      return { ...schema, indexes: schema.indexes.filter((i) => i.id !== change.indexId) };
    case 'index_changed':
      return { ...schema, indexes: schema.indexes.map((i) => (i.id === change.indexId ? change.to : i)) };
  }
}

function mapColumn(schema: Schema, columnId: Id, fn: (c: Table['columns'][number]) => Table['columns'][number]): Schema {
  return {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => (c.id === columnId ? fn(c) : c)),
    })),
  };
}
