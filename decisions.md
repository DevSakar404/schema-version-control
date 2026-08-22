# decisions.md

A running log of the real calls made building this. Written as decisions were
made, not reconstructed afterward. Entries are append-only; where a later
decision reversed an earlier one, both are left in place with the reversal noted.

---

## Day 0 — Framing

### D1. Problem statement: schema version control over document extraction

**Chose:** Problem 2 (branch/diff/merge for database schemas).

**Considered:** Problem 1 (messy documents → structured queryable data).

**Reasoning:** Problem 1's default solution is an LLM call plus a table view,
and its hard part is *unfalsifiable* in five days — I can't prove my extraction
is correct, only assert it, and non-determinism actively fights writing tests
that catch real problems. Problem 2 is deterministic: `merge(base, ours, theirs)`
is a pure function, so the conflict taxonomy *is* the test suite and correctness
is demonstrable rather than claimed. It also needs no API keys, which keeps
setup to a clone and two env vars.

**Accepted tradeoff:** Schema version control has well-known prior art (Neon,
PlanetScale, Atlas, Dolt). A reviewer may know that space. I'd rather be judged
on whether my design choices inside a known problem are sound than get novelty
credit for a shallower build.

### D2. Who this is for

**Chose:** A backend team sharing one database.

**Considered:** A solo developer exploring schema designs; a schema review /
"PR for schemas" tool; per-branch preview environments.

**Reasoning:** The concrete pain: two engineers each write migrations for their
own feature, and the collision surfaces at migration time in production. That
gives merge a reason to exist. The solo-developer framing was tempting because
it needs no auth, but a solo user rarely produces genuine divergence, which
guts the only interesting part of the problem. Preview environments only mean
something with real provisioned databases behind them, which I cut (D4).

**Cut:** Multi-user accounts, auth, and review/approval workflow. Author is a
name on a commit. Auth is a solved problem that would consume a day and
demonstrate nothing about how I think.

---

## Day 0 — Architecture

### D3. Stable synthetic IDs, not name matching

**Chose:** Every table, column, constraint, and index carries an immutable
synthetic ID assigned at creation. `name` is an ordinary mutable attribute.

**Considered:** Identifying entities by name and detecting renames
heuristically (name similarity + type match); recording renames explicitly as
operations in an event log.

**Reasoning:** This is the decision the whole project turns on. Under
name-based identity, `rename(email → contact_email)` is *indistinguishable*
from `drop email; add contact_email`. A differ reports a destructive drop, and
a merge silently discards a column. Heuristic matching is guessing, and it
guesses worst on exactly the ambiguous cases that matter.

With stable IDs, rename is just "the `name` attribute changed" — correct by
construction, with no detection step at all. It is simultaneously *less code*
and *more correct*, which is the rare kind of decision worth taking every time.

**Second-order win I didn't anticipate:** constraints and indexes reference
columns by ID rather than name. A rename therefore propagates into every
foreign key and index automatically. The cascade logic I expected to write
doesn't exist.

**Accepted tradeoff:** Schemas imported from an external source have no IDs, so
importing would require an identity-assignment pass. Since I cut import (D4),
this cost isn't paid here — but it's the real reason production tools in this
space struggle with introspection.

### D4. Self-contained schema editor; no live database connection

**Chose:** Schemas are authored inside the app through a typed operation API.
Nothing connects to a real database.

**Considered:** Introspecting a live Postgres/Supabase schema via connection
string to seed a project; the full loop of introspect → branch → merge → apply
the generated DDL back to the live database.

**Reasoning:** Introspection *looks* impressive but it's plumbing — a
`pg_catalog` query and a connection pool. It's the part of the problem a
reviewer already knows I could build. The rename-aware three-way merge is the
part that's actually hard, and spending ~1.5 of 5 days on a connection layer
takes it directly out of the differentiator.

Applying migrations to a live database was rejected more firmly: a deployed
app writing DDL into someone's real database is the single most likely thing
to fail during a demo, and it fails destructively.

