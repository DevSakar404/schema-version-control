# Design

Technical design for a branch/diff/merge system over database schemas.
Rationale for each choice lives in [decisions.md](decisions.md); this document
describes *what* is built, not *why* it was chosen over the alternatives.

---

## 1. The product in one paragraph

A backend team shares one database. Two engineers each need a schema change for
their own feature. Today they write migrations independently and discover the
collision at migration time, in production. This tool gives the schema itself a
branch/diff/merge model: branch from `main`, evolve the schema independently,
see exactly what diverged, and merge back — with renames tracked as renames,
conflicts surfaced in plain language, and an ordered migration script as the
output.

Row data is out of scope. The artifact under version control is the schema.

---

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Schema** | The complete versioned artifact: tables, columns, constraints, indexes. A value, not a database. |
| **Commit** | An immutable snapshot of a Schema plus parent links, message, and author. |
| **Branch** | A named mutable pointer to a commit. |
| **Change** | One typed difference between two schemas, e.g. `column_renamed`. |
| **Conflict** | Both branches changed the same attribute of the same entity to different values. Requires a human. |
| **Hazard** | The merged result is invalid even though nobody disagreed. Requires a fix, not a choice. |
| **Statement** | One ordered, safety-classified DDL statement in the output migration. |

The distinction between *conflict* and *hazard* is central and is developed in
§7 and §8.

---

## 3. The schema model

### 3.1 Identity

Every entity carries an immutable synthetic `Id` (a 12-character nanoid) minted
at creation. `name` is an ordinary mutable attribute.

This single choice removes the hardest problem in the domain. Under name-based
identity, a rename is indistinguishable from a drop plus an add: the differ
reports data loss, and the merge discards a column. Under stable identity,
rename is simply "the `name` attribute of entity `X` changed" — correct by
construction, with no detection heuristic anywhere in the codebase.

### 3.2 Types

```ts
type Id = string;

type ColumnType =
  | { kind: 'smallint' | 'int' | 'bigint' }
  | { kind: 'boolean' | 'uuid' | 'date' | 'timestamptz' | 'jsonb' | 'text' }
  | { kind: 'varchar'; length: number }
  | { kind: 'numeric'; precision: number; scale: number };

interface Column {
  id: Id;
  name: string;
  type: ColumnType;
  nullable: boolean;
  default: string | null;
}

interface Table {
  id: Id;
  name: string;
  columns: Column[];
}

type Constraint =
  | { id: Id; name: string; tableId: Id; kind: 'primary_key'; columnIds: Id[] }
  | { id: Id; name: string; tableId: Id; kind: 'unique'; columnIds: Id[] }
  | { id: Id; name: string; tableId: Id; kind: 'check'; expression: string }
  | {
      id: Id; name: string; tableId: Id; kind: 'foreign_key';
      columnIds: Id[];
      referencedTableId: Id;
      referencedColumnIds: Id[];
      onDelete: ReferentialAction;
      onUpdate: ReferentialAction;
    };

type ReferentialAction = 'no_action' | 'restrict' | 'cascade' | 'set_null';

interface Index {
  id: Id;
  name: string;
  tableId: Id;
  columnIds: Id[];
  unique: boolean;
  method: 'btree' | 'hash' | 'gin';
  where: string | null;
}

interface Schema {
  tables: Table[];
  constraints: Constraint[];
  indexes: Index[];
}
```

### 3.3 Two structural choices worth naming

**Constraints and indexes reference columns by `Id`, never by name.** A rename
therefore propagates into every foreign key and index automatically. The
cascade logic that a name-keyed model would require does not exist in this
codebase.

**Constraints and indexes are flat, schema-level collections, not nested inside
`Table`.** A foreign key spans two tables, so nesting forces an arbitrary owner
and an awkward special case in diff. Flat collections make every entity kind
uniform: an ID-keyed set that diff, merge, and validate treat identically.

**Nullability is a column attribute, not a `NOT NULL` constraint.** Postgres
exposes it both ways; representing it twice would mean two code paths that can
disagree.

---

## 4. Operations

Schemas are never mutated. Editing applies an operation and returns a new
`Schema`.

