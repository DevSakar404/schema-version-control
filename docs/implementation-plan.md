# Schema Version Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployed web app where a team can branch a database schema, evolve it independently, see exactly what diverged, and merge back — with correct rename handling, a plain-language conflict resolution flow, and an ordered, safety-classified Postgres migration as the output.

**Architecture:** A pure `src/core/` layer holds every hard decision — diff, three-way merge, validation, migration planning — as functions over plain data with zero I/O. Persistence (Supabase Postgres) and UI (Next.js App Router) sit strictly outside and call in. Entities carry immutable synthetic IDs, so renames are attribute changes rather than drop-plus-add, and commits store full schema snapshots rather than operation deltas.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, React 19, Vitest, Supabase Postgres via `postgres` (or `@supabase/supabase-js`), Tailwind, nanoid. Deployed to Vercel.

**Reference documents:** [design.md](../design.md) is the authoritative specification — every type, algorithm, and taxonomy referenced below is defined there by section number. [decisions.md](../decisions.md) records why each choice was made. Read both before starting.

## Global Constraints

- TypeScript `strict: true`. No `any` in `src/core/`.
- **`src/core/` imports nothing from `src/db/`, `src/app/`, or `src/components/`.** Enforced by an ESLint `no-restricted-imports` rule added in Task 1, not by convention.
- `src/core/` performs no I/O: no `fetch`, no filesystem, no database, no `Date.now()`, no `Math.random()`. Time and ID generation are injected parameters.
- All `Schema` transformations are pure and return new values. Never mutate an input.
- Every entity is identified by its `Id`. **No code may match entities by `name`.** Name is display data.
- Dependencies: only those named in the Tech Stack. Adding one requires a `decisions.md` entry justifying it.
- Every task ends with a passing test run and a commit. Never commit a red suite.
- Append to `decisions.md` whenever the build contradicts the plan. The log being *running* is part of the deliverable.

---

## File Structure

```
/
├── decisions.md                      running decision log (exists)
├── design.md                         authoritative spec (exists)
├── README.md                         setup + demo walkthrough          [T19]
├── docs/implementation-plan.md       this file
├── src/
│   ├── core/                         PURE. no I/O, no framework imports.
│   │   ├── schema.ts                 Id, ColumnType, Column, Table,
│   │   │                             Constraint, Index, Schema, lookups  [T2]
│   │   ├── ids.ts                    IdGen type + nanoid impl + test counter [T2]
│   │   ├── ops.ts                    SchemaOp, applyOp, applyOps         [T3]
│   │   ├── validate.ts               Hazard, HazardClass, validate       [T4]
│   │   ├── diff.ts                   Change, diff                        [T5]
│   │   ├── history.ts                Commit, findMergeBase, aheadBehind  [T6]
│   │   ├── merge.ts                  Conflict, Resolution, MergeResult,
│   │   │                             threeWayMerge                    [T7,T8]
│   │   ├── safety.ts                 isWidening, classifyStatement       [T9]
│   │   ├── migrate.ts                Statement, plan (phase ordering)   [T10]
│   │   └── dialects/postgres.ts      render                             [T11]
│   ├── db/
│   │   ├── client.ts                 connection                         [T12]
│   │   ├── projects.ts               read/create projects               [T12]
│   │   ├── commits.ts                append-only commit store           [T12]
│   │   └── branches.ts               branch CRUD + advanceHead (CAS)    [T12]
│   ├── app/
│   │   ├── layout.tsx, page.tsx      shell, redirect to demo        [T14,T18]
│   │   ├── p/[projectId]/page.tsx    branch list                        [T14]
│   │   ├── p/[projectId]/b/[branchId]/page.tsx   schema editor          [T15]
│   │   ├── p/[projectId]/compare/page.tsx        diff view              [T16]
│   │   ├── p/[projectId]/merge/page.tsx          merge view             [T17]
│   │   └── api/…                     routes per design.md §11           [T13]
│   ├── components/
│   │   ├── SchemaTree.tsx            tables → columns/constraints/indexes [T15]
│   │   ├── ChangeRow.tsx             one Change, rendered in words       [T16]
│   │   ├── ConflictCard.tsx          base/ours/theirs + 3 actions        [T17]
│   │   ├── HazardList.tsx            hazards, visually distinct          [T17]
│   │   └── MigrationPreview.tsx      SQL + safety badges + copy          [T17]
│   └── seed/demo.ts                  pre-diverged demo project          [T18]
└── tests/core/*.test.ts              one file per core module
```

