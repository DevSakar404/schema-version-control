import type { Id } from './ids';
import {
  columnsReferencedBy,
  findColumn,
  findTable,
  sameType,
  type Column,
  type Schema,
} from './schema';

/**
 * Schema validation (design.md §8.1).
 *
 * The governing rule, from D23: **if Postgres would reject the DDL, validate
 * catches it first.** A validator that approves a migration the database then
 * refuses is worse than no validator, because the user trusted it and stopped
 * checking.
 *
 * This function is deliberately anonymous. It takes a final state and knows
 * nothing about who produced any part of it, so it never names an author.
 * Attribution is merge's job (design.md §8.2) — see AttributedHazard.
 */
export type HazardClass =
  | 'dangling_foreign_key'
  | 'constraint_on_missing_column'
  | 'index_on_missing_column'
  | 'duplicate_name'
  | 'duplicate_constraint_name'
  | 'duplicate_index_name'
  | 'multiple_primary_keys'
  | 'primary_key_nullable'
  | 'default_type_mismatch'
  | 'foreign_key_target_not_unique'
  | 'foreign_key_type_mismatch'
  | 'foreign_key_arity_mismatch'
  | 'empty_table'
  | 'no_primary_key';

export interface Hazard {
  class: HazardClass;
  severity: 'error' | 'warning';
  entity: { kind: 'table' | 'column' | 'constraint' | 'index'; id: Id; displayName: string };
  /** Plain language, naming the specific entities. Rendered directly in the UI. */
  description: string;
}

export function validate(schema: Schema): Hazard[] {
  return [
    ...danglingReferences(schema),
    ...duplicateNames(schema),
    ...primaryKeyRules(schema),
    ...defaultRules(schema),
    ...foreignKeyRules(schema),
    ...tableWarnings(schema),
  ];
}

/* ------------------------------------------------------- dangling refs */

function danglingReferences(schema: Schema): Hazard[] {
  const live = liveColumnIds(schema);
  const hazards: Hazard[] = [];

  for (const c of schema.constraints) {
    if (!findTable(schema, c.tableId)) continue; // orphaned with its table; not a separate defect
    if (c.kind === 'foreign_key' && !findTable(schema, c.referencedTableId)) {
      hazards.push({
        class: 'dangling_foreign_key',
        severity: 'error',
        entity: { kind: 'constraint', id: c.id, displayName: c.name },
        description: `Foreign key \`${c.name}\` references a table that no longer exists.`,
      });
      continue;
    }
    const missing = columnsReferencedBy(c).filter((id) => !live.has(id));
    if (missing.length) {
      hazards.push({
        class: c.kind === 'foreign_key' ? 'dangling_foreign_key' : 'constraint_on_missing_column',
        severity: 'error',
        entity: { kind: 'constraint', id: c.id, displayName: c.name },
        description: `Constraint \`${c.name}\` references ${missing.length} column(s) that no longer exist.`,
      });
    }
  }

  for (const i of schema.indexes) {
    const missing = columnsReferencedBy(i).filter((id) => !live.has(id));
    if (missing.length) {
      hazards.push({
        class: 'index_on_missing_column',
        severity: 'error',
        entity: { kind: 'index', id: i.id, displayName: i.name },
        description: `Index \`${i.name}\` covers ${missing.length} column(s) that no longer exist.`,
      });
    }
  }

  return hazards;
}

/* ---------------------------------------------------------- duplicates */

function duplicateNames(schema: Schema): Hazard[] {
  const hazards: Hazard[] = [];

  for (const dup of repeated(schema.tables.map((t) => [t.name, t] as const))) {
    hazards.push({
      class: 'duplicate_name',
      severity: 'error',
      entity: { kind: 'table', id: dup.id, displayName: dup.name },
      description: `More than one table is named \`${dup.name}\`.`,
    });
  }

  for (const table of schema.tables) {
    for (const dup of repeated(table.columns.map((c) => [c.name, c] as const))) {
      hazards.push({
        class: 'duplicate_name',
        severity: 'error',
        entity: { kind: 'column', id: dup.id, displayName: dup.name },
        description: `Table \`${table.name}\` has more than one column named \`${dup.name}\`.`,
      });
    }
  }

  // Constraint and index names are namespaced per schema in Postgres, not per
  // table, so these are checked globally.
  for (const dup of repeated(schema.constraints.map((c) => [c.name, c] as const))) {
    hazards.push({
      class: 'duplicate_constraint_name',
      severity: 'error',
      entity: { kind: 'constraint', id: dup.id, displayName: dup.name },
      description: `More than one constraint is named \`${dup.name}\`. Postgres requires these to be unique across the schema.`,
    });
  }

  for (const dup of repeated(schema.indexes.map((i) => [i.name, i] as const))) {
    hazards.push({
      class: 'duplicate_index_name',
      severity: 'error',
      entity: { kind: 'index', id: dup.id, displayName: dup.name },
      description: `More than one index is named \`${dup.name}\`.`,
    });
  }

  return hazards;
}

/* -------------------------------------------------------- primary keys */