```ts
type SchemaOp =
  | { kind: 'create_table'; name: string }
  | { kind: 'drop_table'; tableId: Id }
  | { kind: 'rename_table'; tableId: Id; name: string }
  | { kind: 'add_column'; tableId: Id; name: string; type: ColumnType;
      nullable: boolean; default: string | null }
  | { kind: 'drop_column'; columnId: Id }
  | { kind: 'rename_column'; columnId: Id; name: string }
  | { kind: 'retype_column'; columnId: Id; type: ColumnType }
  | { kind: 'set_column_nullable'; columnId: Id; nullable: boolean }
  | { kind: 'set_column_default'; columnId: Id; default: string | null }
  | { kind: 'add_constraint'; constraint: Omit<Constraint, 'id'> }
  | { kind: 'drop_constraint'; constraintId: Id }
  | { kind: 'add_index'; index: Omit<Index, 'id'> }
  | { kind: 'drop_index'; indexId: Id };

applyOp(schema: Schema, op: SchemaOp, mintId: () => Id): Schema
```

`mintId` is injected rather than imported so tests are deterministic — a test
supplies a counter and asserts on exact schemas.

`drop_table` and `drop_column` cascade to dependent constraints and indexes.
This is the one place cascade logic is needed, and it is deletion only.

---

## 5. Version history

```ts
interface Commit {
  id: Id;
  projectId: Id;
  parentIds: Id[];        // 0 for root, 1 for normal, 2 for a merge
  schema: Schema;         // full snapshot
  message: string;
  author: string;
  createdAt: string;
}

interface Branch {
  id: Id;
  projectId: Id;
  name: string;
  headCommitId: Id;
}
```

Commits store complete snapshots rather than deltas. The usual argument for an
operation log is that snapshots lose intent — you cannot tell a rename from a
drop-plus-add. Stable identity (§3.1) already preserves that intent, so the
argument does not apply, and snapshots make every read O(1) with no replay
machinery. Schemas are kilobytes.

### 5.1 Merge base

```ts
findMergeBase(commits: Map<Id, Commit>, a: Id, b: Id): Id | null
```

Ancestor sets are collected breadth-first from both heads; the merge base is
the common ancestor with the greatest depth. This is quadratic in history size
and entirely adequate here — histories are tens of commits. The source carries
a `ponytail:` comment naming the ceiling.

---

## 6. Diff

```ts
diff(a: Schema, b: Schema): Change[]
```

Entities are matched by `Id`. Present only in `b` means created; only in `a`
means dropped; present in both with differing attributes means one `Change` per
differing attribute.

```ts
type Change =
  | { kind: 'table_created'; tableId: Id; name: string }
  | { kind: 'table_dropped'; tableId: Id; name: string }
  | { kind: 'table_renamed'; tableId: Id; from: string; to: string }
  | { kind: 'column_added'; tableId: Id; columnId: Id; column: Column }
  | { kind: 'column_dropped'; tableId: Id; columnId: Id; name: string }
  | { kind: 'column_renamed'; tableId: Id; columnId: Id; from: string; to: string }
  | { kind: 'column_retyped'; tableId: Id; columnId: Id;
      from: ColumnType; to: ColumnType }
  | { kind: 'column_nullability_changed'; tableId: Id; columnId: Id;
      from: boolean; to: boolean }
  | { kind: 'column_default_changed'; tableId: Id; columnId: Id;
      from: string | null; to: string | null }
  | { kind: 'constraint_added'; constraint: Constraint }
  | { kind: 'constraint_dropped'; constraintId: Id; name: string }
  | { kind: 'constraint_changed'; constraintId: Id;
      from: Constraint; to: Constraint }
  | { kind: 'index_added'; index: Index }
  | { kind: 'index_dropped'; indexId: Id; name: string }
  | { kind: 'index_changed'; indexId: Id; from: Index; to: Index };
```

### 6.1 Attribute-level granularity