`src/core/` splits by responsibility, not by layer, and each file is one
algorithm from `design.md`. Files that change together — a type and the
function that produces it — live together.

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
- [ ] **Step 3:** Add the core boundary rule to `eslint.config.mjs`: for files matching `src/core/**`, `no-restricted-imports` with patterns `../db/*`, `../app/*`, `../components/*`, `next/*`, `react`. This is the architectural constraint from `design.md` §13 made mechanical.
- [ ] **Step 4:** Write `tests/core/boundary.test.ts` asserting the rule is real: read every file under `src/core/`, assert none contains an import from `db`, `app`, `components`, `next`, or `react`. A lint rule can be disabled inline; a test cannot be disabled quietly.
- [ ] **Step 5:** Run `npm run lint && npm run typecheck && npm test`. All pass (boundary test passes trivially on an empty `core/`).
- [ ] **Step 6:** Create `.env.example` with `DATABASE_URL=` and a comment pointing at the Supabase connection string. Commit.

```bash
git init && git add -A && git commit -m "chore: scaffold Next.js + Vitest, enforce core purity boundary"
```

---

### Task 2: Schema types and lookups

**Files:**
- Create: `src/core/schema.ts`, `src/core/ids.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Id`, `ColumnType`, `Column`, `Table`, `Constraint`, `ReferentialAction`, `Index`, `Schema` (all per `design.md` §3.2); `emptySchema(): Schema`; `findTable(s, id)`, `findColumn(s, id)` returning `{ table, column } | undefined`, `columnsOf(s, tableId)`, `constraintsOf(s, tableId)`, `indexesOf(s, tableId)`; `type IdGen = () => Id`, `nanoIdGen: IdGen`, `counterIdGen(prefix: string): IdGen`.

- [ ] **Step 1:** Write `tests/core/schema.test.ts` asserting: `emptySchema()` has three empty arrays; `findColumn` locates a column and returns its owning table; `findColumn` on an unknown id returns `undefined`; `counterIdGen('c')` yields `c1`, `c2`, `c3` in order.
- [ ] **Step 2:** Run `npm test -- schema`. Expected: FAIL, module not found.
- [ ] **Step 3:** Write the type declarations exactly as specified in `design.md` §3.2, plus the lookup helpers. Constraint is a discriminated union on `kind`. Constraints and indexes are flat schema-level arrays carrying `tableId` (§3.3) — do not nest them inside `Table`.
- [ ] **Step 4:** Run `npm test -- schema`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): schema model with stable entity identity`.

---

### Task 3: Schema operations

**Files:**
- Create: `src/core/ops.ts`
- Test: `tests/core/ops.test.ts`

**Interfaces:**
- Consumes: everything from `src/core/schema.ts`.
- Produces: `SchemaOp` (the 13-member union in `design.md` §4); `applyOp(schema: Schema, op: SchemaOp, mintId: IdGen): Schema`; `applyOps(schema: Schema, ops: SchemaOp[], mintId: IdGen): Schema`.

- [ ] **Step 1:** Write `tests/core/ops.test.ts`, using `counterIdGen` so every assertion is on an exact schema value. Cover:
  - each of the 13 operations produces the expected schema;
  - `applyOp` never mutates its input — assert the input is deep-equal to a pre-captured clone afterwards;
  - `rename_column` changes only `name`, leaving `id` untouched — this is the property the entire project rests on;
  - `drop_table` cascades: its columns, its constraints, its indexes, **and foreign keys in other tables that reference it** are all removed;
  - `drop_column` cascades to constraints and indexes covering it, and removes it from multi-column constraints without deleting a constraint that still covers other columns;
  - an operation naming an unknown id throws a descriptive error rather than silently no-op'ing.
- [ ] **Step 2:** Run `npm test -- ops`. Expected: FAIL.
- [ ] **Step 3:** Implement per `design.md` §4. Deletion cascade is the only cascade logic in the codebase — renames need none, because constraints and indexes reference columns by `Id`.
- [ ] **Step 4:** Run `npm test -- ops`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): schema operations with deletion cascade`.