**What I did instead, for two hours rather than a day and a half:** the seeded
demo project models a realistic multi-table schema, and the merge output is
genuine, copy-pasteable Postgres DDL. The reviewer gets the feeling of realness
without me owning a connection layer.

**Deliberately sequenced, not forgotten:** introspection is purely additive —
it produces a `Schema` and touches nothing in `core/`. It's the first thing to
add if there's time on day 5.

### D5. Full snapshots per commit, not an operation log

**Chose:** Each commit stores a complete schema snapshot.

**Considered:** Storing an operation delta per commit and replaying from the
root to materialize any version.

**Reasoning:** The standard argument for op logs is that snapshots lose intent
— you can't tell a rename from a drop+add. Stable IDs (D3) already preserve
that intent, so the argument doesn't apply here. What's left is that schemas
are kilobytes: a snapshot makes every read O(1) with no replay, no compaction,
and no "rebuild state to answer a question" code path. Op logs earn their
complexity when the artifact is large. This one isn't.

**Accepted tradeoff:** Storage is O(commits × schema size) instead of
O(total changes). At the scale of a schema this is irrelevant, and if it ever
weren't, snapshot-every-N-with-deltas-between is a well-understood retrofit.

### D6. Dialect-neutral model, exactly one renderer

**Chose:** The schema model is engine-agnostic plain data. A single Postgres
renderer turns migration statements into SQL text.

**Considered:** A dialect plugin interface with a Postgres implementation, so
MySQL/SQLite could be added later.

**Reasoning:** An interface with one implementation is speculative
generality — it's the abstraction that costs today and pays only in a future
that may not arrive. The model is naturally dialect-neutral because it
describes tables and types, not syntax; only the final render step varies. When
a second dialect is genuinely needed, the seam is obvious and extraction is
mechanical. Building the seam now buys nothing and adds indirection to every
call site.

### D7. `core/` is pure; all I/O lives outside it

**Chose:** `diff`, `merge`, `validate`, and `plan` are pure functions over
plain data — no database access, no React, no I/O of any kind. Persistence and
UI sit strictly outside and call in.

**Considered:** Letting merge read commits from the database directly, which
is fewer lines end to end.

**Reasoning:** This boundary is what makes the tests worth writing. Every hard
part of the problem becomes `assert merge(base, a, b) === expected` with no
fixtures, no mocks, no database, and no setup. It's also the honest answer to
"would you hand this to a teammate" — the interesting logic is readable in one
sitting without tracing through a framework.

---

## Day 0 — The merge model

### D8. Three-way merge with a real merge base

**Chose:** Find the lowest common ancestor in the commit DAG, compute
`diff(base, ours)` and `diff(base, theirs)`, then combine per entity attribute.

**Considered:** Two-way diff between branch heads.

**Reasoning:** Two-way diff cannot distinguish "they added a column" from
"I deleted a column" — the head states look identical either way. Without a
base there is no notion of who changed what, and therefore no correct merge,
only a guess. This isn't an enhancement; it's the minimum for the word "merge"
to mean anything.

**Implementation note:** LCA is computed by walking ancestor sets breadth-first
and taking the deepest common commit. This is naive and fine at this scale;
marked in the source with a `ponytail:` comment naming the ceiling.

### D9. Conflicts and hazards are different things

**Chose:** Merge reports two independent categories.

- **Conflicts** — both branches changed the same thing to different values.
  A human must choose.
- **Hazards** — no one disagreed, but the *combination* is invalid.

**Reasoning:** This is the distinction I expect most submissions to miss, and
it's where I chose to go deep. A merge with zero conflicts can still produce a
broken schema: I retype `users.id` from `int` to `uuid` while you add a foreign
key to it from an `int` column. Nothing is deleted and nothing is edited twice,
so no conflict detector pairs them, and a conflict-detection-only merge reports
clean success and hands you a schema Postgres will reject.

*(The original example here was dropping `users.id` while another branch added
a foreign key to it. D19's containment rule later reclassified that as a
`delete_modify` conflict, which is the better outcome — a choice beats a
complaint. The example was replaced with one where nothing is deleted, so the
distinction it illustrates still holds.)*