One column modified in two ways produces two changes. This is not cosmetic — it
sets the granularity of conflict detection. If Ana renames `email` and Ben
retypes `email`, the two changes touch different attributes of the same entity
and **both apply cleanly**. A line-oriented merge tool would report a conflict,
because both engineers edited the same line of a schema file. This tool knows
it is looking at a column and can tell the two edits apart.

---

## 7. Three-way merge

```ts
threeWayMerge(
  base: Schema,
  ours: Schema,
  theirs: Schema,
  resolutions?: Resolution[],
): MergeResult

interface MergeResult {
  schema: Schema;
  conflicts: Conflict[];     // unresolved only
  hazards: Hazard[];
  applied: Change[];         // auto-merged, for display
}
```

### 7.1 Algorithm

1. Compute `diff(base, ours)` and `diff(base, theirs)`.
2. Key every change by `(entityId, attribute)` — for example
   `"col_a1b2:name"`. Existence changes use the attribute `"__exists"`.
3. For each key:
   - present on one side only → apply it;
   - present on both with equal target values → convergent, apply once;
   - present on both with differing values → **conflict**.
4. Entity dropped on one side and modified on the other → `delete_modify`
   conflict. Dropped on **both** sides is convergent and is *not* a conflict.
5. Apply supplied resolutions.
6. Detect name collisions in the merged result (§7.3).
7. Run `validate` over the merged schema to produce hazards (§8).

Merging is order-independent: `threeWayMerge(base, a, b)` and
`threeWayMerge(base, b, a)` produce the same schema and the same set of
conflicts, with `ours`/`theirs` labels swapped. This is asserted as a property
test.

### 7.2 Conflict taxonomy

```ts
interface Conflict {
  id: string;                 // `${entityId}:${attribute}` — stable across previews
  class: ConflictClass;
  entity: { kind: 'table' | 'column' | 'constraint' | 'index';
            id: Id; displayName: string };
  attribute: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  description: string;        // plain language, rendered directly in the UI
}
```

| Class | Situation |
| --- | --- |
| `concurrent_rename` | Both branches renamed the same entity to different names. |
| `concurrent_retype` | Both changed the same column to different types. |
| `concurrent_nullability` | Both changed nullability differently. |
| `concurrent_default` | Both set different defaults. |
| `delete_modify` | One branch dropped the entity; the other modified it. |
| `name_collision` | Both branches contribute to two entities sharing a name in one scope. |
| `constraint_divergence` | Both altered the same constraint differently (e.g. the primary key over different column sets). |
| `index_divergence` | Both altered the same index differently. |

Convergent cases that are deliberately **not** conflicts: identical renames,
identical retypes, both dropping the same entity, and edits to different
attributes of the same entity (§6.1).

### 7.3 The name collision case

Two branches independently rename *different* columns to the same final name.
No entity conflicts with any other entity — each side's change is unambiguous
in isolation — yet the merged schema has two columns called `contact_email` in
one table and is invalid.

This surfaces as a `name_collision` **conflict** rather than a hazard, because
resolving it requires a human to choose names; there is no mechanical fix.
When a duplicate name arises entirely from one branch's own changes, it is that
branch's pre-existing bug and is reported as a hazard instead.

### 7.4 Resolutions

```ts
type Resolution =
  | { conflictId: string; choice: 'ours' }
  | { conflictId: string; choice: 'theirs' }
  | { conflictId: string; choice: 'custom'; value: unknown };
```

The `custom` branch is the reason this tool beats a text merge. When two
engineers rename the same column differently they were usually both reaching
for the same clarification, and the correct answer is frequently a third name
neither chose. A binary picker forces a known-wrong result plus a follow-up
commit. Because the tool understands that the conflict is about a column's
*name*, it can accept a new one and validate it in place.

Merge is blocked while any conflict is unresolved, or while any hazard has
severity `error`.

---

## 8. Validation: hazards

```ts
validate(schema: Schema): Hazard[]

interface Hazard {
  class: HazardClass;
  severity: 'error' | 'warning';
  entity: { kind: string; id: Id; displayName: string };
  description: string;
}
```