---

### Task 4: Validation and hazards

**Files:**
- Create: `src/core/validate.ts`
- Test: `tests/core/validate.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Hazard`, `HazardClass`, `validate(schema: Schema): Hazard[]` per `design.md` §8.

Built before merge deliberately: merge consumes it, and it is independently
testable by hand-constructing broken schemas.

- [ ] **Step 1:** Write `tests/core/validate.test.ts` with one test per row of the `design.md` §8 table — `dangling_foreign_key`, `constraint_on_missing_column`, `index_on_missing_column`, `duplicate_name` (both the two-tables case and the two-columns-in-one-table case), `primary_key_nullable`, `empty_table`, `no_primary_key` — each built by hand-editing a valid schema into exactly one broken state, asserting exactly one hazard of the right class and severity.
- [ ] **Step 2:** Add the negative test that matters most: a fully valid multi-table schema with foreign keys and indexes returns `[]`. A validator that fires on healthy input is worse than none.
- [ ] **Step 3:** Run `npm test -- validate`. Expected: FAIL.
- [ ] **Step 4:** Implement. Every `description` must name the specific entities involved — "index `idx_users_email` covers column `email`, which no longer exists" — because these strings render directly in the UI (`design.md` §12).
- [ ] **Step 5:** Run `npm test -- validate`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(core): schema validation with hazard taxonomy`.

---

## Day 2 — Diff and merge

### Task 5: Diff engine

**Files:**
- Create: `src/core/diff.ts`
- Test: `tests/core/diff.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Change` (the 15-member union in `design.md` §6), `diff(a: Schema, b: Schema): Change[]`, and `describeChange(c: Change): string` for UI rendering.

- [ ] **Step 1:** Write `tests/core/diff.test.ts` covering:
  - one test per `Change` kind;
  - **the load-bearing test:** rename a column, then assert the diff is exactly one `column_renamed` — and explicitly assert that no `column_dropped` and no `column_added` appear. This is the test that fails loudly if identity handling ever regresses;
  - a column both renamed and retyped yields **two** changes, not one (`design.md` §6.1) — this sets merge granularity;
  - `diff(s, s)` is `[]` for a non-trivial schema;
  - a renamed column that is covered by a foreign key and an index produces only the rename — no constraint or index change — because those reference it by id;
  - dropping a table reports `table_dropped` without also reporting a `column_dropped` for each of its columns.
- [ ] **Step 2:** Run `npm test -- diff`. Expected: FAIL.
- [ ] **Step 3:** Implement. Match entities by `Id` only. Emit one change per differing attribute.
- [ ] **Step 4:** Run `npm test -- diff`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): attribute-level schema diff with native rename tracking`.

---

### Task 6: Commit history and merge base

**Files:**
- Create: `src/core/history.ts`
- Test: `tests/core/history.test.ts`

**Interfaces:**
- Consumes: `src/core/schema.ts`.
- Produces: `Commit` per `design.md` §5; `findMergeBase(commits: Map<Id, Commit>, a: Id, b: Id): Id | null`; `aheadBehind(commits, branchHead, compareTo): { ahead: number; behind: number }`; `ancestorsOf(commits, id): Set<Id>`.

- [ ] **Step 1:** Write `tests/core/history.test.ts` over hand-built DAGs:
  - linear history — the base of a descendant and its ancestor is the ancestor itself;
  - simple fork — two branches from one commit share that commit as base;
  - **merge commit with two parents** — a later fork's base is found correctly through the two-parent node, which is where naive first-parent walks break;
  - criss-cross (two branches that each merged the other once) — assert the returned base is one of the valid candidates and that the function terminates;
  - disconnected commits return `null`;
  - `aheadBehind` returns `{ ahead: 0, behind: n }` for a branch that has not moved while `main` advanced.