So validity is a **separate pass over the merged result**, not a byproduct of
conflict detection. It catches dangling foreign keys, indexes on dropped
columns, duplicate names within a scope, primary keys on nullable columns, and
tables left with no columns.

**Also handled — the semantic name collision:** two branches independently
rename different columns to the same final name. No entity conflicts with any
other entity, yet the result is invalid. This surfaces as a conflict rather
than a hazard, because a human has to pick the new names.

### D10. Conflict resolution allows a third answer

**Chose:** Each conflict offers *take ours* / *take theirs* / *write my own*.

**Considered:** Git's model, where every conflict resolves to one side.

**Reasoning:** When two engineers rename the same column differently, the
correct resolution is very often a third name that neither chose — they were
both reaching for the same clarification. Forcing a binary choice makes the
tool produce a known-wrong answer and then requires a follow-up commit to fix
it. Allowing a custom resolution costs roughly half a day and is the specific
thing a text-based merge tool structurally cannot offer, because it doesn't
know it's looking at a column.

**Presentation:** conflicts are described in plain language — "Ana renamed
`email` to `contact_email`; Ben changed `email` to `text`" — rather than as
diff markers. The tool knows the semantics, so it should speak them.

### D11. Migration output is ordered and safety-classified

**Chose:** Merging emits a topologically ordered Postgres migration, with each
statement tagged `safe`, `destructive`, `lossy`, or `blocking`.

**Considered:** Emitting only the merged schema object and letting the user
work out how to get there.

**Reasoning:** The merged schema is the answer to an academic question. The
migration is the answer to the user's actual question, which is "what do I run
on Monday." Ordering is a genuine sub-problem, not formatting: a foreign key
cannot be added before its table exists, an index must be dropped before the
column it covers, renames must precede retypes on the same column.

**Revised while writing the design (see D17).** My first instinct was a
dependency graph with a topological sort. That's wrong, and the reason is
worth recording.

Renames emit `ALTER TABLE ... RENAME COLUMN`, which preserves the data — and
that is only possible because D3 tracked the rename *as* a rename. The value of
the identity decision shows up here, several layers away from where it was made.

**On the row-data boundary:** the brief puts row data out of scope, and I have
not implemented any data migration. But whether a schema change destroys data
is a property of the *schema* change, so the classification is in scope and
cheap: `int → text` is safe, `text → int` is lossy and may fail outright,
`DROP COLUMN` is destructive. The UI shows these badges. Respecting the scope
boundary shouldn't mean pretending not to know what's on the other side of it.

### D12. Optimistic concurrency on branch heads

**Chose:** Advancing a branch head is a compare-and-swap:
`UPDATE branches SET head = $new WHERE id = $id AND head = $expected`.
Zero rows affected means someone else moved the branch; the user is told to
re-merge against the new head.

**Considered:** Ignoring concurrency, on the grounds that a demo has one user.

**Reasoning:** The premise of the product (D2) is a *team* sharing a database.
Two people merging into `main` at once isn't an exotic edge case, it's Tuesday.
Last-write-wins would silently discard a merge, which is precisely the failure
this tool exists to prevent — an embarrassing bug to have in a version control
system. The fix is about fifteen lines and one extra WHERE clause.

---

## Day 0 — Testing

### D13. Tests target `core/`, and the conflict taxonomy is the test plan

**Chose:** Unit tests over the pure functions, organized around the conflict
classes; a small number of integration tests over the API routes; no browser
E2E suite.

**Reasoning:** Every class of thing that can go wrong in a merge is a test
case, and because `core/` is pure (D7) each one is a plain assertion with no
fixtures. Enumerated: concurrent rename, concurrent retype, delete/modify,
convergent delete/delete (which must *not* conflict), name collision,
constraint divergence, nullability and default divergence.

Beyond example tests, three properties are worth asserting because they catch
whole classes of bug at once:

