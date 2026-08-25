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
  | { id: Id; name: string; tableId: Id; kind: 'check'; expression: Expression }
  | {
      id: Id; name: string; tableId: Id; kind: 'foreign_key';
      columnIds: Id[];
      referencedTableId: Id;
      referencedColumnIds: Id[];
      onDelete: ReferentialAction;
      onUpdate: ReferentialAction;
    };

type ReferentialAction = 'no_action' | 'restrict' | 'cascade' | 'set_null';

/** A predicate over columns, stored by reference rather than as free text. */
interface Expression {
  template: string;      // e.g. '{c1} > 0 AND {c2} IS NOT NULL'
  columnIds: Id[];       // {c1} is columnIds[0], {c2} is columnIds[1]
}

interface Index {
  id: Id;
  name: string;
  tableId: Id;
  columnIds: Id[];
  unique: boolean;
  method: 'btree' | 'hash' | 'gin';
  where: Expression | null;
}

interface Schema {
  tables: Table[];
  constraints: Constraint[];
  indexes: Index[];
}
```

### 3.3 Three structural choices worth naming

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

### 3.4 Predicates are structured, not free text

A `CHECK (age > 0)` stored as the string `"age > 0"` is a hole straight through
the identity model. It references a column *by name*, in text, which nothing
can see: rename `age` and the constraint silently still says `age`; drop `age`
and the constraint dangles with no way to detect it. The one rule this design
rests on — never match entities by name — would be violated by the very field
meant to express a rule about them.

`Expression` closes the hole without a SQL parser. The editor already knows
which columns the user picked, so it stores them as IDs and leaves numbered
placeholders in the template. Rendering substitutes current names at DDL time,
so renames propagate for free, and `validate` checks `columnIds` exactly as it
does for every other entity. Partial index predicates (`Index.where`) use the
same type for the same reason.

The cost is that users compose predicates through the editor rather than
typing arbitrary SQL. That is a real limitation and an accepted one: free-text
predicates would require the parser cut in D14, and a rule the tool cannot
read is a rule it cannot protect.

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
  | { kind: 'alter_constraint'; constraintId: Id;
      patch: Partial<Omit<Constraint, 'id' | 'kind' | 'tableId'>> }
  | { kind: 'add_index'; index: Omit<Index, 'id'> }
  | { kind: 'drop_index'; indexId: Id }
  | { kind: 'alter_index'; indexId: Id;
      patch: Partial<Omit<Index, 'id' | 'tableId'>> };

applyOp(schema: Schema, op: SchemaOp, mintId: () => Id): Schema
```

`mintId` is injected rather than imported so tests are deterministic — a test
supplies a counter and asserts on exact schemas.

`drop_table` and `drop_column` cascade to dependent constraints and indexes.
This is the one place cascade logic is needed, and it is deletion only.

### 4.1 Why `alter_constraint` and `alter_index` exist

Without them, "change the primary key" is expressible only as drop plus add —
which mints a **new id**, and therefore reads as *deleted one constraint,
created an unrelated one*. Two branches each adjusting the same primary key
would produce two independent additions, merge with no conflict reported, and
leave a table with two primary keys. That is precisely the
rename-versus-drop-plus-add failure from §3.1, one entity kind over: identity
was solved for columns and quietly left unsolved for constraints.

So constraints and indexes get the same ID-preserving edit path columns
already have. The editor emits `alter_constraint` when a user modifies an
existing rule, and reserves drop-plus-add for genuinely replacing one rule
with a different one.

Without this operation the `constraint_changed` and `index_changed` changes
(§6) and the `constraint_divergence` and `index_divergence` conflicts (§7.3)
would be **unreachable in practice** — types the model describes and the
product can never produce. A conflict class that cannot fire is worse than a
missing one, because the tests pass and the taxonomy looks complete.