- [ ] **Step 2:** Run `npm test -- history`. Expected: FAIL.
- [ ] **Step 3:** Implement per `design.md` §5.1 — BFS ancestor sets from both heads, take the deepest common commit. Add a `ponytail:` comment naming the quadratic ceiling and the upgrade path.
- [ ] **Step 4:** Run `npm test -- history`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): commit DAG with merge base resolution`.

---

### Task 7: Three-way merge — auto-merge and conflict detection

**Files:**
- Create: `src/core/merge.ts`
- Test: `tests/core/merge.test.ts`

**Interfaces:**
- Consumes: `src/core/diff.ts`, `src/core/validate.ts`, `src/core/schema.ts`.
- Produces: `Conflict`, `ConflictClass`, `Resolution`, `MergeResult`, `threeWayMerge(base, ours, theirs, resolutions?): MergeResult` per `design.md` §7.

The single most important task in the plan.

- [ ] **Step 1:** Write the conflict tests — one per row of the `design.md` §7.2 table: `concurrent_rename`, `concurrent_retype`, `concurrent_nullability`, `concurrent_default`, `delete_modify`, `constraint_divergence`, `index_divergence`. Each asserts exactly one conflict, of the right class, with `base`/`ours`/`theirs` carrying the right values.
- [ ] **Step 2:** Write the **non**-conflict tests, which are where a naive implementation fails:
  - both branches rename the same column to the *same* name → no conflict, applied once;
  - both branches drop the same column → no conflict (convergent deletion);
  - **Ana renames `email` while Ben retypes `email` → no conflict, both apply** — different attributes of one entity (`design.md` §6.1). A line-based merge tool reports a conflict here; this one must not;
  - changes to entirely separate tables merge with no conflicts.
- [ ] **Step 3:** Write the delete/modify asymmetry test: ours drops a column that theirs renamed produces one `delete_modify` conflict, and the same scenario with the branches swapped produces the same conflict with `ours`/`theirs` transposed.
- [ ] **Step 4:** Run `npm test -- merge`. Expected: FAIL.
- [ ] **Step 5:** Implement steps 1–4 and 7 of the `design.md` §7.1 algorithm. Key changes by `(entityId, attribute)`, with `"__exists"` as the attribute for creation and deletion. Leave resolutions and name collision for Task 8. Conflict `id` must be the stable `${entityId}:${attribute}` string — the UI depends on it surviving repeated previews.
- [ ] **Step 6:** Every `Conflict.description` is written in plain language naming both authors and both changes, per `design.md` §12. Assert on one description string in a test so the format cannot silently rot.
- [ ] **Step 7:** Run `npm test -- merge`. Expected: PASS. Commit `feat(core): three-way merge with conflict taxonomy`.

---

### Task 8: Name collisions, resolutions, and merge properties

**Files:**
- Modify: `src/core/merge.ts`
- Test: `tests/core/merge-resolution.test.ts`, `tests/core/merge-properties.test.ts`

**Interfaces:**
- Consumes: Task 7's `threeWayMerge`.
- Produces: the same signature, now honouring `resolutions` and detecting `name_collision`.

- [ ] **Step 1:** Write the name collision test (`design.md` §7.3): branch A renames `users.email` to `contact`, branch B renames `users.phone` to `contact`. Neither entity conflicts with any other entity. Assert a `name_collision` **conflict** is raised. Then write the discriminating case: one branch alone creates the duplicate → assert it is reported as a `duplicate_name` **hazard**, not a conflict.
- [ ] **Step 2:** Write the resolution tests: `choice: 'ours'` yields our value; `'theirs'` yields theirs; `'custom'` yields a third value neither branch proposed; a resolved conflict disappears from `conflicts` and its effect appears in `schema`; an unknown `conflictId` throws rather than being ignored.
- [ ] **Step 3:** Write the hazard-through-merge test, which is the "above and beyond" case from `design.md` §8: ours drops `users.id`; theirs adds a foreign key referencing `users.id`. Assert `conflicts` is **empty** and `hazards` contains one `dangling_foreign_key` with severity `error`. A merge that reports success here is the exact failure this project exists to prevent.
- [ ] **Step 4:** Write `tests/core/merge-properties.test.ts` per `design.md` §13: merging a branch into itself is a no-op; merging with no divergence fast-forwards exactly; `threeWayMerge(base, a, b)` and `threeWayMerge(base, b, a)` yield the same schema and the same conflict keys; a schema reachable by valid operations validates clean.
- [ ] **Step 5:** Run `npm test -- merge`. Expected: FAIL, then implement steps 5 and 6 of the §7.1 algorithm, then PASS.
- [ ] **Step 6:** Commit `feat(core): custom resolutions, name collisions, merge properties`.

---

## Day 3 — Migration output, persistence, API

### Task 9: Type widening and safety classification

**Files:**
- Create: `src/core/safety.ts`
- Test: `tests/core/safety.test.ts`

**Interfaces:**
- Consumes: `ColumnType` from `src/core/schema.ts`.
- Produces: `Safety = 'safe' | 'destructive' | 'lossy' | 'blocking'`; `isWidening(from: ColumnType, to: ColumnType): boolean`; `classifyChange(c: Change): { safety: Safety; note: string | null }`.

- [ ] **Step 1:** Write `tests/core/safety.test.ts` as a table over the `design.md` §9.2 relation: `smallint→int→bigint` widens and the reverse does not; `varchar(n)→text` widens; `text→varchar(n)` does not; `varchar(50)→varchar(100)` widens and `varchar(100)→varchar(50)` does not; `numeric` widens only when both precision and scale are non-decreasing; every cross-family pair is not widening. Then assert classification: `DROP COLUMN` is `destructive`, `ADD COLUMN` nullable is `safe`, `ADD COLUMN NOT NULL` without a default is `lossy`, `SET NOT NULL` on an existing nullable column is `lossy`, a rename is `safe`.
- [ ] **Step 2:** Run `npm test -- safety`. Expected: FAIL.
- [ ] **Step 3:** Implement. Every non-`safe` classification must set `note` explaining why in one sentence — it renders in the UI next to the badge.
- [ ] **Step 4:** Run `npm test -- safety`. Expected: PASS. Commit `feat(core): type widening relation and migration safety classification`.

---

### Task 10: Migration planner

**Files:**
- Create: `src/core/migrate.ts`
- Test: `tests/core/migrate.test.ts`

**Interfaces:**
- Consumes: `src/core/diff.ts`, `src/core/safety.ts`, `src/core/schema.ts`.
- Produces: `Statement` per `design.md` §9; `plan(from: Schema, to: Schema): Statement[]` (structured only — `sql` is filled by Task 11).

- [ ] **Step 1:** Write `tests/core/migrate.test.ts` covering ordering, which is the real work here:
  - a new table and a foreign key into it: the `CREATE TABLE` statement precedes the `ADD CONSTRAINT ... FOREIGN KEY`;
  - dropping a column covered by an index: the `DROP INDEX` precedes the `DROP COLUMN`;
  - renaming and retyping the same column: the rename precedes the retype;
  - **circular foreign keys** (`users.org_id → orgs.id` and `orgs.owner_id → users.id`) produce a valid plan and terminate. This is the case a topological sort cannot handle and phase ordering handles for free (`design.md` §9.1);
  - dropping two tables where one references the other: the referencing table is dropped first.
- [ ] **Step 2:** Write the round-trip property test: for a set of from/to pairs, simulate applying the plan to `from` against the model and assert the result deep-equals `to`.
- [ ] **Step 3:** Write the empty case: `plan(s, s)` is `[]`.
- [ ] **Step 4:** Run `npm test -- migrate`. Expected: FAIL.
- [ ] **Step 5:** Implement the 14 fixed phases from `design.md` §9.1. Do **not** build a dependency graph and topologically sort it — phases are immune to foreign key cycles by construction, and the circular test above will fail if this is ignored. Note the reasoning in a comment.
- [ ] **Step 6:** Run `npm test -- migrate`. Expected: PASS. Commit `feat(core): phase-ordered migration planner`.

---

### Task 11: Postgres renderer

**Files:**
- Create: `src/core/dialects/postgres.ts`
- Modify: `src/core/migrate.ts` (populate `Statement.sql`)
- Test: `tests/core/postgres.test.ts`

**Interfaces:**
- Consumes: `Statement` from `src/core/migrate.ts`.
- Produces: `renderStatement(s: Statement, schema: Schema): string`, `renderMigration(statements: Statement[], schema: Schema): string`.

- [ ] **Step 1:** Write `tests/core/postgres.test.ts` asserting exact SQL strings for: create table, add column with and without default, **`ALTER TABLE ... RENAME COLUMN`** (the payoff of tracked renames — never a drop plus an add), alter type with `USING` where a cast is needed, set/drop not null, add and drop each constraint kind, create unique and partial indexes, drop column, drop table. Assert identifiers are double-quoted so reserved words and mixed case survive.
- [ ] **Step 2:** Write the injection test: a table named `users"; DROP TABLE x; --` renders with the quote correctly escaped, not interpolated raw. Names are user input and this is a trust boundary.
- [ ] **Step 3:** Run `npm test -- postgres`. Expected: FAIL.
- [ ] **Step 4:** Implement. `renderMigration` emits statements separated by blank lines with a leading comment per safety class so the copied SQL is readable standalone.
- [ ] **Step 5:** Run `npm test -- postgres`. Expected: PASS. Commit `feat(core): Postgres DDL renderer with identifier escaping`.

