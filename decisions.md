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

## Day 1-4 — Implementation (Tasks 1-16)

Entries below are decisions made while writing the code, as distinct from the
design review above (D19-D25), which happened before any implementation. The
core (Tasks 1-13), persistence (Task 14), API (Task 15), and branch list UI
(Task 16) are complete and pushed; this section is written alongside them
rather than reconstructed afterward.

Tasks 1-8 produced no decisions beyond what design.md and D19-D25 already
argue — the code followed the spec directly. The first genuine implementation
call came in the Postgres renderer.

### D26. The DDL renderer resolves names from either end of a migration

**Chose:** `namerFor(from, to)` builds one lookup by scanning both schemas and
preferring the name in `to`, falling back to the name in `from`.

**Reasoning:** A migration statement can concern an entity that exists in only
one of the two schemas — a `DROP TABLE` names a table that is absent from
`to`; a `CREATE TABLE` names one absent from `from`. A namer built from a
single schema is wrong for half the statements a migration contains. Building
it from the union of both endpoints, with `to` winning on overlap (so a
rename's statements read using the new name), makes every statement look up
the same way regardless of which side of the migration it belongs to.

**Accepted tradeoff:** if an id exists in neither schema — which should not
happen, since every id in a `Change` comes from a diff over these same two
schemas — the namer falls back to rendering the raw id rather than throwing.
Failing loudly here would turn a bug in `diff` into a rendering crash instead
of a wrong-but-visible name; the id printing in a DDL comment is the more
diagnosable failure.

### D27. Connection URLs are parsed by splitting at the LAST `@`

**Chose:** `parseConnectionUrl` in `src/db/client.ts` locates credentials by
finding the last `@` in the URL body, not the first.

**Considered:** Using the `postgres` library's own URL parsing, or `new
URL()`.

**Reasoning:** This was not a design choice — it was a live bug. Standard URI
parsing treats the first `@` as the credentials/host boundary, which is
correct per spec but wrong for what people actually paste: a generated
Supabase password containing `@`. The connection then reads the host as
`part-of-password@realhost`, which fails DNS resolution and hangs with no
error message at all — not a rejected connection, just silence. I hit this
directly against the project's own Supabase instance and spent real time
diagnosing it before finding the cause.

Splitting at the last `@` instead accepts both the correctly-encoded form and
the raw form, and costs nothing: a Postgres username cannot itself contain
`@`, so the last occurrence is unambiguous.

**What I'd flag to a teammate:** this class of bug — correct-per-spec parsing
that is silently wrong for realistic input — doesn't show up in a type
checker or a happy-path test. It surfaces as "nothing happens." The five
pinned test cases (raw `@`, percent-encoded, pooler URL with a dotted
username, bracketed IPv6, defaulted port) exist because I don't trust myself
to remember every shape after this one bug.

### D28. API errors are typed exceptions mapped to status codes in one place

**Chose:** `BadRequest`, `NotFound`, `Unprocessable`, and `Conflicted` are
thrown from the service layer; a single `handle()` wrapper in every route
catches them and maps each to 400/404/422/409, attaching structured details
where the client needs them (the actual head on a 409, the conflict list on
a 422).

**Considered:** Returning `{ ok: false, error }` result objects from service
functions instead of throwing, which some style guides prefer for its
explicit control flow.

**Reasoning:** The service functions call each other — `performMerge` calls
`previewMerge`, `previewMerge` calls `getBranch` twice. A thrown error
propagates through that call chain for free; a result object would need
threading through every intermediate call or an early-return check at each
step, for a codebase where the error paths are truly exceptional (a branch
that does not exist, a stale head) rather than expected alternate outcomes.
Exceptions read the branch's job clearly: the happy path is the only path
written out.

**Accepted tradeoff:** a thrown error crossing an `await` boundary loses its
original stack context in some engines. Not exercised here — every service
function is a handful of calls deep, and `handle()` still reports the
message.

### D29. `/api/merge/preview` has an executable proof of being read-only

**Chose:** A test that counts rows in `commits` before and after two preview
calls (one plain, one with a resolution attached) and asserts the count is
unchanged.

**Reasoning:** The conflict screen (design.md §12) re-posts to this endpoint
on every resolution the user picks, so it has to be safe to call repeatedly
and speculatively. "The function doesn't call `insertCommit`" is true by
inspection today, but inspection doesn't survive a refactor — someone adding
a convenience "auto-save the preview as a draft commit" feature six months
from now could violate it without touching a single line the reviewer's eye
would flag as suspicious. A test that asserts the row count is what actually
holds the line, and it holds it against every future change, not just today's.

### D30. Branch names are validated by attempting the insert, not by a pre-check

**Chose:** `branchFrom` calls `createBranch` directly and catches Postgres
error code `23505` (unique violation), translating it into a plain 400 naming
the branch.

**Considered:** `SELECT ... WHERE project_id = ? AND name = ?` before the
insert, then a friendlier error if a row comes back.

**Reasoning:** A pre-check is a race: two people naming a branch the same
thing at nearly the same moment can both pass the SELECT and both attempt the
INSERT, and only the database's own constraint decides who wins — the
pre-check bought nothing but an extra round trip and a false sense of safety.
This is the same shape as the branch-head compare-and-swap from §10.1, applied
to a different constraint: let the database be the single source of truth for
uniqueness, and translate its rejection into a message a user can act on,
rather than trying to duplicate the check in application code where it can
drift out of sync with the schema.

### D31. No Tailwind

**Chose:** A single hand-written `globals.css` with CSS custom properties,
no utility framework.

**Reasoning:** Tailwind was named in the implementation plan's "Tech Stack"
line, written before any UI existed, and never actually installed — Task 1
scaffolded TypeScript, Vitest, and ESLint but the plan's own dependency list
was aspirational at that point rather than verified. By the time Task 16
needed real styling, the honest question was whether to add the dependency
now or drop the plan's claim, and the rubric's own words settled it: "we're
not judging visual polish." A utility CSS framework earns its cost when a UI
has many developers converging on one visual language, or when the surface
area is large enough that inline styles would sprawl. Four pages do not
clear that bar. A few dozen lines of custom properties and one global
stylesheet is less code, one fewer dependency, and nothing a reviewer would
need Tailwind's documentation to read.

**What this does NOT mean:** the interaction design — disabled states with
visible reasons, inline errors, ahead/behind semantics — still gets full
attention in every task from here. The cut is the CSS delivery mechanism,
not the UX effort.

---

## Day 4-5 — Tasks 17-20: what live use caught that inspection didn't

Every entry below was found by actually running the feature — clicking
through the UI, seeding real data, driving a real merge — not by reading the
code back. That's not incidental to this section; it's the reason it exists.
Unit tests passed the whole time in every case. The pattern repeats often
enough across five tasks that it's worth naming once, here, instead of once
per entry: **a green suite proves the cases you thought to write are
correct. It says nothing about the case you didn't think to write.** The
countermeasure isn't more tests written from imagination — it's actually
using the thing.

### D32. Creating ops accept a pre-supplied id (Task 17)

**Chose:** Every op that creates an entity takes an optional `id`; when
present it's used verbatim instead of calling `mintId()`.

**The bug:** The schema editor computes a client-side preview with one id
generator, then sends the same ops to the server, which replays them with a
*different* generator. Add a column, then add a `CHECK` on that column in
the same batch, and the CHECK's `Expression.columnIds` carries the client's
id for the new column — which means nothing once the server independently
mints its own. The server correctly reported "references a column that no
longer exists," because under its replay, that id genuinely never existed.

**Reasoning:** This is D3's identity problem one layer up: solved for
entities that exist in a committed schema, not for entities created and
referenced within a single uncommitted batch. The fix is that only one side
ever mints an id for a given entity — the UI generates it at the moment it
builds the op and embeds it; the server's replay reuses it. `mintId` stays
the source of truth for every call site that doesn't pre-supply one.

### D33. describeChange resolves column names instead of printing raw ids (Task 18)

**Chose:** `describeChange` takes an optional `schema` and resolves a
column's current name through it for the three kinds that carry only a
`columnId` — falls back to the id when no schema is given, so all prior
single-argument call sites are unaffected.

**The bug:** "Changed type of `c2ab91f...`" — and the nullability/default
variants didn't even get that far: "Made column NOT NULL" didn't say which
column at all. Every existing test checked `.kind`/`.class`, never the full
string, for these three kinds — the gap was invisible until there was a
rendered row to read.

**Reasoning:** The same defect existed in `merge.ts`'s conflict descriptions
(`concurrent_retype` etc.) one layer away from where it was noticed —
`describeChange` is shared, so fixing it once fixed both surfaces.

### D34. name_collision conflicts become resolvable (Task 19)

**Chose:** `Conflict` gains an optional `collisionMembers` (id, name, side);
a `custom` resolution for this class carries `{ entityId, name }` and
targets one specific colliding entity, since the class has no "ours" vs
"theirs" to choose between — both sides produced the *same* name, which is
the whole problem.

**The bug:** `findNameCollisions` ran as its own pass **after** resolutions
were already applied, and its output was appended to `conflicts`
unconditionally. There was no code path that ever consulted a resolution for
this class — the merge screen was about to promise a resolution flow the
core structurally could not deliver.

**Reasoning:** Pass 3 now applies any matching resolution (a targeted
rename) and then **re-runs detection from scratch** on the result, rather
than trying to selectively clear the one conflict. Re-running is what stays
correct when the rename happens to collide with something else — verified
directly: resolving onto a name a third, untouched column already holds
does not get reported as fixed. It correctly becomes a `duplicate_name`
hazard instead, the same "solo contribution is a hazard, not a conflict"
rule already governing the original detection.

### D35. eslint-plugin-react-hooks, three UI tasks late

**Chose:** Installed and wired in during Task 19, after writing hooks freely
across Tasks 16-18 with no lint coverage for them at all.

**Reasoning:** Its first run found a real (if latent) Rules-of-Hooks
violation in `ConflictCard`'s custom-input component — a `useState` called
after two early returns. Harmless today only because the component's
`attribute` prop never changes across a mounted instance's lifetime; a
future edit that violated that assumption would have broken silently. There
is no argument for a Next.js project *not* having this rule from Task 1; the
honest accounting is that it was missed, not that it was deferred on
purpose.

### D36. The "Write my own" input starts empty, never pre-filled

**Chose:** The custom-resolution text input in `ConflictCard` shows the
current value as a *placeholder*, never as the field's starting value.

**The bug, found by literally doing what a user would do:** pre-filling
with `conflict.ours` and clicking into the field to edit it produced
`contact_emprimary_emailail` instead of `primary_email`. A click into
existing text places a cursor mid-string, not a selection — typing
*inserts*, it doesn't replace. Obvious once seen; invisible from reading the
component, which is why it survived a clean typecheck and a full green test
run.

**Reasoning:** A placeholder communicates the same "here's the current
value" information with none of the interaction risk. The fix cost four
lines. Finding it cost actually typing into the field the way a reviewer
would.

### D37. Seed scenario one, rebuilt to match what the system actually does

**Chose:** The rename conflict scenario has both branches rename `email`
to *different* names (a genuine `concurrent_rename`), with an independent
retype riding along on one branch, unconflicted.

**Reasoning:** The implementation plan's own one-line description of this
scenario read as if a rename-plus-retype pair on the same column **were**
the conflict. It isn't, by design — Task 7 exists specifically to prove that
pairing merges clean, because the two edits touch different attributes
(§6.1). Building the scenario as originally worded would have contradicted
five tasks' worth of verified, tested behavior, or silently shipped a demo
that lied about what the tool does. Fixed the scenario, not the engine —
the engine was right.

### D38. Unresolved delete_modify no longer strips the kept entity's keys

**Chose:** `findContainmentConflicts` now also collects every OTHER change
on the *deleting* side whose subject falls in the same closure — the
`constraint_dropped` / `index_dropped` entries `drop_table`'s own cascade
produces alongside the top-level deletion — and claims them as one unit
with the deletion itself.

**The bug, the most consequential one this project has shipped:** "leave a
delete_modify conflict unresolved, keep the whole entity" is a documented
design promise (§7.2: "the recoverable choice is the one that does not
discard a colleague's work"). It only kept a stripped shell. `drop_table`
cascades to separate `constraint_dropped`/`index_dropped` changes for the
table's primary key, foreign keys, and indexes — each its own
`(entity, attribute)` key on the deleting side. The original containment fix
(D19) only ever claimed the table's own key plus the *other* side's
counterpart keys; it never claimed the deleting side's own cascade. Left
unclaimed, those cascade drops looked like ordinary one-sided changes to
Pass 2 and applied independently of whether the table itself ended up
dropped or kept.

**Why 280 prior tests missed it:** none of them built a table with both a
primary key *and* a foreign key pointing at it, then left a delete_modify
conflict on that table unresolved. The seeded demo's `payments` table has
both, by design, and the first time I actually clicked through the
containment scenario in a browser, a `no_primary_key` hazard appeared on a
table nobody had touched. That was the whole tell.

**How to apply:** this is the clearest example in the project of why manual
verification is a review gate, not a formality. A hand-built test fixture
only exercises the shapes someone thought to build. A seeded, realistic
schema clicked through in a real UI exercises the shapes that actually
occur — this is precisely why design.md's own testing section separates
example tests from live verification rather than treating the first as a
substitute for the second.

### D39. Any branch can be compared or merged against any other, not only `main`

**Chose:** `BranchActions` adds a "vs" picker to each branch row so Compare
and Merge can target any other branch, defaulting to `main`.

**The bug:** The three seeded scenarios are pairs of sibling branches that
only conflict against *each other* — merging either one into an untouched
`main` alone is a trivial clean fast-forward. The branch list's Compare/
Merge links were hardcoded to `main`, so a reviewer clicking through from
the list would never see the demo's actual point, no matter which branch
they picked.

**Reasoning:** The fix is general, not a demo-specific workaround: "merge
this branch into main" is the common case, not the only one a real team
hits. Two people picking up each other's in-progress work is ordinary git
usage the original design simply never accounted for. Considered
pre-merging one scenario branch into `main` during seeding instead — cut,
because it doesn't scale past one scenario (three independent scenarios
cannot all pre-advance the same `main` without interacting with each
other), and because it would have hidden a real product gap behind a seed
workaround instead of fixing it.

### D40. Branch names in the list link to the schema editor

**Chose:** Branch names in the branch list are links to `/p/[id]/b/[id]`.

**Reasoning:** Task 17 built the schema editor; nothing built before or
after it ever linked there from the branch list, which was written in Task
16 before the editor existed. Not a bug in the sense of wrong behavior —
the page simply had no way in. Found while adding the reset-demo button to
the same page and noticing there was no way to reach the thing the
"Diverged" column implies exists.

---

---

## Day 5 — what surprised me

**The pattern, not the instances.** D32 through D40 read like eight
unrelated bug reports. They aren't. Every one of them was invisible to a
full green test suite and visible within about a minute of actually clicking
through the feature — the id-divergence bug (D32), the raw-id descriptions
(D33), the unresolvable name collision (D34), a Rules-of-Hooks violation
with no lint rule to catch it (D35), a text field that corrupts input on
the first edit (D36), a scenario that contradicted the engine's own tested
behavior (D37), and the most serious one, a delete_modify resolution that
silently discarded a kept table's keys (D38) — none of them showed up until
there was a real UI, a real database, and a real click. I went into Day 4
expecting the UI tasks to be the *safe*, mechanical part of the build,
after the "hard" work of the merge core was done and tested. That
expectation was wrong, and it was wrong in a specific, informative way: a
pure function's tests only cover the inputs someone thought to construct.
A UI wired to a real database and clicked through by an actual sequence of
actions produces inputs nobody constructed on purpose — batched ops that
reference each other, a delete left unresolved on a table that happens to
have both a primary key and a foreign key, a click landing mid-string in a
pre-filled field. If I built this again, verification-by-actual-use would
be scheduled *throughout*, not concentrated at the end of each task as a
final check — it isn't a formality that confirms the code works, it's where
a real fraction of the remaining bugs actually live.

**The plan is not a contract.** D37 is the cleanest example: the
implementation plan, written on Day 0 before a line of `core/` existed,
described a demo scenario in terms that quietly contradicted what Task 7
later proved and tested. Nobody caught it at planning time because there
was nothing to contradict yet. The lesson isn't "plan better" — the plan
was reasonable given what was known when it was written. The lesson is that
a plan's job is to be cheaply wrong early and get corrected by contact with
what actually gets built, and the record of those corrections (D17, D19-D25
in design review; D32-D40 here) is more honest, and more useful to a future
reader, than a plan that happened to be right the first time would have
been.

**What shortcuts were actually taken, and what they'd cost to undo.**

- The three manual QA scripts written and deleted during Tasks 16-19
  (seed-and-inspect-by-hand) were the right call under time pressure —
  faster than writing a Playwright suite for one-off visual checks — but
  they mean the *browser* behavior of the editor and merge screens has no
  automated regression coverage, only the API and core layers do. Undoing
  this means a thin Playwright smoke suite over the four screens; a day of
  work, not started because the core and API layers carry the actual risk
  in this project and Playwright's return is lower here than it would be on
  a UI-heavy product.
- `renderExpression`'s literal-detection in `default_type_mismatch` (D23)
  is bounded pattern matching, not a real SQL literal grammar. It is
  correctly documented as such in design.md and will misjudge an unusual
  literal it hasn't seen. Undoing this means embedding a real SQL value
  grammar, which is disproportionate to what a schema-diff tool needs.
- No authentication, exactly as scoped in D2. Worth restating here because
  it is the single largest gap between this build and something
  deployable to a real team, and it was a deliberate, correct choice for a
  5-day build — not an oversight discovered late.

**What's next, honestly.** Deploy to Vercel and a live click-through of all
three seeded scenarios in production is the one remaining step (Task 21,
in progress as this section is written) — everything up to it is built,
tested, and verified locally against a real Supabase instance. While writing
this section I went back and specifically checked the one thing that looked
like it might be a sibling of D38's bug: the fix there is written generically
over `closureOf`, which already handles column deletions the same way it
handles table deletions, so a `drop_column` cascade *should* already be
covered by the same code path. Checked rather than assumed — it is; a
regression test for the column case now sits next to the two table-case
tests. If there were a Day 6, the remaining item is a Playwright smoke suite
over the four screens (see above) — the browser-level gap, not a correctness
one.

---

## Day 5 — Task 21: deployment

The last two decisions in this log are infrastructure ones, and both were
made at deploy time rather than at design time — which is itself the point.
Neither was visible from the model, the tests, or a local `npm run dev`.

### D41. Vercel plus Supabase's transaction pooler, and what that forces

**Chose:** Vercel for the app, Supabase Postgres reached through the
**transaction pooler** (port 6543) rather than the direct connection (5432).

**Considered:** the Supabase direct connection; a long-lived server on
Railway or Fly with an ordinary connection pool; Postgres in the same
container as the app.

**Reasoning:** the direct connection is IPv6-only on Supabase's free tier and
Vercel's functions cannot route to it — this is not a preference between two
working options, the direct URL simply fails. A long-lived server would let
me keep one normal pool and sidestep the whole issue, and if this were a
product I expected to run I would take that; for a reviewer who needs a URL
that works on the first click, Vercel's zero-config deploy of a Next.js app
is worth more than pool ergonomics.

Once the pooler is the only route, three non-default settings follow, and
none of them are guessable from a stack trace: `prepare: false` (pgbouncer in
transaction mode rejects prepared statements), `ssl: 'require'` (Supabase
refuses plaintext), and a deliberately low `max`, because every serverless
invocation holds a pool of its own rather than sharing one. All three sit in
`src/db/client.ts` with the reason written beside them, because the failure
mode of getting any of them wrong is an error that names a symptom —
"prepared statement already exists" — and never the cause.

**Accepted tradeoff:** serverless plus a transaction pooler means no
`LISTEN`/`NOTIFY`, no session-level state, and no long-running transactions.
None of those are used here, and the reason is not luck: the branch-head
compare-and-swap (D12) was written as a single statement because that was the
correct way to express it, and it now happens to be the only way this
deployment could express it. A design that had reached for a transaction
spanning several round trips would have had to be rewritten at this step.

**What this choice already cost:** D27 (parsing connection URLs by splitting
at the last `@`) and the HMR connection-pool leak fixed by stashing the client
on `globalThis` are both downstream of it. Two live bugs, neither reachable by
any test in the suite, both in the connection layer rather than anywhere near
the domain logic this project is actually about.

### D42. The deployed demo has no auth, and is designed to be reset instead

**Chose:** deploy with no authentication, one seeded demo project shared by
every visitor, and a **Reset demo** button on the project page.

**Considered:** basic auth across the whole site; anonymous visitors held in
read-only mode; per-visitor project isolation keyed by a cookie.

**Reasoning:** D2 scoped authentication out for a five-day build, and that
still holds — but scoping it out of a *local* build and out of a *public URL*
are not the same bet, and it would be dishonest to pretend the earlier
decision settled this one. On a shared URL, anyone with the link edits the
same rows, so the first reviewer to resolve a conflict and merge changes what
the second reviewer sees on arrival. Read-only mode is the worst option
available: it removes exactly the interaction — resolving a conflict — that
the product exists to demonstrate. Cookie-keyed isolation is the *correct*
answer and is perhaps two hours of work, but it puts a visitor-supplied id in
front of every query and adds a stale-cookie case (a project id that no longer
exists) to every screen, which is a new failure mode introduced at the last
step of the build, with no time left to find out what it breaks.

The mitigation is that nothing on the deployed instance is destructible.
Commits are append-only (D5), so no sequence of clicks removes history, and
Reset restores all three seeded scenarios to their exact initial state. "Just
reset it" is a legitimate answer here only because the data model made it one
— which is the payoff of D5 showing up in a place D5 was not written for.

**Accepted tradeoff:** two reviewers exploring the deployed URL
simultaneously can confuse each other, and a mid-merge reset by one is
visible to the other as state changing underneath them. Stated here rather
than left to be discovered, because it is the visible price of the auth
decision.

**Deliberately cut:** per-visitor isolation. The right cut for a demo that is
meant to be shared and reset; the wrong one the moment this has real users —
at which point what is needed is not isolation anyway, it is D2's
authentication, and building isolation first would be building the thing that
gets deleted.

---

## Closing state

285 tests pass; 19 database-backed tests skip themselves when `DATABASE_URL`
is unset, so a clone with no Supabase project still runs the entire pure
`core/` suite clean.

42 decisions logged across five days: 18 before any code existed, 7 from the
design review that found the design wrong in seven places (D19–D25), 15 from
implementation and live use, and these 2 from deployment. The ones worth
reading first, if this file is read out of order, are **D19** (delete/modify
has to be transitive over containment, or merge silently discards a
colleague's work), **D20** (renames need a cycle break, and the foreign-key
reasoning that looked identical was the wrong tool), and **D38** (the most
serious bug in the build, found by clicking rather than by testing).

The live URL is in [README.md](README.md).