`kind` and `tableId` are excluded from the patch: changing either means it is
a different rule, and that is drop plus add.

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
  conflicts: Conflict[];       // unresolved only
  hazards: AttributedHazard[]; // §8.2
  applied: Change[];           // auto-merged, for display
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
4. Detect delete/modify pairs **transitively over containment** (§7.2).
   Dropped on **both** sides is convergent and is *not* a conflict.
5. Apply supplied resolutions.
6. Detect name collisions in the merged result (§7.4).
7. Run `validate` over the merged schema to produce hazards (§8), then
   attribute each one to the changes that caused it (§8.2).

### 7.2 Delete/modify is transitive over containment

Comparing changes key by key finds only the case where both branches touched
*the same entity*. That misses the more common real conflict:

> I delete the `users` table. You add a column `nickname` to `users`.

Nobody touched the same entity. My change is keyed `tbl_users:__exists`; yours
is keyed `col_nickname:__exists`. No key appears on both sides, so key-wise
comparison reports a clean merge — and then tries to add a column to a table
that no longer exists. Depending on how `applyOp` is written, that either
throws during merge or silently drops the column. Both are unacceptable: one
crashes on ordinary input, the other loses a colleague's work without saying
so.

The fix is that deletion conflicts with any change to anything the deleted
entity **contains or is referenced by**. Merge builds an ownership map from
the base schema — table owns its columns, its constraints, its indexes;
column is referenced by constraints and indexes covering it — and a
`delete_modify` conflict is raised when one side deletes an entity and the
other side changes, adds, or removes anything in its dependency closure.

Concretely, dropping a table conflicts with: renaming or retyping any of its
columns, adding a column to it, adding or altering a constraint or index on
it, and adding a foreign key from anywhere that references it. Dropping a
column conflicts with: any change to that column, and any constraint or index
added on the other side that covers it.

Resolving is a genuine choice, so it is a conflict rather than a hazard:
*keep the table* (discard the deletion, retain the addition) or *drop it*
(discard the addition). The description states the trade in words — "you are
about to discard Ben's new `nickname` column" — because the cost of choosing
wrongly is someone's work, and the UI should say so before the click.

Merging is order-independent: `threeWayMerge(base, a, b)` and
`threeWayMerge(base, b, a)` produce the same schema and the same set of
conflicts, with `ours`/`theirs` labels swapped. This is asserted as a property
test.

### 7.3 Conflict taxonomy

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
| `delete_modify` | One branch dropped an entity; the other changed anything in its dependency closure (§7.2). |
| `name_collision` | Both branches contribute to two entities sharing a name in one scope. |
| `constraint_divergence` | Both altered the same constraint differently — reachable only because of `alter_constraint` (§4.1). |
| `index_divergence` | Both altered the same index differently. |

Convergent cases that are deliberately **not** conflicts: identical renames,
identical retypes, both dropping the same entity, and edits to different
attributes of the same entity (§6.1).

### 7.4 The name collision case

Two branches independently rename *different* columns to the same final name.
No entity conflicts with any other entity — each side's change is unambiguous
in isolation — yet the merged schema has two columns called `contact_email` in
one table and is invalid.

This surfaces as a `name_collision` **conflict** rather than a hazard, because
resolving it requires a human to choose names; there is no mechanical fix.
When a duplicate name arises entirely from one branch's own changes, it is that
branch's pre-existing bug and is reported as a hazard instead.

### 7.5 Resolutions

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

### 8.1 Hazard taxonomy