---

### Task 12: Persistence

**Files:**
- Create: `supabase/migrations/0001_init.sql`, `src/db/client.ts`, `src/db/projects.ts`, `src/db/commits.ts`, `src/db/branches.ts`
- Test: `tests/db/branches.test.ts`

**Interfaces:**
- Consumes: `Commit` from `src/core/history.ts`, `Schema` from `src/core/schema.ts`.
- Produces: `createProject(name)`, `getProject(id)`; `insertCommit(c: Commit)`, `getCommit(id)`, `getCommitsForProject(projectId): Map<Id, Commit>`; `listBranches(projectId)`, `createBranch(projectId, name, headCommitId)`, `advanceHead(branchId, expected: Id, next: Id): Branch | null`.

- [ ] **Step 1:** Write `supabase/migrations/0001_init.sql` creating the three tables from `design.md` §10, with `unique (project_id, name)` on branches and a foreign key from `branches.head_commit_id` to `commits.id`.
- [ ] **Step 2:** Write `tests/db/branches.test.ts` against a real database from `DATABASE_URL`, skipped when the variable is unset so the core suite runs anywhere. Assert: `advanceHead` succeeds when `expected` matches the current head; **`advanceHead` returns `null` when `expected` is stale**; two concurrent `advanceHead` calls from the same expected head result in exactly one success and one `null`.
- [ ] **Step 3:** Run `npm test -- branches`. Expected: FAIL.
- [ ] **Step 4:** Implement. `advanceHead` is the single compare-and-swap statement from `design.md` §10.1 — `WHERE id = $1 AND head_commit_id = $2 ... RETURNING *`. Never read-then-write. `insertCommit` is append-only; expose no update or delete.
- [ ] **Step 5:** Run `npm test -- branches`. Expected: PASS. Commit `feat(db): append-only commits and compare-and-swap branch heads`.