- Merging a branch into itself is a no-op.
- Merging with no divergence fast-forwards exactly.
- `merge(base, a, b)` and `merge(base, b, a)` yield the same schema. Order
  independence is easy to break accidentally and hard to notice by hand.
- Applying `plan(from, to)` to `from` yields `to` — the migration round-trip.

**Cut:** Playwright/E2E. It's the slowest suite to write and maintain and would
mostly re-verify that React renders. The risk in this project lives in merge
semantics, not in the DOM. Testing effort should follow the risk.

---

## Day 0 — Scope

### D14. No SQL parser

**Chose:** Schemas are built through a typed operation API and the UI. No
`CREATE TABLE` parsing.

**Reasoning:** A real DDL parser is multiple days for a dialect with Postgres's
surface area, and it demonstrates nothing about version control. A partial
parser is worse than none: it works on my examples and fails on the reviewer's
first paste, converting a strength into a visible bug. The interesting problem
is what happens *after* you have a schema.

### D15. Cut from version control

Not built, each for a reason:

- **Rebase, cherry-pick, revert.** The brief asks for branch, diff, and merge.
  Each addition would be shallower than going deep on merge, and depth beats
  breadth here.
- **Remotes / push / pull.** Distribution is a different problem entirely.
- **Row data migration.** Explicitly out of scope. Classification of data risk
  is kept (D11).
- **Non-Postgres dialects.** See D6.

### D16. First-run state is a pre-diverged demo project

**Chose:** A new visitor lands on a seeded project with two branches already
diverged and a live conflict waiting.

**Considered:** An empty state with a "create your first schema" call to action.

**Reasoning:** The interesting part of this product is invisible until
divergence exists. An empty state asks a first-time visitor to hand-build two
branches worth of schema changes before the tool does anything they couldn't do
in a text editor — most people would quit before reaching the point. Seeding a
realistic conflict means the value is on screen in about ten seconds. It is
probably the highest-return hour in the build.

---

---

## Day 0 — Refinements found while writing the plan

Writing `design.md` and the task breakdown forced decisions that framing had
left implicit, and overturned one earlier call. Recorded here rather than
silently edited above.

### D17. Fixed-phase migration ordering, not a topological sort

**Chose:** Emit migration statements in fourteen fixed dependency phases —
drop indexes, drop foreign keys, drop other constraints, create tables, rename
tables, add columns, rename columns, retype, alter nullability and defaults,
add non-foreign-key constraints, add foreign keys, add indexes, drop columns,
drop tables.

**Considered:** Building a dependency graph over statements and topologically
sorting it, which is what D11 originally said I'd do.

**Reasoning:** The topological sort cannot work, and I only saw why when I
went to write its test. Foreign keys are legitimately circular —
`users.org_id → orgs.id` alongside `orgs.owner_id → users.id` is an ordinary
schema. A topological sort over a cyclic graph has no valid output, so the
"correct" algorithm fails on real input while the cruder one doesn't.

Separating table creation from foreign key creation into different phases
makes the ordering immune to cycles by construction: every table exists before
any foreign key is added, so the cycle never needs to be broken. It is less
code than a graph sort *and* handles a case the graph sort cannot, which is an
unusually clean win.

**What I'd have shipped otherwise:** a plan that passes on every schema I'd
have thought to test and deadlocks on the first circular foreign key a real
user has. The circular case is now an explicit test.

### D18. Constraints and indexes are flat schema-level collections

**Chose:** `Schema` holds three flat arrays — `tables`, `constraints`,
`indexes` — with constraints and indexes carrying a `tableId`.

**Considered:** Nesting constraints and indexes inside their `Table`, which
reads more naturally and matches how people describe schemas.

**Reasoning:** A foreign key spans two tables, so nesting forces a choice of
arbitrary owner and then a special case in diff, merge, and validate for the
one entity kind that doesn't fit the tree. Flat collections make every entity
kind uniform: an ID-keyed set that all four algorithms treat identically. The
nested model reads better in a type definition and costs a branch in every
function that consumes it.

**Related:** nullability is a `Column` attribute, not a `NOT NULL` constraint.
Postgres exposes it both ways; representing it twice would create two code
paths that can disagree about the same fact.