| Class | Severity | Detects |
| --- | --- | --- |
| `dangling_foreign_key` | error | FK references a table or column that no longer exists. |
| `constraint_on_missing_column` | error | Any constraint references a dropped column — including a `CHECK` whose `Expression.columnIds` names one (§3.4). |
| `index_on_missing_column` | error | Index covers, or has a `where` predicate over, a dropped column. |
| `duplicate_name` | error | Two tables, or two columns in one table, share a name. |
| `duplicate_constraint_name` | error | Two constraints share a name — Postgres namespaces these per schema, not per table. |
| `duplicate_index_name` | error | Two indexes share a name, same reason. |
| `multiple_primary_keys` | error | A table has more than one primary key constraint. |
| `primary_key_nullable` | error | A column in the primary key is nullable. |
| `default_type_mismatch` | error | A column's default is incompatible with its type — `'hello'` on an `int`, or a bare string on a `numeric`. |
| `foreign_key_target_not_unique` | error | An FK references columns not covered by a primary key or unique constraint. Postgres rejects this outright. |
| `foreign_key_type_mismatch` | error | An FK column's type differs from the referenced column's type. |
| `foreign_key_arity_mismatch` | error | An FK's local and referenced column lists differ in length. |
| `empty_table` | warning | Table has no columns. |
| `no_primary_key` | warning | Table has no primary key. |

The list grew after the first draft, which checked only for dangling
references. That version passed a schema with two primary keys, a `varchar`
default on an integer column, and a foreign key pointing at a non-unique
column — all of which Postgres rejects at `ALTER` time. A validator that
approves a migration the database then refuses is worse than no validator,
because the user trusted it. The rule adopted: if Postgres would reject the
DDL, `validate` must catch it first.

**Why this is a separate pass.** A merge with zero conflicts can still produce a
broken schema:

> I change `users.id` from `int` to `uuid`. You add a foreign key from
> `orders.user_id`, which is an `int`, to `users.id`.

Nothing is deleted, so §7.2's containment check does not fire. Nothing is
edited twice, so no key appears on both sides. Both changes apply cleanly and
the result is a foreign key between two columns of different types, which
Postgres rejects. Validity is a property of the *combined result*, so it can
only be checked after combining.

**Where the boundary sits.** Containment (§7.2) catches combinations involving
a *deletion* — those become conflicts, because a human must choose whether the
deletion or the other change survives. Hazards are what remains: combinations
where nothing was deleted and nobody disagreed, so there is no choice to
offer, only a defect to report. If a hazard could have been a conflict, it
should have been — a choice is always better UX than a complaint. Dropping
`users.id` while another branch adds a foreign key to it therefore surfaces as
a `delete_modify` conflict, not a hazard.

`validate` also runs on every commit, so a branch cannot silently accumulate an
invalid state that only surfaces at merge time.

### 8.2 Attribution belongs to merge, not to validate

The merge screen (§12) wants to say *"Ana deleted this column, Ben added a
foreign key to it — that is why this is broken."* `validate` cannot say that.
Its whole signature is `(schema) => Hazard[]`: it sees a final state and has
no idea who produced any part of it. Asking it to name two people is asking it
to invent them.

Attribution therefore happens one layer up, in merge, which does hold both
change lists:

```ts
interface AttributedHazard extends Hazard {
  causedBy: {
    ours: Change[];    // our changes touching entities in this hazard
    theirs: Change[];  // theirs
  } | null;            // null when nothing correlates
}
```

After running `validate` on the merged schema, merge collects the entity IDs
each hazard names and correlates them against `diff(base, ours)` and
`diff(base, theirs)`. Where both sides touched the closure, the UI renders the
two-author sentence. Where only one side did — or where nothing correlates,
because the hazard predates the merge — it says less rather than guessing.

This is **correlation, not causation**: it reports who touched the entities
involved, which is not a proof of blame. The UI wording reflects that
distinction, and hazards raised on a plain commit (where there is no `ours`
and `theirs`) carry `causedBy: null` and render without attribution.

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
4. **Rename tables and columns** (§9.1.1 — before anything is created).
5. Create tables (columns only, no constraints).
6. Add columns.
7. Retype columns.
8. Alter nullability and defaults.
9. Add primary key, unique, and check constraints.
10. Add foreign keys.
11. Add indexes.
12. Drop columns.
13. Drop tables.

**Phases rather than a topological sort.** The obvious approach is to build a
dependency graph over statements and sort it — but foreign keys can be
circular (`users.org_id → orgs`, `orgs.owner_id → users`), and a topological
sort has no answer for a cycle. Separating table creation from foreign key
creation into different phases makes the ordering immune to cycles by
construction. It is less code than a graph sort *and* handles a case the graph
sort cannot.