---

### Task 13: HTTP API

**Files:**
- Create: the seven routes in `src/app/api/` per `design.md` §11
- Test: `tests/api/merge.test.ts`

**Interfaces:**
- Consumes: all of `src/core/`, all of `src/db/`.
- Produces: the endpoints in `design.md` §11. Every response body is `{ data }` or `{ error: { code, message } }`.

- [ ] **Step 1:** Write `tests/api/merge.test.ts` asserting: `/api/merge/preview` returns conflicts and a migration and **writes nothing** (assert commit count is unchanged); posting resolutions changes the returned schema; `/api/merge` with a stale `expectedHead` returns `409` with a message naming the new head; `/api/merge` with unresolved conflicts returns `422` rather than committing a partial merge; `/api/merge` with an `error`-severity hazard returns `422`.
- [ ] **Step 2:** Run `npm test -- api`. Expected: FAIL.
- [ ] **Step 3:** Implement. Validate request bodies at the boundary and return `400` with a specific message — this is the trust boundary between the browser and the pure core, and the core assumes well-formed input.
- [ ] **Step 4:** Run `npm test -- api`. Expected: PASS. Commit `feat(api): schema, compare, preview, and merge endpoints`.

---

## Day 4 — Interface

### Task 14: App shell and branch list

**Files:**
- Create/modify: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/p/[projectId]/page.tsx`

- [ ] **Step 1:** Build the branch list per `design.md` §12: every branch with ahead/behind counts against `main`, last commit message and author, and *Compare* and *Merge* actions. `main` is visually distinguished.
- [ ] **Step 2:** Add branch creation from any branch's head, with inline validation on duplicate names using the `unique (project_id, name)` error rather than a separate lookup.
- [ ] **Step 3:** Verify manually that ahead/behind is correct for a branch that has diverged in both directions.
- [ ] **Step 4:** Commit `feat(ui): project shell and branch list`.

---

### Task 15: Schema editor

**Files:**
- Create: `src/app/p/[projectId]/b/[branchId]/page.tsx`, `src/components/SchemaTree.tsx`

- [ ] **Step 1:** Render the schema at branch head — tables, and per table its columns, constraints, and indexes.
- [ ] **Step 2:** Wire every edit to a `SchemaOp` accumulated in client state, showing a running "N uncommitted changes" indicator. Committing sends the operation list with `expectedHead`; a `409` surfaces as "this branch moved" with a refresh action.
- [ ] **Step 3:** Run `validate` on the pending schema client-side and show hazards live, so a user cannot commit a broken schema and discover it at merge time.
- [ ] **Step 4:** Confirm destructive edits (dropping a table or column) inline, naming what depends on it — the cascade from Task 3 already knows.
- [ ] **Step 5:** Commit `feat(ui): schema editor with uncommitted operation staging`.

---

### Task 16: Diff view

**Files:**
- Create: `src/app/p/[projectId]/compare/page.tsx`, `src/components/ChangeRow.tsx`

- [ ] **Step 1:** Render `Change[]` from `/api/compare`, grouped by table, using `describeChange` for the wording.
- [ ] **Step 2:** **Render renames as renames** — `email → contact_email` on one row, never a red drop beside a green add. This is the visible payoff of the identity decision and should be immediately obvious to someone scanning the screen.
- [ ] **Step 3:** Encode change kind with both colour and an icon or label, so the diff is not colour-dependent.
- [ ] **Step 4:** Handle the empty case: "these branches are identical" rather than a blank panel.
- [ ] **Step 5:** Commit `feat(ui): branch comparison view`.

---

### Task 17: Merge view

**Files:**
- Create: `src/app/p/[projectId]/merge/page.tsx`, `src/components/ConflictCard.tsx`, `src/components/HazardList.tsx`, `src/components/MigrationPreview.tsx`

The screen the whole project builds toward.

- [ ] **Step 1:** Build `ConflictCard`: the plain-language description, base/ours/theirs side by side with branch names and authors, and three actions — *Take ours*, *Take theirs*, *Write my own*. The custom input is typed to the attribute: a text field for a name, a type picker for a type.
- [ ] **Step 2:** Wire resolutions to re-post `/api/merge/preview` so the merged result and migration update as the user decides. The endpoint is read-only, so this is free of write risk.
- [ ] **Step 3:** Build `HazardList` as a visually distinct section, with a one-line explanation of why it is separate: nobody disagreed, but the combination is invalid. Each hazard names the two changes that combined badly.
- [ ] **Step 4:** Build `MigrationPreview`: the rendered SQL with a safety badge per statement, the `note` shown for anything not `safe`, and a copy button. A summary line counts destructive and lossy statements.
- [ ] **Step 5:** Disable the merge button while any conflict is unresolved or any `error` hazard remains, **with the reason on the button itself**, not hidden in a tooltip.
- [ ] **Step 6:** Handle `409` from `/api/merge` by explaining that the branch moved and re-running the preview against the new head, preserving the resolutions the user already made. Losing their work here would be the cruellest possible failure.
- [ ] **Step 7:** Commit `feat(ui): merge view with conflict resolution, hazards, and migration preview`.

---

## Day 5 — First run, resilience, ship

### Task 18: Seeded demo, empty states, error handling

**Files:**
- Create: `src/seed/demo.ts`, `src/app/api/seed/route.ts`
- Modify: `src/app/page.tsx`, plus error and loading boundaries

- [ ] **Step 1:** Build a demo project of six or seven realistic related tables (`users`, `organizations`, `orders`, `order_items`, `products`, `payments`) with real foreign keys and indexes.
- [ ] **Step 2:** Seed two diverged branches with a **specific planted scenario**, not random noise: one branch renames `users.email` to `contact_email` and adds an index on it; the other retypes `users.email` to `text` and adds a `NOT NULL` column. This yields a genuine `concurrent_*` conflict, a clean auto-merge, and a `lossy` migration statement — the three things worth seeing, on screen in ten seconds.
- [ ] **Step 3:** Plant a second scenario reachable in one click that produces a **zero-conflict merge with a hazard**: one branch drops a column, the other adds a foreign key referencing it. This is the hardest thing the tool does and it should not be hidden.
- [ ] **Step 4:** Route `/` to the demo project. Add `error.tsx` and `loading.tsx` boundaries. Every empty state says what to do next, never just "no data".
- [ ] **Step 5:** Make the seed idempotent and re-runnable, and add a visible "reset demo" action so a reviewer who breaks it can recover without redeploying.
- [ ] **Step 6:** Commit `feat: seeded demo project, first-run experience, error boundaries`.

---

### Task 19: README, deploy, and closing the decision log

**Files:**
- Create: `README.md`
- Modify: `decisions.md`

- [ ] **Step 1:** Write `README.md`: what this is and who it is for in three sentences; the live URL; setup in one block (clone, `npm install`, copy `.env.example`, run the Supabase migration, `npm run dev`); how to run tests; a guided demo walkthrough naming the two planted scenarios from Task 18; a short architecture section pointing at `design.md`; the non-goals from `design.md` §14.
- [ ] **Step 2:** Verify setup from a clean clone in a fresh directory, following only the README. Fix every step that required knowledge not written down. This is a scored criterion and the only way to test it is to actually do it.
- [ ] **Step 3:** Deploy to Vercel with the Supabase connection string set. Run the seed against production. Click through both planted scenarios on the live URL.
- [ ] **Step 4:** Append a "Day 5 — what surprised me" section to `decisions.md`: every place the build contradicted the plan, every shortcut taken under time pressure and what it would cost to undo, and what would come next. The brief asks for judgment under time pressure; an honest note about a corner cut reads better than silence.
- [ ] **Step 5:** Run `npm run lint && npm run typecheck && npm test` one final time. Commit and push.

---

## Self-review against the spec

Checked `design.md` section by section for coverage:

| Spec | Task |
| --- | --- |
| §3 schema model, identity, structural choices | T2 |
| §4 operations and deletion cascade | T3 |
| §5 commits, snapshots, merge base | T6, T12 |
| §6 diff, attribute granularity | T5 |
| §7 three-way merge, conflict taxonomy, name collision, resolutions | T7, T8 |
| §8 validation and hazards | T4, T8 (via merge) |
| §9 migration ordering, safety, dialect | T9, T10, T11 |
| §10 persistence and CAS | T12 |
| §11 HTTP API | T13 |
| §12 interface, all four screens, first run | T14–T18 |
| §13 testing, examples and properties | T4–T11, T8 |
| §14 non-goals | not built, documented in T19 |

No gaps. Signatures used in later tasks match those declared in earlier
`Interfaces` blocks. No task depends on a type defined nowhere.

**Riskiest tasks, ranked:** T7 and T8 (the merge core — if these slip, cut T15's
richer editing in favour of a minimal one), T10 (phase ordering), T17 (the
merge UI is the largest single piece of interface work). T14–T16 are the
compressible ones; T7, T8, and T17 are not.
