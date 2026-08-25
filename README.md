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

**Built. 289 tests passing.**

**Live:** <!-- DEPLOY_URL --> _(fill in after `vercel --prod`)_

**Repo:** https://github.com/DevSakar404/schema-version-control

| Document | What it covers |
| --- | --- |
| [decisions.md](decisions.md) | Every real call made, with the alternatives rejected and the tradeoffs accepted — 43 entries, running through deployment |
| [design.md](design.md) | The specification — data model, algorithms, taxonomies, API, screens, testing |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 21 tasks over 5 days, each with file paths, interface contracts, and test assertions |

The design was reviewed against inputs an ordinary user could produce before
any code existed, and seven cases came back wrong (D19–D25). Building the UI
on top of the (by then well-tested) core surfaced a second wave — eight more
real bugs, every one of them invisible to a full green test suite and found
within about a minute of actually clicking through the feature (D32–D40). The
"Day 5 — what surprised me" section at the end of `decisions.md` names the
pattern connecting all of them, rather than leaving it as eight disconnected
bug reports.

---

## Setup

```bash
git clone <this-repo-url>
cd zamp-schema-version
npm install
cp .env.example .env
```

Create a [Supabase](https://supabase.com) project (free tier), then open
**Connect → Connection string → URI**. Two strings are offered:

| | Host | Port | Use it? |
| --- | --- | --- | --- |
| Direct connection | `db.<ref>.supabase.co` | 5432 | **No** — IPv6-only, so most home networks and every Vercel function fail to reach it |
| **Transaction pooler** | `...pooler.supabase.com` | **6543** | **Yes** |

Copy the **Transaction pooler** string into `.env` as `DATABASE_URL`,
replacing `[YOUR-PASSWORD]` with your database password. Then:

```bash
npm run db:migrate   # creates projects / commits / branches
npm run dev           # http://localhost:3000
```

The home page seeds itself on first visit — click **Seed the demo** and a
realistic six-table schema with three diverged branch pairs appears
immediately. A **Reset demo** button on the project page restores it to that
same state at any point, so nothing you do while exploring the editor can
break the demo permanently.

**Tests:**

```bash
npm test          # 289 tests. Core suite needs no database at all.
npm run typecheck
npm run lint
```

The database-backed tests (`tests/db/`) skip themselves automatically when
`DATABASE_URL` is unset, so `npm test` runs clean on a machine with no
Supabase project configured — only the pure `src/core/` suite runs, which is
most of the 289.

---

## A guided walkthrough

Three scenarios are planted on first seed, each a merge away from something a
naive schema-diff tool gets wrong. From the project page, use the **vs**
picker on a branch row to compare it against its sibling (not `main` — these
three pairs only conflict against *each other*):

1. **`feature/rename-contact-email` vs `feature/normalize-email`** — a real
   conflict: both branches rename `users.email`, to different names. Resolve
   it (take either side, or write a third name) and watch an *independent*
   retype on the same column merge in underneath, unconflicted — two edits to
   two different attributes of one column, which is exactly what stable
   identity (below) makes possible.
2. **`feature/uuid-user-ids` vs `feature/payment-approvals`** — zero
   conflicts. Both branches are independently valid. Only their combination
   breaks: one retypes `users.id` to `uuid`, the other adds an `int` foreign
   key to it from an unrelated table. The hazard panel names both branches by
   who touched what.
3. **`feature/drop-payments` vs `feature/refund-flag`** — one branch drops the
   `payments` table outright, the other adds a column to it. Nothing here
   overlaps if you compare key by key; the merge screen catches it anyway.

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

Conflicts are also detected *across containment*, not just on the same entity.
If I delete the `users` table while you add a column to it, we never touched
the same thing — key-by-key comparison sees no overlap and reports a clean
merge, then tries to add a column to a table that no longer exists. Deletion
conflicts with any change in the deleted entity's dependency closure.

A **hazard** is when nobody disagreed, nothing was deleted, and the
*combination* is still broken. I retype `users.id` from `int` to `uuid`; you
add a foreign key to it from an `int` column. Both changes apply cleanly and
the result is a foreign key between mismatched types, which Postgres rejects.
Validity is a property of the merged result, so it gets its own pass.

The line between the two is deliberate: if a combination involves a deletion,
someone has to choose what survives, so it is a conflict. Hazards are what is
left over — defects with no choice to offer. A choice always beats a complaint.

### 3. The output is a migration, not a schema

The merged schema answers an academic question. The migration answers the
user's actual question: what do I run on Monday.

Getting there is an ordering problem with two distinct halves.

**Foreign keys use fixed phases**, not a graph sort. Every table is created
before any foreign key is added, every index dropped before the column it
covers. A topological sort looks like the right tool until you notice foreign
keys are legitimately circular — `users.org_id → orgs.id` alongside
`orgs.owner_id → users.id` — and a topological sort has no answer for a cycle.
Phases are immune to it by construction.

**Renames use a topological sort**, and run before anything is created. This is
the opposite conclusion, for a different problem: renaming `users` to
`accounts` and then creating a new `users` is a valid end state reached by an
invalid path, so renames must be emitted first. And renames can collide with
each other — swapping two column names has *no* valid two-statement ordering,
since either order briefly duplicates a name. That needs a real cycle break:
`a → __tmp_1`, `b → a`, `__tmp_1 → b`.

Two superficially identical ordering problems, two opposite correct answers.
Assuming the first generalised to the second was a real bug in an earlier draft
of the design.

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

**One limitation worth stating plainly**, because it is visible in the product
rather than merely absent from it: `CHECK` predicates are composed in the
editor by picking columns and an operator, not typed as free SQL. Storing
`"age > 0"` as text would put a name-based reference inside a system whose one
rule is that nothing is matched by name — drop `age` and the constraint would
dangle undetected, rename it and the predicate would silently still say `age`.
Predicates are stored as column IDs with a template, and names are substituted
when the SQL is rendered. The tradeoff is a less expressive editor in exchange
for predicates that survive renames and are caught by validation. A rule the
tool cannot read is a rule it cannot protect.

---

## Stack

Next.js 15 (App Router) · TypeScript strict · React 19 · Vitest · Supabase
Postgres · deployed on Vercel. Styling is a small hand-written stylesheet, not
a framework — the rubric this was built against explicitly doesn't score
visual polish, so a dependency for it wasn't worth adding (D31).

The `src/core/` layer — diff, merge, validate, plan — is pure: no database, no
React, no I/O of any kind. That boundary is enforced by an ESLint rule and a
test, not by convention. It is why the tests over the hard logic are plain
assertions with no fixtures or mocks.