| Class | Severity | Detects |
| --- | --- | --- |
| `dangling_foreign_key` | error | FK references a table or column that no longer exists. |
| `constraint_on_missing_column` | error | Any constraint references a dropped column. |
| `index_on_missing_column` | error | Index covers a dropped column. |
| `duplicate_name` | error | Two tables, or two columns in one table, share a name. |
| `primary_key_nullable` | error | A column in the primary key is nullable. |
| `empty_table` | warning | Table has no columns. |
| `no_primary_key` | warning | Table has no primary key. |

**Why this is a separate pass.** A merge with zero conflicts can still produce a
broken schema. I drop `users.id`; you add a foreign key referencing it. The two
changes touch different entities, so no conflict detector will pair them, and a
conflict-only merge reports clean success while handing back a schema that will
not apply. Validity is a property of the *combined result*, so it can only be
checked after combining.

`validate` also runs on every commit, so a branch cannot silently accumulate an
invalid state that only surfaces at merge time.

---

## 9. Migration planning

```ts
plan(from: Schema, to: Schema): Statement[]

interface Statement {
  id: string;
  op: Change;
  sql: string;
  safety: 'safe' | 'destructive' | 'lossy' | 'blocking';
  note: string | null;   // why it carries that classification
}
```

The merged schema answers an academic question. The migration answers the
user's actual question: what do I run on Monday.

### 9.1 Ordering

Statements are emitted in fixed dependency phases:

1. Drop indexes that will become invalid.
2. Drop foreign keys that will become invalid.
3. Drop other constraints that will become invalid.
4. Create tables (columns only, no constraints).
5. Rename tables.
6. Add columns.
7. Rename columns.
8. Retype columns.
9. Alter nullability and defaults.
10. Add primary key, unique, and check constraints.
11. Add foreign keys.
12. Add indexes.
13. Drop columns.
14. Drop tables.

**Phases rather than a topological sort.** The obvious approach is to build a
dependency graph over statements and sort it — but foreign keys can be
circular (`users.org_id → orgs`, `orgs.owner_id → users`), and a topological
sort has no answer for a cycle. Separating table creation from foreign key
creation into different phases makes the ordering immune to cycles by
construction. It is less code than a graph sort *and* handles a case the graph
sort cannot.

Within phase 14, tables are dropped in reverse foreign key dependency order.

### 9.2 Safety classification

Row data is out of scope, but whether a schema change *destroys* data is a
property of the schema change, so it is classified and displayed.

| Class | Meaning | Examples |
| --- | --- | --- |
| `safe` | Additive and reversible. | `CREATE TABLE`, `ADD COLUMN` nullable, `RENAME`, widening a type. |
| `destructive` | Irreversibly discards data. | `DROP COLUMN`, `DROP TABLE`. |
| `lossy` | May truncate or fail on existing rows. | `text → int`, `varchar(255) → varchar(50)`, `SET NOT NULL`, `ADD COLUMN NOT NULL` without a default. |
| `blocking` | Correct, but may lock a large table. | `ALTER COLUMN TYPE` requiring a rewrite, non-concurrent `CREATE INDEX`. |

Safety for a retype is decided by a widening relation over `ColumnType`:
`smallint → int → bigint` widens; `varchar(n) → text` widens; `varchar(n) →
varchar(m)` widens iff `m ≥ n`; `numeric` widens iff both precision and scale
are non-decreasing. Anything else across families is `lossy`.

Renames emit `ALTER TABLE ... RENAME COLUMN`, which preserves data — possible
only because §3.1 tracked the rename as a rename. The identity decision pays
off here, several layers from where it was made.

### 9.3 Dialect

`render(statement: Statement): string` for Postgres, and only Postgres. The
model is dialect-neutral because it describes tables and types rather than
syntax; only this final step varies by engine. A plugin interface with one
implementation would be indirection without a payer.

---

## 10. Persistence

Supabase Postgres. Four tables:

```
projects  (id, name, created_at)
commits   (id, project_id, parent_ids text[], schema jsonb,
           message, author, created_at)
branches  (id, project_id, name, head_commit_id, created_at,
           unique (project_id, name))
```

Commits are immutable and never updated or deleted.

### 10.1 Concurrent merges

Advancing a branch head is a compare-and-swap:

