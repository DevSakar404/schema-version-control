# Schema Version Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployed web app where a team can branch a database schema, evolve it independently, see exactly what diverged, and merge back — with correct rename handling, a plain-language conflict resolution flow, and an ordered, safety-classified Postgres migration as the output.

**Architecture:** A pure `src/core/` layer holds every hard decision — diff, three-way merge, validation, rename ordering, migration planning — as functions over plain data with zero I/O. Persistence (Supabase Postgres) and UI (Next.js App Router) sit strictly outside and call in. Entities carry immutable synthetic IDs, so renames are attribute changes rather than drop-plus-add, and commits store full schema snapshots rather than operation deltas.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, React 19, Vitest, Supabase Postgres via `postgres`, Tailwind, nanoid. Deployed to Vercel.

**Reference documents:** [design.md](../design.md) is the authoritative specification — every type, algorithm, and taxonomy referenced below is defined there by section number. [decisions.md](../decisions.md) records why each choice was made; D19–D25 in particular record seven cases an earlier draft of this plan got wrong, each of which is now a named regression test.

## Global Constraints

- TypeScript `strict: true`. No `any` in `src/core/`.
- **`src/core/` imports nothing from `src/db/`, `src/app/`, or `src/components/`.** Enforced by an ESLint `no-restricted-imports` rule added in Task 1, not by convention.
- `src/core/` performs no I/O: no `fetch`, no filesystem, no database, no `Date.now()`, no `Math.random()`. Time and ID generation are injected parameters.
- All `Schema` transformations are pure and return new values. Never mutate an input.
- Every entity is identified by its `Id`. **No code may match entities by `name`.** Name is display data. This includes predicates — see `Expression` in `design.md` §3.4.
- Dependencies: only those named in the Tech Stack. Adding one requires a `decisions.md` entry justifying it.
- Every task ends with a passing test run and a commit. Never commit a red suite.
- Append to `decisions.md` whenever the build contradicts the plan. The log being *running* is part of the deliverable.

---

## File Structure

```
/
├── decisions.md                      running decision log (exists)
├── design.md                         authoritative spec (exists)
├── README.md                         setup + demo walkthrough          [T21]
├── docs/implementation-plan.md       this file
├── src/
│   ├── core/                         PURE. no I/O, no framework imports.
│   │   ├── schema.ts                 Id, ColumnType, Expression, Column,
│   │   │                             Table, Constraint, Index, Schema, lookups [T2]
│   │   ├── ids.ts                    IdGen type + nanoid impl + test counter [T2]
│   │   ├── ops.ts                    SchemaOp, applyOp, applyOps          [T3]
│   │   ├── validate.ts               Hazard, HazardClass, validate        [T4]
│   │   ├── diff.ts                   Change, diff, describeChange         [T5]
│   │   ├── history.ts                Commit, findMergeBase, aheadBehind   [T6]
│   │   ├── closure.ts                ownership/dependency closure      [T8]
│   │   ├── merge.ts                  Conflict, Resolution, MergeResult,
│   │   │                             AttributedHazard, threeWayMerge  [T7,T8,T9]
│   │   ├── safety.ts                 isWidening, classifyChange         [T10]
│   │   ├── renames.ts                orderRenames + cycle breaking      [T11]
│   │   ├── migrate.ts                Statement, plan (phase ordering)   [T12]
│   │   └── dialects/postgres.ts      renderStatement, renderExpression  [T13]
│   ├── db/
│   │   ├── client.ts                 connection                         [T14]
│   │   ├── projects.ts               read/create projects               [T14]
│   │   ├── commits.ts                append-only commit store           [T14]
│   │   └── branches.ts               branch CRUD + advanceHead (CAS)    [T14]
│   ├── app/
│   │   ├── layout.tsx, page.tsx      shell, redirect to demo        [T16,T20]
│   │   ├── p/[projectId]/page.tsx    branch list                        [T16]
│   │   ├── p/[projectId]/b/[branchId]/page.tsx   schema editor          [T17]
│   │   ├── p/[projectId]/compare/page.tsx        diff view              [T18]
│   │   ├── p/[projectId]/merge/page.tsx          merge view             [T19]
│   │   └── api/…                     routes per design.md §11           [T15]
│   ├── components/
│   │   ├── SchemaTree.tsx            tables → columns/constraints/indexes [T17]
│   │   ├── ExpressionBuilder.tsx     compose CHECK predicates by column  [T17]
│   │   ├── ChangeRow.tsx             one Change, rendered in words       [T18]
│   │   ├── ConflictCard.tsx          base/ours/theirs + 3 actions        [T19]
│   │   ├── HazardList.tsx            hazards with optional attribution   [T19]
│   │   └── MigrationPreview.tsx      SQL + safety badges + copy          [T19]
│   └── seed/demo.ts                  pre-diverged demo project          [T20]
└── tests/core/*.test.ts              one file per core module
```

`closure.ts` and `renames.ts` are separate files because each is a
self-contained algorithm with its own failure modes and its own test file —
they were folded into merge and migrate in the first draft of this plan, which
is part of why their bugs went unnoticed.

---

## Day 1 — Foundation and the schema model