Within phase 13, tables are dropped in reverse foreign key dependency order.

#### 9.1.1 Renames run first, and their order is not arbitrary

The first draft of this list put creates at phase 4 and renames at phase 5.
That is wrong, and it fails on an ordinary edit:

> Rename `users` to `accounts`, then create a new table called `users`.

The end state is perfectly valid — two tables, distinct names. But emitted in
that order the migration runs `CREATE TABLE users` while the old `users` still
exists, and Postgres rejects it. The same shape breaks on columns: rename
`email` to `contact_email`, then add a new `email`. Reusing a freed-up name is
not an exotic case; it is what people do when they repurpose a name during a
refactor.

Moving renames ahead of creates fixes that, but exposes a second problem
renames have among themselves:

> Rename column `a` to `b`, and column `b` to `a`.

There is no order in which two `RENAME` statements accomplish a swap. Rename
`a` first and there are momentarily two `b`s; rename `b` first and there are
two `a`s. Either way Postgres rejects the first statement. Nothing in the
phase list can help, because the conflict is *within* a phase.

So phase 4 orders renames by name dependency rather than emitting them in
arbitrary order. Build a graph over the affected scope where renaming X to
name N depends on whatever currently holds N being renamed away first, then:

- **Acyclic** — emit in dependency order. `a → b` where `b` was already
  renamed to `c` simply emits the `b → c` statement first.
- **Cyclic** — break the cycle with a temporary name. A swap emits three
  statements: `a → __tmp_1`, `b → a`, `__tmp_1 → b`. The temporary is
  generated to be collision-free against every name live at that moment,
  including other temporaries.

This is the one place a topological sort genuinely earns its keep — and it is
worth noting that it needs cycle *breaking*, not just cycle detection, which
is why the foreign-key phases above avoid graphs entirely. Different problem,
different tool.

The temporary rename is invisible in the final schema but visible in the
generated SQL, so the migration preview annotates those statements — a
reviewer who sees `__tmp_1` in a migration they are about to run deserves to
know why it is there.

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

Supabase Postgres. Three tables:

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
   nobody was wrong, the combination is. Where `causedBy` correlates changes
   from both branches (§8.2), the card names them: "Ana retyped `users.id` to
   `uuid`; Ben added a foreign key to it from an `int` column." Where it
   correlates only one side,
   or nothing, it states the defect alone rather than inventing an author.
   The wording is *touched*, never *caused* — the correlation is by entity,
   not a proof of blame.
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

**Example tests:** one per conflict class in §7.3; one per hazard class in §8;
convergent cases asserted to produce *no* conflict; rename propagation into
foreign keys and indexes; the widening relation in §9.2 across families.

**The seven cases that broke the first draft**, each now a named regression
test, because every one of them is reachable by an ordinary user and every one
was missed by the design as originally written:

1. Drop a table on one branch, add a column to it on the other → one
   `delete_modify` conflict, not a silent merge (§7.2).
2. Rename `users` to `accounts`, then create a new `users` → migration applies
   in order without a name collision (§9.1.1).
3. Swap two column names → migration emits three statements via a temporary,
   and the temporary collides with nothing (§9.1.1).
4. Edit a primary key on both branches → one `constraint_divergence` conflict,
   proving `alter_constraint` keeps identity stable (§4.1).
5. Drop a column named in a `CHECK` predicate → one
   `constraint_on_missing_column` hazard (§3.4).
6. Each new hazard class from §8: two primary keys, a string default on an
   integer column, duplicate constraint and index names, a foreign key onto a
   non-unique column, mismatched foreign key types and arity.
7. A hazard where both branches touched the closure → `causedBy` names both
   sides; a hazard on a plain commit → `causedBy` is `null` and the UI shows
   no author (§8.2).

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