```sql
UPDATE branches SET head_commit_id = $new
WHERE id = $branch AND head_commit_id = $expected
RETURNING *;
```

Zero rows returned means another user moved the branch between preview and
commit. The API returns `409` and the UI tells the user the branch moved and
re-runs the merge preview against the new head.

The premise of the product is a team sharing a database, so two people merging
into `main` at once is routine, not exotic. Last-write-wins would silently
discard a merge — an unusually embarrassing bug for a version control system.
The fix is one extra `WHERE` clause.

---

## 11. HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:id` | Project, branches, ahead/behind counts. |
| `POST` | `/api/projects/:id/branches` | Branch from a commit. |
| `GET` | `/api/branches/:id/schema` | Schema at branch head. |
| `POST` | `/api/branches/:id/commits` | Apply `SchemaOp[]`, commit. Body carries `expectedHead`. |
| `GET` | `/api/compare?base=&head=` | `Change[]` between two branches. |
| `POST` | `/api/merge/preview` | `{ target, source, resolutions }` → `MergeResult` + `Statement[]`. Read-only. |
| `POST` | `/api/merge` | Same body plus `expectedHead`. Creates the merge commit. `409` on CAS failure. |

`/api/merge/preview` being read-only is what lets the conflict screen recompute
freely as the user changes resolutions, with no risk of partial writes.

---

## 12. Interface

**Branch list** — every branch with ahead/behind counts against `main`, last
change, and *Compare* / *Merge* actions.

**Schema editor** — tables, columns, constraints, indexes. Edits accumulate as
uncommitted operations and are committed with a message, so a commit is a
deliberate act rather than an autosave.

**Diff view** — two branches side by side, grouped by table. Renames render as
`email → contact_email`, never as a drop plus an add. Colour and icon encode
change kind; every row states what changed in words.

**Merge view** — three stacked sections:

1. *Conflicts*, each in plain language — "Ana renamed `email` to
   `contact_email`; Ben changed `email` to `text`" — with base, ours, and
   theirs side by side and three actions: take ours, take theirs, write my own.
2. *Hazards*, separated from conflicts because they are not disagreements —
   nobody was wrong, the combination is. Each names the two changes that
   combined badly.
3. *Migration*, the generated Postgres DDL with a safety badge per statement
   and a copy button.

Merge is disabled until every conflict is resolved and no `error` hazard
remains, with the reason stated on the button rather than hidden in a tooltip.

**First run** — a new visitor lands on a seeded project with two branches
already diverged and a live conflict waiting. The interesting behaviour of this
product is invisible until divergence exists; an empty state would ask a
first-time visitor to hand-build two branches of schema changes before the tool
does anything a text editor could not.

---

## 13. Testing

Everything in `core/` is pure — no database, no React, no I/O — so every test
over the hard logic is a plain assertion with no fixtures or mocks.

**Example tests:** one per conflict class in §7.2; one per hazard class in §8;
convergent cases asserted to produce *no* conflict; rename propagation into
foreign keys and indexes; the widening relation in §9.2 across families.

**Property tests**, which catch whole classes of bug at once:

- Merging a branch into itself is a no-op.
- Merging with no divergence fast-forwards exactly.
- `threeWayMerge(base, a, b)` and `threeWayMerge(base, b, a)` agree.
- `validate(schema)` is empty for every schema reachable by valid operations.
- Applying `plan(from, to)` to `from` yields `to` — the migration round-trip,
  simulated against the model rather than a live database.

**Integration tests** cover the API routes, including a CAS conflict producing
`409`.

**Not built:** browser end-to-end tests. The risk in this project lives in
merge semantics, not in the DOM, and testing effort should follow the risk.

---

## 14. Non-goals

SQL DDL parsing. Live database introspection. Applying migrations to a real
database. Authentication and multi-user accounts. Rebase, cherry-pick, and
revert. Remotes, push, and pull. Row data migration. Dialects other than
Postgres.

Each is argued in [decisions.md](decisions.md). Introspection is the one that
is purely additive — it produces a `Schema` and touches nothing in `core/` —
and is therefore the first thing to add if time allows.