### Task 1: Project scaffold and the core boundary

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.env.example`, `.gitignore`
- Create: `src/app/layout.tsx`, `src/app/page.tsx` (placeholder)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run dev`, `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 1:** Scaffold Next.js 15 with TypeScript, App Router, Tailwind, `src/` directory. Set `strict: true` and `noUncheckedIndexedAccess: true` in `tsconfig.json`.
- [ ] **Step 2:** Add Vitest with a `node` environment for `tests/core/`. Add scripts: `test`, `test:watch`, `typecheck`, `lint`.
- [ ] **Step 3:** Add the core boundary rule to `eslint.config.mjs`: for files matching `src/core/**`, `no-restricted-imports` with patterns `../db/*`, `../app/*`, `../components/*`, `next/*`, `react`.
- [ ] **Step 4:** Write `tests/core/boundary.test.ts` asserting the rule is real: read every file under `src/core/`, assert none contains an import from `db`, `app`, `components`, `next`, or `react`. A lint rule can be disabled inline; a test cannot be disabled quietly.
- [ ] **Step 5:** Run `npm run lint && npm run typecheck && npm test`. All pass.
- [ ] **Step 6:** Create `.env.example` with `DATABASE_URL=` and a comment pointing at the Supabase connection string. Commit.

```bash
git add -A && git commit -m "chore: scaffold Next.js + Vitest, enforce core purity boundary"
```

---

### Task 2: Schema types and lookups

**Files:**
- Create: `src/core/schema.ts`, `src/core/ids.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Id`, `ColumnType`, `Expression`, `Column`, `Table`, `Constraint`, `ReferentialAction`, `Index`, `Schema` (all per `design.md` §3.2); `emptySchema(): Schema`; `findTable(s, id)`, `findColumn(s, id)` returning `{ table, column } | undefined`, `columnsOf(s, tableId)`, `constraintsOf(s, tableId)`, `indexesOf(s, tableId)`; `columnsReferencedBy(c: Constraint | Index): Id[]`; `type IdGen = () => Id`, `nanoIdGen: IdGen`, `counterIdGen(prefix: string): IdGen`.

- [ ] **Step 1:** Write `tests/core/schema.test.ts` asserting: `emptySchema()` has three empty arrays; `findColumn` locates a column and returns its owning table; `findColumn` on an unknown id returns `undefined`; `counterIdGen('c')` yields `c1`, `c2`, `c3` in order.
- [ ] **Step 2:** Add `columnsReferencedBy` tests, which matter because every later pass depends on it being exhaustive: for a foreign key it returns local **and** referenced column ids; for a `CHECK` it returns `expression.columnIds`; for an index it returns `columnIds` **plus** any ids in a `where` predicate. A predicate column missed here is a dangling reference nothing downstream will catch.
- [ ] **Step 3:** Run `npm test -- schema`. Expected: FAIL, module not found.
- [ ] **Step 4:** Write the type declarations exactly as specified in `design.md` §3.2. Constraint is a discriminated union on `kind`. Constraints and indexes are flat schema-level arrays carrying `tableId` (§3.3) — do not nest them inside `Table`. `CHECK` expressions and partial index predicates use `Expression`, never a bare string (§3.4).
- [ ] **Step 5:** Run `npm test -- schema`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(core): schema model with stable entity identity`.

---

### Task 3: Schema operations

**Files:**
- Create: `src/core/ops.ts`
- Test: `tests/core/ops.test.ts`

**Interfaces:**
- Consumes: everything from `src/core/schema.ts`.
- Produces: `SchemaOp` (the 15-member union in `design.md` §4); `applyOp(schema: Schema, op: SchemaOp, mintId: IdGen): Schema`; `applyOps(schema: Schema, ops: SchemaOp[], mintId: IdGen): Schema`.

- [ ] **Step 1:** Write `tests/core/ops.test.ts`, using `counterIdGen` so every assertion is on an exact schema value. Cover:
  - each of the 15 operations produces the expected schema;
  - `applyOp` never mutates its input — assert the input is deep-equal to a pre-captured clone afterwards;
  - `rename_column` changes only `name`, leaving `id` untouched — the property the entire project rests on;
  - an operation naming an unknown id throws a descriptive error rather than silently no-op'ing.
- [ ] **Step 2:** Write the cascade tests: `drop_table` removes its columns, its constraints, its indexes, **and foreign keys in other tables that reference it**. `drop_column` removes constraints and indexes covering it, removes it from multi-column constraints without deleting a constraint that still covers other columns, and — per §3.4 — also removes any `CHECK` whose `Expression.columnIds` names it and any index whose `where` predicate names it.
- [ ] **Step 3:** Write the `alter_constraint` / `alter_index` tests (`design.md` §4.1), which exist because their absence made two conflict classes unreachable:
  - altering a primary key's `columnIds` **preserves the constraint's `id`** — assert the id before and after are identical;
  - the same edit expressed as drop-plus-add produces a *different* id, and the test asserts this explicitly so the distinction is documented in the suite;
  - a patch attempting to change `kind` or `tableId` is rejected at the type level; assert at runtime that an unknown `constraintId` throws.
- [ ] **Step 4:** Run `npm test -- ops`. Expected: FAIL.
- [ ] **Step 5:** Implement per `design.md` §4. Deletion cascade is the only cascade logic in the codebase — renames need none, because constraints, indexes, and predicates reference columns by `Id`.
- [ ] **Step 6:** Run `npm test -- ops`. Expected: PASS. Commit `feat(core): schema operations with ID-preserving alters and deletion cascade`.

---

### Task 4: Validation and hazards

**Files:**
- Create: `src/core/validate.ts`
- Test: `tests/core/validate.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Hazard`, `HazardClass`, `validate(schema: Schema): Hazard[]` per `design.md` §8.1.

Built before merge deliberately: merge consumes it, and it is independently
testable by hand-constructing broken schemas.

- [ ] **Step 1:** Write one test per row of the `design.md` §8.1 table — `dangling_foreign_key`, `constraint_on_missing_column`, `index_on_missing_column`, `duplicate_name` (both the two-tables case and the two-columns-in-one-table case), `duplicate_constraint_name`, `duplicate_index_name`, `multiple_primary_keys`, `primary_key_nullable`, `default_type_mismatch`, `foreign_key_target_not_unique`, `foreign_key_type_mismatch`, `foreign_key_arity_mismatch`, `empty_table`, `no_primary_key`. Each builds a valid schema, breaks exactly one thing, and asserts exactly one hazard of the right class and severity.
- [ ] **Step 2:** Write the predicate test specifically (D22): a `CHECK` whose `Expression.columnIds` names a column that has been removed from the schema yields `constraint_on_missing_column`. This is the case a free-text predicate would have hidden.
- [ ] **Step 3:** Write the governing test for the whole task, phrased as the rule from D23 — **if Postgres would reject the DDL, `validate` catches it first.** Table-drive it: two primary keys on one table; a `'hello'` default on an `int` column; two indexes sharing a name; an FK onto a column covered by no unique or primary key constraint; an FK whose column types differ from its target's; an FK with three local columns and two referenced ones.
- [ ] **Step 4:** Add the negative test that matters most: a fully valid multi-table schema with foreign keys, indexes, and a `CHECK` returns `[]`. A validator that fires on healthy input is worse than none.
- [ ] **Step 5:** Run `npm test -- validate`. Expected: FAIL.
- [ ] **Step 6:** Implement. Every `description` must name the specific entities involved — "index `idx_users_email` covers column `email`, which no longer exists" — because these strings render directly in the UI. **Do not add author or provenance information here**; `validate` sees only a final state, and attribution is Task 9's job (D24).
- [ ] **Step 7:** Run `npm test -- validate`. Expected: PASS. Commit `feat(core): schema validation covering what Postgres rejects`.

---

## Day 2 — Diff and merge

### Task 5: Diff engine

**Files:**
- Create: `src/core/diff.ts`
- Test: `tests/core/diff.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Change` (the union in `design.md` §6), `diff(a: Schema, b: Schema): Change[]`, `describeChange(c: Change): string`.

- [ ] **Step 1:** Write tests covering one case per `Change` kind.
- [ ] **Step 2:** Write **the load-bearing test:** rename a column, assert the diff is exactly one `column_renamed` — and explicitly assert no `column_dropped` and no `column_added` appear. This fails loudly if identity handling ever regresses.
- [ ] **Step 3:** Write the granularity tests: a column both renamed and retyped yields **two** changes, not one (`design.md` §6.1); this sets merge granularity, so it is not cosmetic. And `diff(s, s)` is `[]` for a non-trivial schema.
- [ ] **Step 4:** Write the propagation tests: a renamed column covered by a foreign key, an index, and a `CHECK` predicate produces **only** the rename — no constraint or index change — because all three reference it by id. Dropping a table reports `table_dropped` without a `column_dropped` per column.
- [ ] **Step 5:** Write the `constraint_changed` test, now reachable via `alter_constraint`: altering a primary key's column set yields one `constraint_changed`, not a drop plus an add.
- [ ] **Step 6:** Run `npm test -- diff`. Expected: FAIL. Implement, matching entities by `Id` only, emitting one change per differing attribute. Expected: PASS.
- [ ] **Step 7:** Commit `feat(core): attribute-level schema diff with native rename tracking`.

---

### Task 6: Commit history and merge base

**Files:**
- Create: `src/core/history.ts`
- Test: `tests/core/history.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Commit` per `design.md` §5; `findMergeBase(commits: Map<Id, Commit>, a: Id, b: Id): Id | null`; `aheadBehind(commits, branchHead, compareTo): { ahead: number; behind: number }`; `ancestorsOf(commits, id): Set<Id>`.

- [ ] **Step 1:** Write tests over hand-built DAGs: linear history — the base of a descendant and its ancestor is the ancestor itself; simple fork — two branches from one commit share that commit; **merge commit with two parents** — a later fork's base is found through the two-parent node, which is where naive first-parent walks break.
- [ ] **Step 2:** Write the termination tests: criss-cross (two branches that each merged the other once) returns one of the valid candidates and terminates; disconnected commits return `null`.
- [ ] **Step 3:** Write the `aheadBehind` test: a branch that has not moved while `main` advanced returns `{ ahead: 0, behind: n }`.
- [ ] **Step 4:** Run `npm test -- history`. Expected: FAIL. Implement per `design.md` §5.1 — BFS ancestor sets from both heads, take the deepest common commit. Add a `ponytail:` comment naming the quadratic ceiling. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): commit DAG with merge base resolution`.

---

### Task 7: Three-way merge — key-wise conflicts

**Files:**
- Create: `src/core/merge.ts`
- Test: `tests/core/merge.test.ts`

**Interfaces:**
- Consumes: `src/core/diff.ts`, `src/core/schema.ts`.
- Produces: `Conflict`, `ConflictClass`, `Resolution`, `MergeResult`, `threeWayMerge(base, ours, theirs, resolutions?): MergeResult` per `design.md` §7.

Covers steps 1–3 of the §7.1 algorithm. Containment (Task 8) and resolutions
plus attribution (Task 9) follow.

- [ ] **Step 1:** Write one conflict test per applicable row of `design.md` §7.3: `concurrent_rename`, `concurrent_retype`, `concurrent_nullability`, `concurrent_default`, `constraint_divergence`, `index_divergence`. Each asserts exactly one conflict, of the right class, with `base`/`ours`/`theirs` carrying the right values.
- [ ] **Step 2:** For `constraint_divergence`, construct it with `alter_constraint` on both branches (D21) and note in a comment that drop-plus-add on both sides would instead produce two additions — that is the failure this class exists to catch, and Task 8 or Task 4 must be the thing that catches *that* shape.
- [ ] **Step 3:** Write the **non**-conflict tests, where a naive implementation fails: both branches rename the same column to the *same* name → no conflict, applied once; both drop the same column → no conflict (convergent deletion); **Ana renames `email` while Ben retypes `email` → no conflict, both apply** (different attributes of one entity, §6.1 — a line-based merge tool reports a conflict here and this one must not); changes to entirely separate tables merge cleanly.
- [ ] **Step 4:** Run `npm test -- merge`. Expected: FAIL.
- [ ] **Step 5:** Implement §7.1 steps 1–3. Key changes by `(entityId, attribute)`, with `"__exists"` as the attribute for creation and deletion. Conflict `id` must be the stable `${entityId}:${attribute}` string — the UI depends on it surviving repeated previews.
- [ ] **Step 6:** Every `Conflict.description` is written in plain language naming both authors and both changes. Assert on one description string so the format cannot silently rot.
- [ ] **Step 7:** Run `npm test -- merge`. Expected: PASS. Commit `feat(core): three-way merge with attribute-level conflict detection`.

---

### Task 8: Delete/modify across containment

**Files:**
- Create: `src/core/closure.ts`
- Modify: `src/core/merge.ts`
- Test: `tests/core/closure.test.ts`, `tests/core/merge-containment.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`, Task 7's `threeWayMerge`.
- Produces: `closureOf(schema: Schema, entityId: Id): Set<Id>` — the entity plus everything it contains and everything referencing it; merge now raises `delete_modify` per `design.md` §7.2.

This is the gap recorded as D19: key-wise comparison finds only people who
touched the *same* entity, and misses the more common conflict where two
people touched *related* entities.

- [ ] **Step 1:** Write `tests/core/closure.test.ts`: the closure of a table contains its columns, its constraints, its indexes, and foreign keys in other tables pointing at it; the closure of a column contains constraints and indexes covering it, including a `CHECK` naming it in `Expression.columnIds` and an index naming it in `where`; the closure of an entity with no dependants is just itself.
- [ ] **Step 2:** Write **the headline test** in `merge-containment.test.ts`: ours drops table `users`; theirs adds column `nickname` to `users`. Assert exactly one `delete_modify` conflict. Before the fix this merged clean and then applied a column to a table that no longer existed — assert `conflicts.length === 1`, not merely that no exception was thrown.
- [ ] **Step 3:** Write the sibling shapes, each independently reachable by a real user: drop a table vs rename one of its columns; drop a table vs add an index on it; drop a table vs add a foreign key from another table referencing it; drop a column vs add a constraint covering it; drop a column vs add an index covering it.
- [ ] **Step 4:** Write the convergence guard: both branches drop the same table → **no** conflict. Over-eager closure logic breaks this first, so it belongs in the same file.
- [ ] **Step 5:** Write the asymmetry test: the drop on `ours` and the modify on `theirs` produces the same conflict as the reverse, with `ours`/`theirs` transposed.
- [ ] **Step 6:** Write the resolution-shape test: a `delete_modify` conflict offers exactly two meaningful choices — keep the entity (discard the deletion) or drop it (discard the addition) — and its `description` states in words what choosing "drop" discards, because the cost is a colleague's work.
- [ ] **Step 7:** Run `npm test -- closure merge-containment`. Expected: FAIL. Implement §7.1 step 4 and §7.2. Expected: PASS.
- [ ] **Step 8:** Commit `feat(core): delete/modify conflicts transitive over containment`.

---

### Task 9: Name collisions, resolutions, attribution, properties

**Files:**
- Modify: `src/core/merge.ts`
- Test: `tests/core/merge-resolution.test.ts`, `tests/core/merge-properties.test.ts`

**Interfaces:**
- Consumes: Tasks 7 and 8, plus `src/core/validate.ts`.
- Produces: the same `threeWayMerge` signature, now honouring `resolutions`, detecting `name_collision`, and returning `AttributedHazard[]` per `design.md` §8.2.

- [ ] **Step 1:** Write the name collision test (`design.md` §7.4): branch A renames `users.email` to `contact`, branch B renames `users.phone` to `contact`. Neither entity conflicts with any other. Assert a `name_collision` **conflict**. Then the discriminating case: one branch alone creates the duplicate → a `duplicate_name` **hazard**, not a conflict.
- [ ] **Step 2:** Write the resolution tests: `'ours'` yields our value; `'theirs'` yields theirs; `'custom'` yields a third value neither branch proposed; a resolved conflict disappears from `conflicts` and its effect appears in `schema`; an unknown `conflictId` throws rather than being ignored.
- [ ] **Step 3:** Write the hazard-through-merge test, the case `design.md` §8 exists for: ours retypes `users.id` from `int` to `uuid`; theirs adds a foreign key from `orders.user_id` (an `int`) to `users.id`. Assert `conflicts` is **empty** and `hazards` contains one `foreign_key_type_mismatch` with severity `error`. Nothing is deleted here, so containment (Task 8) correctly does not fire — that is what makes it a hazard rather than a conflict.
- [ ] **Step 3b:** Write the boundary test that pins the §8 rule in place: ours *drops* `users.id` while theirs adds a foreign key referencing it. Assert this is a `delete_modify` **conflict** and **not** a hazard. The two tests sit next to each other deliberately — they are one edit apart and land in different categories, and an implementation that blurs them will pass one and fail the other.
- [ ] **Step 4:** Write the attribution tests (D24): for the hazard in step 3, `causedBy.ours` contains the drop and `causedBy.theirs` contains the FK addition. For a hazard where only one side touched the closure, the other side's list is empty. For `validate` called directly on a commit, hazards carry no attribution — assert `validate`'s own return type has no `causedBy` field at all, so the pure function stays anonymous and provenance lives only in merge.
- [ ] **Step 5:** Write `merge-properties.test.ts` per `design.md` §13: merging a branch into itself is a no-op; merging with no divergence fast-forwards exactly; `threeWayMerge(base, a, b)` and `threeWayMerge(base, b, a)` yield the same schema and the same conflict keys; a schema reachable by valid operations validates clean.
- [ ] **Step 6:** Run `npm test -- merge`. Expected: FAIL. Implement §7.1 steps 5–7 and §8.2. Expected: PASS.
- [ ] **Step 7:** Commit `feat(core): custom resolutions, name collisions, hazard attribution`.

---

## Day 3 — Migration output, persistence, API

Densest day in the plan. Tasks 10 and 11 are small and pure; 14 and 15 are
mechanical. If the day overruns, Task 15 slides to Day 4 ahead of UI work.

### Task 10: Type widening and safety classification

**Files:**
- Create: `src/core/safety.ts`
- Test: `tests/core/safety.test.ts`

**Interfaces:**
- Consumes: `ColumnType` from `src/core/schema.ts`, `Change` from `src/core/diff.ts`.
- Produces: `Safety = 'safe' | 'destructive' | 'lossy' | 'blocking'`; `isWidening(from: ColumnType, to: ColumnType): boolean`; `classifyChange(c: Change): { safety: Safety; note: string | null }`.

- [ ] **Step 1:** Write a table test over the `design.md` §9.2 relation: `smallint→int→bigint` widens and the reverse does not; `varchar(n)→text` widens; `text→varchar(n)` does not; `varchar(50)→varchar(100)` widens and `varchar(100)→varchar(50)` does not; `numeric` widens only when both precision and scale are non-decreasing; every cross-family pair is not widening.
- [ ] **Step 2:** Write the classification tests: `DROP COLUMN` and `DROP TABLE` are `destructive`; `ADD COLUMN` nullable is `safe`; `ADD COLUMN NOT NULL` without a default is `lossy`; `SET NOT NULL` on an existing nullable column is `lossy`; a rename is `safe`; a narrowing retype is `lossy`; a retype requiring a table rewrite is `blocking`.
- [ ] **Step 3:** Run `npm test -- safety`. Expected: FAIL. Implement — every non-`safe` classification sets `note` explaining why in one sentence, since it renders next to the badge. Expected: PASS.
- [ ] **Step 4:** Commit `feat(core): type widening relation and migration safety classification`.

---

### Task 11: Rename ordering and cycle breaking

**Files:**
- Create: `src/core/renames.ts`
- Test: `tests/core/renames.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`, `Change` from `src/core/diff.ts`.
- Produces: `orderRenames(renames: RenameStep[], occupiedNames: Set<string>, mintTemp: (n: number) => string): RenameStep[]`, where `RenameStep = { entityId: Id; scope: string; from: string; to: string }` and `scope` is `'table'` or a `tableId`.

The algorithm recorded as D20. Its own file and its own task because it is a
self-contained graph problem that a first draft missed entirely.

- [ ] **Step 1:** Write the acyclic ordering test: renaming `a → b` where `b` is itself being renamed to `c` emits the `b → c` step **first**. Assert on the exact output order, not just membership.
- [ ] **Step 2:** Write **the swap test**: `a → b` and `b → a` in one scope emits three steps — `a → __tmp_1`, `b → a`, `__tmp_1 → b`. There is no valid two-step ordering, so an implementation that returns two steps is wrong even if the final names are right.
- [ ] **Step 3:** Write the three-cycle test (`a→b`, `b→c`, `c→a`) — one temporary suffices — and the two-independent-cycles test, asserting the temporaries do not collide with each other.
- [ ] **Step 4:** Write the temporary collision test: a schema that already contains a column literally named `__tmp_1` must not have it clobbered. `mintTemp` skips names live at that moment, including previously minted temporaries.
- [ ] **Step 5:** Write the scope test: renaming `a → b` on `users` and `b → a` on `orders` is **not** a cycle — column names are scoped per table, so both emit as single steps with no temporary.
- [ ] **Step 6:** Run `npm test -- renames`. Expected: FAIL. Implement per `design.md` §9.1.1: build a graph where renaming to name `N` depends on whatever currently holds `N` being renamed away, topologically sort, break cycles with a temporary. Expected: PASS.
- [ ] **Step 7:** Commit `feat(core): rename ordering with cycle breaking via temporaries`.

---

### Task 12: Migration planner

**Files:**
- Create: `src/core/migrate.ts`
- Test: `tests/core/migrate.test.ts`

**Interfaces:**
- Consumes: `src/core/diff.ts`, `src/core/safety.ts`, `src/core/renames.ts`, `src/core/schema.ts`.
- Produces: `Statement` per `design.md` §9; `plan(from: Schema, to: Schema): Statement[]` (structured only — `sql` is filled by Task 13).

- [ ] **Step 1:** Write **the name-reuse test** (D20), which the original phase order failed: rename table `users` to `accounts`, then create a new table called `users`. Assert the `RENAME` statement precedes the `CREATE`. Repeat for columns: rename `email` to `contact_email`, add a new `email`. Both crash on a real database if emitted in the wrong order, so assert on index positions, not set membership.
- [ ] **Step 2:** Write the remaining ordering tests: a new table and a foreign key into it — `CREATE TABLE` precedes `ADD CONSTRAINT ... FOREIGN KEY`; dropping a column covered by an index — `DROP INDEX` precedes `DROP COLUMN`; renaming and retyping the same column — the rename precedes the retype; dropping two tables where one references the other — the referencing table drops first.
- [ ] **Step 3:** Write **the circular foreign key test**: `users.org_id → orgs.id` alongside `orgs.owner_id → users.id` produces a valid plan and terminates. This is the case a topological sort cannot handle and phase separation handles for free (`design.md` §9.1).
- [ ] **Step 4:** Write the integration test with Task 11: a plan containing a column swap emits the three-statement temporary sequence in phase 4, ahead of every create.
- [ ] **Step 5:** Write the round-trip property test: for a set of from/to pairs, simulate applying the plan to `from` against the model and assert the result deep-equals `to`. Include the swap and name-reuse cases — these are exactly the ones where the final schema is right but the path is invalid, so a naive round-trip check that ignores order would pass while the migration crashes.
- [ ] **Step 6:** Write the empty case: `plan(s, s)` is `[]`.
- [ ] **Step 7:** Run `npm test -- migrate`. Expected: FAIL. Implement the 13 fixed phases from `design.md` §9.1, delegating phase 4 to `orderRenames`. Do **not** build one dependency graph over all statements — phases are immune to foreign key cycles by construction, and the circular test will fail if this is ignored. Expected: PASS.
- [ ] **Step 8:** Commit `feat(core): phase-ordered migration planner`.

---

### Task 13: Postgres renderer

**Files:**
- Create: `src/core/dialects/postgres.ts`
- Modify: `src/core/migrate.ts` (populate `Statement.sql`)
- Test: `tests/core/postgres.test.ts`

**Interfaces:**
- Consumes: `Statement` from `src/core/migrate.ts`, `Expression` from `src/core/schema.ts`.
- Produces: `renderExpression(e: Expression, schema: Schema): string`, `renderStatement(s: Statement, schema: Schema): string`, `renderMigration(statements: Statement[], schema: Schema): string`.

- [ ] **Step 1:** Write `renderExpression` tests (§3.4): a template `'{c1} > 0'` renders with the column's **current** name; after a rename, the same stored `Expression` renders with the new name and requires no migration of the constraint itself. That second assertion is the payoff of storing predicates by reference.
- [ ] **Step 2:** Write exact-SQL tests for: create table, add column with and without default, **`ALTER TABLE ... RENAME COLUMN`** (never a drop plus an add), alter type with `USING` where a cast is needed, set/drop not null, add and drop each constraint kind including `CHECK`, create unique and partial indexes, drop column, drop table.
- [ ] **Step 3:** Write the identifier tests: names are double-quoted so reserved words and mixed case survive; a table named `users"; DROP TABLE x; --` renders with the quote escaped, not interpolated raw. Names are user input and this is a trust boundary.
- [ ] **Step 4:** Write the temporary-rename annotation test: statements produced by cycle breaking (Task 11) carry a comment explaining the temporary, so a reviewer seeing `__tmp_1` in a migration they are about to run knows why it exists.
- [ ] **Step 5:** Run `npm test -- postgres`. Expected: FAIL. Implement — `renderMigration` separates statements by blank lines with a leading comment per safety class so the copied SQL reads standalone. Expected: PASS.
- [ ] **Step 6:** Commit `feat(core): Postgres DDL renderer with predicate substitution and escaping`.

---

### Task 14: Persistence

**Files:**
- Create: `supabase/migrations/0001_init.sql`, `src/db/client.ts`, `src/db/projects.ts`, `src/db/commits.ts`, `src/db/branches.ts`
- Test: `tests/db/branches.test.ts`

**Interfaces:**
- Consumes: `Commit` from `src/core/history.ts`, `Schema` from `src/core/schema.ts`.
- Produces: `createProject(name)`, `getProject(id)`; `insertCommit(c: Commit)`, `getCommit(id)`, `getCommitsForProject(projectId): Map<Id, Commit>`; `listBranches(projectId)`, `createBranch(projectId, name, headCommitId)`, `advanceHead(branchId, expected: Id, next: Id): Branch | null`.

- [ ] **Step 1:** Write `supabase/migrations/0001_init.sql` creating the three tables from `design.md` §10, with `unique (project_id, name)` on branches and a foreign key from `branches.head_commit_id` to `commits.id`.
- [ ] **Step 2:** Write `tests/db/branches.test.ts` against a real database from `DATABASE_URL`, skipped when the variable is unset so the core suite runs anywhere. Assert: `advanceHead` succeeds when `expected` matches the current head; **returns `null` when `expected` is stale**; two concurrent calls from the same expected head produce exactly one success and one `null`.
- [ ] **Step 3:** Run `npm test -- branches`. Expected: FAIL. Implement — `advanceHead` is the single compare-and-swap from `design.md` §10.1, never read-then-write. `insertCommit` is append-only; expose no update or delete. Expected: PASS.
- [ ] **Step 4:** Commit `feat(db): append-only commits and compare-and-swap branch heads`.

---

### Task 15: HTTP API

**Files:**
- Create: the seven routes in `src/app/api/` per `design.md` §11
- Test: `tests/api/merge.test.ts`

**Interfaces:**
- Consumes: all of `src/core/`, all of `src/db/`.
- Produces: the endpoints in `design.md` §11. Every response body is `{ data }` or `{ error: { code, message } }`.

- [ ] **Step 1:** Write tests asserting: `/api/merge/preview` returns conflicts, attributed hazards, and a migration, and **writes nothing** (assert commit count unchanged); posting resolutions changes the returned schema; `/api/merge` with a stale `expectedHead` returns `409` naming the new head; `/api/merge` with unresolved conflicts returns `422` rather than committing a partial merge; `/api/merge` with an `error`-severity hazard returns `422`.
- [ ] **Step 2:** Run `npm test -- api`. Expected: FAIL.
- [ ] **Step 3:** Implement. Validate request bodies at the boundary and return `400` with a specific message — this is the trust boundary between the browser and the pure core, and the core assumes well-formed input.
- [ ] **Step 4:** Run `npm test -- api`. Expected: PASS. Commit `feat(api): schema, compare, preview, and merge endpoints`.

---

## Day 4 — Interface

### Task 16: App shell and branch list

**Files:** `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/p/[projectId]/page.tsx`

- [ ] **Step 1:** Build the branch list per `design.md` §12: every branch with ahead/behind counts against `main`, last commit message and author, and *Compare* and *Merge* actions. `main` is visually distinguished.
- [ ] **Step 2:** Add branch creation from any branch's head, with inline validation on duplicate names using the `unique (project_id, name)` error rather than a separate lookup.
- [ ] **Step 3:** Verify manually that ahead/behind is correct for a branch that has diverged in both directions.
- [ ] **Step 4:** Commit `feat(ui): project shell and branch list`.

---

### Task 17: Schema editor

**Files:** `src/app/p/[projectId]/b/[branchId]/page.tsx`, `src/components/SchemaTree.tsx`, `src/components/ExpressionBuilder.tsx`

- [ ] **Step 1:** Render the schema at branch head — tables, and per table its columns, constraints, and indexes.
- [ ] **Step 2:** Wire every edit to a `SchemaOp` accumulated in client state, with a running "N uncommitted changes" indicator. Committing sends the operation list with `expectedHead`; a `409` surfaces as "this branch moved" with a refresh action.
- [ ] **Step 3:** **Editing an existing constraint or index must emit `alter_constraint` / `alter_index`, never drop-plus-add** (D21). This is the single most important line in the task: if the editor gets it wrong, the ID churns, `constraint_divergence` never fires, and two branches editing one primary key silently produce a table with two. Reserve drop-plus-add for the user explicitly deleting a rule and adding a different one.
- [ ] **Step 4:** Build `ExpressionBuilder` so `CHECK` predicates are composed by picking columns and an operator, producing `Expression { template, columnIds }` (§3.4). Users never type raw SQL into a predicate — that is the accepted limitation from D22, and the builder is what makes it tolerable.
- [ ] **Step 5:** Run `validate` on the pending schema client-side and show hazards live, so a user cannot commit a broken schema and discover it at merge time.
- [ ] **Step 6:** Confirm destructive edits inline, naming what depends on the entity — `closureOf` from Task 8 already knows.
- [ ] **Step 7:** Commit `feat(ui): schema editor with ID-preserving constraint edits`.

---

### Task 18: Diff view

**Files:** `src/app/p/[projectId]/compare/page.tsx`, `src/components/ChangeRow.tsx`

- [ ] **Step 1:** Render `Change[]` from `/api/compare`, grouped by table, using `describeChange` for the wording.
- [ ] **Step 2:** **Render renames as renames** — `email → contact_email` on one row, never a red drop beside a green add. This is the visible payoff of the identity decision and should be obvious to someone scanning the screen.
- [ ] **Step 3:** Encode change kind with both colour and an icon or label, so the diff is not colour-dependent.
- [ ] **Step 4:** Handle the empty case: "these branches are identical" rather than a blank panel.
- [ ] **Step 5:** Commit `feat(ui): branch comparison view`.

---

### Task 19: Merge view

**Files:** `src/app/p/[projectId]/merge/page.tsx`, `src/components/ConflictCard.tsx`, `src/components/HazardList.tsx`, `src/components/MigrationPreview.tsx`

The screen the whole project builds toward.

- [ ] **Step 1:** Build `ConflictCard`: the plain-language description, base/ours/theirs side by side with branch names and authors, and three actions — *Take ours*, *Take theirs*, *Write my own*. The custom input is typed to the attribute: a text field for a name, a type picker for a type.
- [ ] **Step 2:** Give `delete_modify` its own card treatment (D19). Its choice is not symmetric with a rename conflict — one option discards a colleague's whole addition — so the card states what is lost before the click, not after.
- [ ] **Step 3:** Wire resolutions to re-post `/api/merge/preview` so the merged result and migration update as the user decides. The endpoint is read-only, so this carries no write risk.
- [ ] **Step 4:** Build `HazardList` as a visually distinct section with a one-line explanation of why it is separate: nobody disagreed, the combination is invalid. Where `causedBy` names both sides, render the two-author sentence; where it names one or none, state the defect alone. **Wording is "touched", never "caused"** (D24) — the correlation is by entity, not proof of blame.
- [ ] **Step 5:** Build `MigrationPreview`: rendered SQL with a safety badge per statement, the `note` shown for anything not `safe`, a copy button, and a summary counting destructive and lossy statements. Temporary renames carry their explanatory comment (Task 13 step 4).
- [ ] **Step 6:** Disable the merge button while any conflict is unresolved or any `error` hazard remains, **with the reason on the button itself**, not hidden in a tooltip.
- [ ] **Step 7:** Handle `409` from `/api/merge` by explaining that the branch moved and re-running the preview against the new head, **preserving the resolutions the user already made**. Losing their work here would be the cruellest possible failure.
- [ ] **Step 8:** Commit `feat(ui): merge view with conflict resolution, hazards, and migration preview`.

---

## Day 5 — First run, resilience, ship

### Task 20: Seeded demo, empty states, error handling

**Files:** `src/seed/demo.ts`, `src/app/api/seed/route.ts`, `src/app/page.tsx`, error and loading boundaries

- [ ] **Step 1:** Build a demo project of six or seven realistic related tables (`users`, `organizations`, `orders`, `order_items`, `products`, `payments`) with real foreign keys, indexes, and at least one `CHECK` predicate.
- [ ] **Step 2:** Plant scenario one — a **conflict**: one branch renames `users.email` to `contact_email` and adds an index on it; the other retypes `users.email` to `text` and adds a `NOT NULL` column. Yields a genuine `concurrent_*` conflict, a clean auto-merge, and a `lossy` migration statement.
- [ ] **Step 3:** Plant scenario two — a **zero-conflict merge with a hazard**: one branch retypes `users.id` to `uuid`, the other adds a foreign key to it from an `int` column. Nothing is deleted, nothing is edited twice, and the result is still invalid. The hardest thing the tool does, reachable in one click, with attribution naming both branches.
- [ ] **Step 4:** Plant scenario three — a **containment conflict** (D19): one branch drops a table while the other adds a column to it. This is the case most tools get wrong and it costs nothing to seed.
- [ ] **Step 5:** Route `/` to the demo project. Add `error.tsx` and `loading.tsx` boundaries. Every empty state says what to do next, never just "no data".
- [ ] **Step 6:** Make the seed idempotent and re-runnable, with a visible "reset demo" action so a reviewer who breaks it can recover without redeploying.
- [ ] **Step 7:** Commit `feat: seeded demo project, first-run experience, error boundaries`.

---

### Task 21: README, deploy, and closing the decision log

**Files:** `README.md`, `decisions.md`

- [ ] **Step 1:** Replace the README's Status section with real content: the live URL; setup in one block (clone, `npm install`, copy `.env.example`, run the Supabase migration, `npm run dev`); how to run tests; a guided walkthrough naming the three planted scenarios from Task 20; the non-goals from `design.md` §14.
- [ ] **Step 2:** Verify setup from a clean clone in a fresh directory, following only the README. Fix every step that required knowledge not written down. This is a scored criterion and the only way to test it is to actually do it.
- [ ] **Step 3:** Deploy to Vercel with the Supabase connection string set. Run the seed against production. Click through all three planted scenarios on the live URL.
- [ ] **Step 4:** Append a "Day 5 — what surprised me" section to `decisions.md`: every place the build contradicted the plan, every shortcut taken under time pressure and what it would cost to undo, and what comes next. D19–D25 set the precedent — an honest record of being wrong reads better than a log where every call was right first time.
- [ ] **Step 5:** Run `npm run lint && npm run typecheck && npm test` one final time. Commit and push.

---

## Self-review against the spec

| Spec | Task |
| --- | --- |
| §3.1–3.3 schema model, identity, structural choices | T2 |
| §3.4 `Expression` predicates | T2, T3, T4, T13, T17 |
| §4 operations and deletion cascade | T3 |
| §4.1 `alter_constraint` / `alter_index` | T3, T5, T7, T17 |
| §5 commits, snapshots, merge base | T6, T14 |
| §6 diff, attribute granularity | T5 |
| §7.1 merge algorithm | T7, T8, T9 |
| §7.2 containment delete/modify | T8 |
| §7.3 conflict taxonomy | T7, T8, T9 |
| §7.4 name collision | T9 |
| §7.5 resolutions | T9, T19 |
| §8.1 hazard taxonomy | T4 |
| §8.2 attribution | T9, T19 |
| §9.1 phase ordering | T12 |
| §9.1.1 rename ordering and cycles | T11, T12 |
| §9.2 safety classification | T10 |
| §9.3 dialect | T13 |
| §10 persistence and CAS | T14 |
| §11 HTTP API | T15 |
| §12 interface, all four screens, first run | T16–T20 |
| §13 testing, examples and properties | T4–T13, T9 |
| §14 non-goals | not built, documented in T21 |

**The seven regression cases from D19–D25**, each pinned to the task that
proves it:

| Case | Task | Assertion |
| --- | --- | --- |
| Drop table vs add column to it | T8 §2 | one `delete_modify`, not a clean merge |
| Rename then reuse the freed name | T12 §1 | `RENAME` emits before `CREATE` |
| Swap two names | T11 §2 | three statements via `__tmp_1` |
| Edit a primary key on both branches | T3 §3, T7 §2 | id preserved, `constraint_divergence` fires |
| Drop a column named in a `CHECK` | T4 §2 | `constraint_on_missing_column` |
| Postgres-rejected schemas | T4 §3 | seven new hazard classes |
| Hazard attribution | T9 §4 | `causedBy` in merge, absent from `validate` |

**Riskiest tasks, ranked:** T8 and T9 (containment and attribution — the two
places the design was most recently wrong), T7 (the merge core), T12 (phase
ordering), T19 (the largest single piece of interface work). T16–T18 are the
compressible ones; T7, T8, T9, and T19 are not. If Day 4 runs short, ship a
plainer schema editor — never a plainer merge screen.
