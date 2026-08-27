# Engineering notes — what to read, and why

A reader with twenty minutes should spend them in `src/core/`. It is 2,481
lines with 2,072 lines of tests over it, it contains every decision that was
hard, and it is where this project either works or doesn't.

Everything else — the database layer, the HTTP routes, the screens — is
plumbing around it. Written carefully, but plumbing. The core is pure: no
database, no React, no I/O of any kind. Time and ID generation are injected
parameters. That boundary is enforced by an ESLint rule and by a test that
fails if anything in `src/core/` imports from `src/db/`, `src/app/`, or
`src/components/` (`tests/core/boundary.test.ts`), which is why the tests
over the hard logic are plain assertions with no fixtures, no mocks, and no
setup.

| Module | Lines | Tests | What it decides |
| --- | ---: | ---: | --- |
| `merge.ts` | 607 | 48 | three-way merge, conflict taxonomy, resolutions, hazard attribution |
| `validate.ts` | 278 | 22 | what Postgres would reject, as a pass over a merged schema |
| `difftree.ts` | 268 | 27 | the diff as a reviewer reads it, not as the engine emits it |
| `diff.ts` | 239 | 15 | attribute-level change detection |
| `ops.ts` | 236 | 17 | the 15 schema operations, each pure |
| `dialects/postgres.ts` | 196 | 17 | DDL rendering |
| `migrate.ts` | 168 | 15 | statement ordering by fixed phase |
| `schema.ts` | 141 | 11 | the data model and its lookups |
| `renames.ts` | 100 | 14 | rename ordering and cycle breaking |
| `safety.ts` | 92 | 9 | type widening, destructive/lossy classification |
| `history.ts` | 75 | 11 | commit graph, merge base |
| `closure.ts` | 63 | 6 | ownership and dependency closure |

---

## The three that were actually hard

### Stable identity, and what it buys

Every table, column, constraint, and index carries an immutable synthetic ID
assigned at creation. `name` is an ordinary mutable attribute.

This is the decision the whole product rests on. Under name-based identity,
renaming `email` to `contact_email` is indistinguishable from dropping
`email` and adding `contact_email`: the differ reports data loss and the
merge discards a column. Under stable identity a rename is "the `name`
attribute of entity X changed" — correct by construction, with no detection
heuristic anywhere in the codebase.

It pays off twice more, in places that weren't the motivation. Constraints
and indexes reference columns *by ID*, so a rename propagates into every
foreign key, index, and `CHECK` predicate for free — `tests/core/diff.test.ts`
asserts that a renamed column covered by all three produces **only** the
rename, no constraint or index change. And because the migration knows a
rename is a rename, it emits `ALTER TABLE … RENAME COLUMN`, preserving the
data.

### Conflicts across containment (D19)

The case that made me rewrite the merge algorithm: I delete the `users`
table while you add a column to it. Compare key by key and there is no
overlap at all — no entity was touched twice — so a naive merge reports
clean, then produces a migration that adds a column to a table that no
longer exists.

The fix is that deletion conflicts with any change inside the deleted
entity's **dependency closure**, which is why `closure.ts` exists as its own
module with its own tests rather than living inside `merge.ts`. It was folded
into merge in the first draft of the plan, and that is part of why the bug
went unnoticed.

`tests/core/merge-containment.test.ts` (17 tests) pins this, including the
asymmetry case: the drop on `ours` and the modify on `theirs` produces the
same conflict as the reverse, with the sides transposed.

### Rename ordering and cycles (D20)

Two branches swap two column names. Emit the renames in either order and the
second one collides with a name the first hasn't vacated yet. The fix is a
temporary: `a → __tmp_1`, `b → a`, `__tmp_1 → b`.

The interesting part is what *doesn't* work. Foreign keys in this schema are
legitimately circular — `users.org_id → orgs.id` alongside
`orgs.owner_id → users.id` — so the topological sort that looks like the
right tool for rename ordering has no answer for the FK case, and the
phase-based approach that handles FKs can't order renames among themselves.
They look like the same problem and are not. `renames.ts` and `migrate.ts`
are separate for that reason, and `tests/core/migrate.test.ts` has an
explicit circular-FK test asserting the plan terminates.

---

## Conflicts and hazards are different problems

A **conflict** is two people changing the same thing to different values. It
needs a human to choose — and the resolver offers a third option, *write my
own*, because when two engineers rename a column differently the right answer
is frequently a name neither of them picked.

A **hazard** is when nobody disagreed, nothing was deleted, and the
*combination* is still broken. One branch retypes `users.id` from `int` to
`uuid`; the other adds an `int` foreign key pointing at it. Both branches are
independently valid. Only the merge is broken, and Postgres is what rejects
it. Validity is therefore a property of the merged *result* and gets its own
pass (`validate.ts`), not a byproduct of conflict detection.

The line between them is deliberate: if a combination involves a deletion,
somebody has to choose what survives, so it is a conflict. Hazards are what's
left — defects with no choice to offer. A choice always beats a complaint.

Hazards carry attribution (`causedBy`), computed in `merge.ts` and absent
from `validate.ts` — the validator sees a final schema and has no idea who
produced any part of it. Asking it to name two branches would be asking it to
invent them.

---

## How the tests are built

`tests/core/` is 2,072 lines over 2,481 lines of source, and the shape
matters more than the ratio:

- **The conflict taxonomy is the test plan.** Every class in the taxonomy has
  a test that fires it, and — more usefully — convergent cases asserted to
  produce *no* conflict. Two branches making the same edit is not a conflict,
  and a tool that says otherwise trains people to ignore it.
- **Property tests** (`merge-properties.test.ts`) assert order independence:
  `threeWayMerge(base, a, b)` and `threeWayMerge(base, b, a)` produce the same
  schema and the same conflict set, modulo side labels.
- **Seven regression tests are named after the design review that produced
  them** (D19–D25). Before any code existed, I ran the design against inputs
  an ordinary user could produce. Seven cases came back wrong. Each is now a
  test with the decision number in the name.
- **Two tests assert silence.** `explainConnectionError` rewrites an
  unroutable-host failure into the fix for it; two of its four tests assert it
  stays quiet, because a false positive misdirects somebody whose real problem
  is something else.

---

## What I would tell you about the parts that are weak

`decisions.md` is a running log, and it records the failures at the same
resolution as the wins. Two worth knowing about:

**D38 is the most serious bug in the build**, and a full green test suite
never saw it. An unresolved `delete_modify` was stripping the kept entity's
primary and foreign keys — silent data-model corruption, found by clicking
through the merge screen rather than by testing. D32–D40 are eight more of
the same shape, and the "Day 5 — what surprised me" section argues the
pattern rather than leaving them as eight disconnected bug reports: a pure
function's tests only cover the inputs someone thought to construct.

**D46 records a process failure.** The Reset demo button was removed as an
already-staged edit nobody claimed, which silently invalidated the mitigation
D42's no-authentication decision rests on. Writing the entry is what surfaced
the contradiction and forced the restore.

The honest limitations are in `decisions.md` too, stated rather than left to
be discovered: no authentication (D2, and D42 for what that costs on a public
URL), `CHECK` predicates are structured rather than free SQL because there is
no SQL parser here (D14, D22), and hazard attribution is correlation rather
than causation (D24).