function primaryKeyRules(schema: Schema): Hazard[] {
  const hazards: Hazard[] = [];

  for (const table of schema.tables) {
    const pks = schema.constraints.filter((c) => c.tableId === table.id && c.kind === 'primary_key');

    if (pks.length > 1) {
      for (const extra of pks.slice(1)) {
        hazards.push({
          class: 'multiple_primary_keys',
          severity: 'error',
          entity: { kind: 'constraint', id: extra.id, displayName: extra.name },
          description: `Table \`${table.name}\` has ${pks.length} primary keys. Postgres allows one.`,
        });
      }
    }

    if (pks.length === 0) {
      hazards.push({
        class: 'no_primary_key',
        severity: 'warning',
        entity: { kind: 'table', id: table.id, displayName: table.name },
        description: `Table \`${table.name}\` has no primary key.`,
      });
    }

    for (const pk of pks) {
      if (pk.kind !== 'primary_key') continue;
      for (const columnId of pk.columnIds) {
        const hit = findColumn(schema, columnId);
        if (hit?.column.nullable) {
          hazards.push({
            class: 'primary_key_nullable',
            severity: 'error',
            entity: { kind: 'column', id: hit.column.id, displayName: hit.column.name },
            description: `Column \`${table.name}.${hit.column.name}\` is part of the primary key but is nullable.`,
          });
        }
      }
    }
  }

  return hazards;
}

/* ------------------------------------------------------------ defaults */

/**
 * Bounded literal checking, not a Postgres type system.
 *
 * Function-call defaults (now(), gen_random_uuid(), nextval('s')) are opaque
 * and always accepted — checking them would need the expression parser this
 * project deliberately does not have (D14).
 */
function defaultRules(schema: Schema): Hazard[] {
  const hazards: Hazard[] = [];
  const isCall = (d: string) => /^[A-Za-z_][\w.]*\s*\(.*\)$/.test(d);
  const isQuoted = (d: string) => /^'.*'$/s.test(d);
  const isNumeric = (d: string) => /^-?\d+(\.\d+)?$/.test(d);

  for (const table of schema.tables) {
    for (const column of table.columns) {
      const d = column.default?.trim();
      if (!d || isCall(d) || d.toUpperCase() === 'NULL') continue;

      const numericKinds: Column['type']['kind'][] = ['smallint', 'int', 'bigint', 'numeric'];
      const bad =
        (numericKinds.includes(column.type.kind) && (isQuoted(d) || !isNumeric(d))) ||
        (column.type.kind === 'boolean' && !/^(true|false)$/i.test(d));

      if (bad) {
        hazards.push({
          class: 'default_type_mismatch',
          severity: 'error',
          entity: { kind: 'column', id: column.id, displayName: column.name },
          description: `Column \`${table.name}.${column.name}\` is ${column.type.kind} but its default \`${d}\` is not a valid ${column.type.kind} literal.`,
        });
      }
    }
  }

  return hazards;
}

/* -------------------------------------------------------- foreign keys */

function foreignKeyRules(schema: Schema): Hazard[] {
  const hazards: Hazard[] = [];
  const live = liveColumnIds(schema);

  for (const fk of schema.constraints) {
    if (fk.kind !== 'foreign_key') continue;
    if (!findTable(schema, fk.referencedTableId)) continue; // already reported as dangling

    if (fk.columnIds.length !== fk.referencedColumnIds.length) {
      hazards.push({
        class: 'foreign_key_arity_mismatch',
        severity: 'error',
        entity: { kind: 'constraint', id: fk.id, displayName: fk.name },
        description: `Foreign key \`${fk.name}\` has ${fk.columnIds.length} local column(s) but references ${fk.referencedColumnIds.length}.`,
      });
      continue; // pairing below would be meaningless
    }

    if (!fk.referencedColumnIds.every((id) => live.has(id))) continue; // dangling, already reported

    const target = new Set(fk.referencedColumnIds);
    const covered = schema.constraints.some(
      (c) =>
        c.tableId === fk.referencedTableId &&
        (c.kind === 'primary_key' || c.kind === 'unique') &&
        c.columnIds.length === target.size &&
        c.columnIds.every((id) => target.has(id)),
    );
    if (!covered) {
      hazards.push({
        class: 'foreign_key_target_not_unique',
        severity: 'error',
        entity: { kind: 'constraint', id: fk.id, displayName: fk.name },
        description: `Foreign key \`${fk.name}\` references columns not covered by a primary key or unique constraint. Postgres rejects this.`,
      });
    }

    for (const [i, localId] of fk.columnIds.entries()) {
      const local = findColumn(schema, localId)?.column;
      const remote = findColumn(schema, fk.referencedColumnIds[i]!)?.column;
      if (local && remote && !sameType(local.type, remote.type)) {
        hazards.push({
          class: 'foreign_key_type_mismatch',
          severity: 'error',
          entity: { kind: 'constraint', id: fk.id, displayName: fk.name },
          description: `Foreign key \`${fk.name}\` maps \`${local.name}\` (${local.type.kind}) to \`${remote.name}\` (${remote.type.kind}).`,
        });
      }
    }
  }

  return hazards;
}

/* ------------------------------------------------------------ warnings */

function tableWarnings(schema: Schema): Hazard[] {
  return schema.tables
    .filter((t) => t.columns.length === 0)
    .map((t) => ({
      class: 'empty_table' as const,
      severity: 'warning' as const,
      entity: { kind: 'table' as const, id: t.id, displayName: t.name },
      description: `Table \`${t.name}\` has no columns.`,
    }));
}

/* ------------------------------------------------------------- helpers */

function liveColumnIds(schema: Schema): Set<Id> {
  return new Set(schema.tables.flatMap((t) => t.columns.map((c) => c.id)));
}

/** Every entity after the first that shares a name with an earlier one. */
function repeated<T extends { id: Id; name: string }>(pairs: readonly (readonly [string, T])[]): T[] {
  const seen = new Set<string>();
  const dups: T[] = [];
  for (const [name, entity] of pairs) {
    if (seen.has(name)) dups.push(entity);
    else seen.add(name);
  }
  return dups;
}
