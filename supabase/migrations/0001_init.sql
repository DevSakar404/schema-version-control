-- Schema version control — persistence (design.md §10).
--
-- Three tables. Commits are append-only and immutable; branches are mutable
-- pointers advanced only by compare-and-swap. Idempotent, so re-running is safe.

create table if not exists projects (
  id          text primary key,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create table if not exists commits (
  id          text primary key,
  project_id  text        not null references projects (id) on delete cascade,
  -- 0 entries for the root, 1 for an ordinary commit, 2 for a merge.
  parent_ids  text[]      not null default '{}',
  "schema"    jsonb       not null,
  message     text        not null,
  author      text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_commits_project on commits (project_id);

create table if not exists branches (
  id              text primary key,
  project_id      text        not null references projects (id) on delete cascade,
  name            text        not null,
  head_commit_id  text        not null references commits (id),
  created_at      timestamptz not null default now(),
  -- Two branches in one project cannot share a name. This is the constraint
  -- the UI relies on instead of a read-then-write existence check.
  unique (project_id, name)
);

create index if not exists idx_branches_project on branches (project_id);
