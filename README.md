# Schema Version Control

Branch, diff, and merge for database schemas.

A backend team shares one database. Two engineers each need a schema change for
their own feature, so they write migrations independently — and discover the
collision at migration time, in production. This gives the schema itself a
branch/merge model: branch from `main`, evolve independently, see exactly what
diverged, and merge back with an ordered migration as the output.

Row data is out of scope. The artifact under version control is the schema.

---

## Status

**Design complete. Implementation not started.**

This repository currently contains the design, the decision log, and the
task-by-task build plan. There is no application code yet, so there is nothing
to install or run. Setup and demo instructions land with Task 1 and Task 19 of
the plan respectively.

| Document | What it covers |
| --- | --- |
| [decisions.md](decisions.md) | Every real call made, with the alternatives rejected and the tradeoffs accepted |
| [design.md](design.md) | The specification — data model, algorithms, taxonomies, API, screens, testing |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 19 tasks over 5 days, each with file paths, interface contracts, and test assertions |

---

## The three ideas this rests on

### 1. Stable identity makes renames real

Every table, column, constraint, and index carries an immutable synthetic ID
assigned at creation. `name` is an ordinary mutable attribute.

This removes the hardest problem in the domain. Under name-based identity,
renaming `email` to `contact_email` is indistinguishable from dropping `email`
and adding `contact_email` — the differ reports data loss and the merge
discards a column. Under stable identity, a rename is just "the `name`
attribute of entity X changed": correct by construction, with no detection
heuristic anywhere in the codebase.

It pays off twice more. Constraints and indexes reference columns *by ID*, so a
rename propagates into every foreign key and index for free. And because the
migration knows a rename is a rename, it emits `ALTER TABLE ... RENAME COLUMN`,
which preserves the data.

### 2. Conflicts and hazards are different problems

A **conflict** is two people changing the same thing to different values. It
needs a human to choose, and the resolver offers a third option — *write my
own* — because when two engineers rename a column differently, the right answer
is often a name neither of them picked.

A **hazard** is when nobody disagreed but the *combination* is broken. I drop
`users.id`; you add a foreign key referencing it. The two changes touch
different entities, so no conflict detector will ever pair them — a
conflict-only merge reports clean success and hands back a schema that will not
apply. Validity is a property of the merged result, so it gets its own pass.

### 3. The output is a migration, not a schema

The merged schema answers an academic question. The migration answers the
user's actual question: what do I run on Monday.

Statements are emitted in fixed dependency phases — every table exists before
any foreign key is added, every index is dropped before the column it covers.
Phases rather than a topological sort, because foreign keys are legitimately
circular (`users.org_id → orgs.id` alongside `orgs.owner_id → users.id`) and a
topological sort has no answer for a cycle.

Each statement is classified `safe`, `destructive`, `lossy`, or `blocking`.
Row data is out of scope, but whether a change *destroys* data is a property of
the schema change — so `text → int` is flagged as lossy even though no rows are
migrated.

---

## Not built

SQL DDL parsing · live database introspection · applying migrations to a real
database · authentication and multi-user accounts · rebase, cherry-pick, revert
· remotes, push, pull · row data migration · dialects other than Postgres.

Each is argued in [decisions.md](decisions.md) rather than left unmentioned.
Introspection is the one that is purely additive — it produces a `Schema` and
touches nothing in the core — and is first in line if time allows.

---

## Stack

Next.js 15 (App Router) · TypeScript strict · React 19 · Vitest · Supabase
Postgres · Tailwind · deployed on Vercel.

The `src/core/` layer — diff, merge, validate, plan — is pure: no database, no
React, no I/O of any kind. That boundary is enforced by an ESLint rule and a
test, not by convention. It is why the tests over the hard logic are plain
assertions with no fixtures or mocks.