---

---

## Day 0 — Design review: seven cases the design got wrong

A pass over the design hunting for inputs an ordinary user could produce that
the spec mishandled. It found seven. Three were outright bugs in a spec I had
already called finished, and two more were types the product could never
actually produce. Recorded in full rather than quietly corrected, because the
pattern in them is the useful part: **every one is a case where I solved a
problem for one entity kind and assumed it generalised.**

### D19. Delete/modify must be transitive over containment

**Chose:** Deleting an entity conflicts with any change to anything in its
dependency closure — a table owns its columns, constraints and indexes, and is
referenced by foreign keys pointing at it.

**The bug:** Merge compared changes keyed by `(entityId, attribute)`. Dropping
`users` is keyed on the table; adding a column `nickname` to `users` is keyed
on the new column. No key appears on both sides, so the merge reported **clean**
and then tried to add a column to a table that no longer existed.

**Reasoning:** Key-wise comparison only finds people who touched *the same
entity*, but the most common real-world schema conflict is two people touching
*related* entities. That is a conflict rather than a hazard: the resolution is
a genuine either/or (keep the table and Ben's column, or drop both), and the
description has to say plainly that choosing "drop" discards a colleague's
work.

**Why I missed it:** I built conflict detection around the case I had designed
for — two people editing one column — and never asked what happens when the
two changes are at different levels of the tree.

### D20. Renames are emitted before creates, and ordered among themselves

**Chose:** Move renames to phase 4, ahead of table creation and column
addition. Within that phase, order renames by name dependency and break cycles
with a temporary name.

**Considered:** Leaving the original order and documenting name reuse as
unsupported.

**The bug, in two parts.** The original phase list created tables at 4 and
renamed at 5. So renaming `users` to `accounts` and then creating a new
`users` emitted `CREATE TABLE users` while the old `users` still existed —
Postgres rejects it. The end state was valid; the path to it was not. Same
shape on columns: rename `email` away, add a new `email`, crash.

Fixing that exposed a second problem *within* the rename phase. Swapping two
names (`a → b`, `b → a`) has no valid two-statement ordering: whichever runs
first creates a duplicate. It needs a temporary: `a → __tmp_1`, `b → a`,
`__tmp_1 → b`.

**Reasoning:** Both are ordinary refactors, not edge cases — reusing a freed
name is what people do when repurposing a concept, and swapping two names
happens whenever someone decides they were the wrong way round. A tool that
produces a correct final schema and an unrunnable migration has failed at the
only thing the user actually wanted.

**The uncomfortable part:** D17 argued *against* topological sorting, on the
grounds that foreign key cycles have no valid ordering. That reasoning was
right for foreign keys and wrong as a general principle. Renames need a
topological sort *with cycle breaking* — cycles here are resolvable, via a
temporary name, whereas foreign key cycles are resolvable via phases. Two
superficially similar problems, two different correct tools. I generalised
one insight too far and it cost me a bug.

### D21. `alter_constraint` and `alter_index`, or the divergence conflicts are fiction

**Chose:** Add ID-preserving `alter_constraint` and `alter_index` operations.

**The bug:** The operation list offered only add and drop for constraints and
indexes. So "change the primary key" could only be drop-plus-add, which mints
a **new id** — meaning the diff reported an unrelated deletion and creation,
never `constraint_changed`. Two branches each adjusting the same primary key
would merge without conflict and produce a table with two primary keys.

Meanwhile the spec listed `constraint_changed`, `index_changed`,
`constraint_divergence` and `index_divergence`. All four were **unreachable
in practice** — types described in the model that the product could not
produce.

**Reasoning:** This is D3's rename-versus-drop-plus-add failure exactly, one
entity kind over. I solved identity for columns, wrote a taxonomy that assumed
constraints had it too, and never checked whether any operation could actually
produce that state. An unreachable conflict class is worse than a missing one:
the tests pass, the taxonomy table looks complete, and the gap is invisible
until a user hits it.

**Cut:** `kind` and `tableId` are not patchable. Changing either means it is a
different rule — that is drop plus add, honestly.

### D22. `CHECK` predicates are structured, not free text

**Chose:** `Expression = { template: string; columnIds: Id[] }` with numbered
placeholders. Names are substituted at render time. Partial index predicates
use the same type.

**Considered:** Parsing the SQL expression to find referenced columns; leaving
predicates as opaque text and documenting the limitation; dropping `CHECK`
support entirely.

**The bug:** `CHECK (age > 0)` stored as the string `"age > 0"` references a
column *by name, in text*, which nothing can see. Drop `age` and the
constraint dangles undetected. Rename `age` and the predicate silently still
says `age`. The single rule this entire design rests on — never match entities
by name — was violated by the one field whose whole purpose is to express a
rule about columns.

**Reasoning:** Parsing means the SQL parser cut in D14, for one field. But the
editor already knows which columns the user selected, so the information is
free at authoring time — store IDs, keep placeholders, render names at the
end. Renames propagate automatically and `validate` checks `columnIds` exactly
as it does everywhere else.

**Accepted tradeoff:** predicates are composed through the editor rather than
typed as arbitrary SQL. That is a real limitation. It is the right one: a rule
the tool cannot read is a rule it cannot protect, and a `CHECK` that silently
breaks is worse than a `CHECK` you could not express.

### D23. The validator checks what Postgres would reject

**Chose:** Extend the hazard list with `multiple_primary_keys`,
`default_type_mismatch`, `duplicate_constraint_name`, `duplicate_index_name`,
`foreign_key_target_not_unique`, `foreign_key_type_mismatch`, and
`foreign_key_arity_mismatch`.

**The bug:** The original list only found dangling references. It would happily
approve a schema with two primary keys on one table, a default of `'hello'` on
an integer column, two indexes sharing a name, or a foreign key pointing at a
non-unique column — every one of which Postgres rejects outright.

**Reasoning:** A validator that approves a migration the database then refuses
is worse than no validator, because the user trusted it and stopped checking.
The rule adopted: **if Postgres would reject the DDL, `validate` catches it
first.** That is a clear, testable line, and it is the honest scope for
something presented to a user as a safety check.

**Not claimed:** this is still not a Postgres type system. It is a bounded
list, and the boundary is now written down rather than implied.

### D24. Hazard attribution happens in merge, not in validate

**Chose:** `validate(schema) => Hazard[]` stays pure and anonymous. Merge wraps
its output as `AttributedHazard` by correlating each hazard's entity IDs
against both branches' change lists.

**The bug:** The merge screen promised "Ana deleted this, Ben added a rule —
that is why it is broken." `validate`'s signature is `(schema) => Hazard[]`.
It sees a final state and has no idea who produced any part of it. The UI was
promising something the layer beneath it structurally could not deliver.

**Reasoning:** Merge *does* hold `diff(base, ours)` and `diff(base, theirs)`,
so attribution belongs there. Pushing provenance down into `validate` would
mean threading authorship through a pure function that also runs on ordinary
commits where no `ours`/`theirs` exists.

**Stated honestly in the product:** this is correlation, not causation. It
reports who touched the entities involved, which is not proof of blame. The UI
says "touched", never "caused", and falls back to stating the defect alone
when only one side correlates or the hazard predates the merge. Better to say
less than to confidently name the wrong colleague.

### D25. What this review changed about how I work on this

The seven findings share one shape: a decision that was correct for the entity
kind I had in front of me, applied by assumption to entity kinds I had not
re-examined. Identity for columns but not constraints (D21). Name-free
references everywhere except predicates (D22). Conflict detection between peers
but not across containment (D19). Cycle reasoning correct for foreign keys and
overgeneralised to renames (D20).

The countermeasure is in the plan rather than in prose: every one of the seven
is now a named regression test, and the phase ordering, rename cycles, and
containment conflicts each get their own failing test written *before* the
implementation. The design being wrong is cheap at this stage. It would not
have been cheap on day 4.

---

## Log

Entries below are added as the build progresses.
