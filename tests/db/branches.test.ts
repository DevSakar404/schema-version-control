import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, hasDatabase, closeDb, parseConnectionUrl, explainConnectionError } from '@/db/client';
import { createProject } from '@/db/projects';
import { insertCommit, getCommit, getCommitGraph } from '@/db/commits';
import { advanceHead, createBranch, listBranches, getBranch } from '@/db/branches';
import { createNewProject } from '@/server/branches-service';
import { emptySchema } from '@/core/schema';
import { nanoIdGen } from '@/core/ids';
import type { Commit } from '@/core/history';

describe('explainConnectionError', () => {
  // Pure — runs with no database. Pins the setup experience: a fresh clone
  // whose DATABASE_URL is Supabase's default (direct) connection fails with
  // an error naming neither Supabase nor IPv6. Regression test for the day a
  // teammate hit exactly this and had to be told the fix out of band.
  const withUrl = (url: string | undefined, fn: () => void) => {
    const previous = process.env.DATABASE_URL;
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  };

  const unroutable = Object.assign(
    new Error('connect ENETUNREACH 2406:da1c:e01:b00::5:5432'),
    { code: 'ENETUNREACH' },
  );

  it('names the transaction pooler when the direct connection is unroutable', () => {
    withUrl('postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres', () => {
      const text = explainConnectionError(unroutable);
      expect(text).toContain('Transaction pooler');
      expect(text).toContain('6543');
      expect(text).toContain('db.abcdef.supabase.co');
      // The driver's own text is kept, not swallowed.
      expect(text).toContain('ENETUNREACH');
    });
  });

  it('stays quiet when the host is already the pooler', () => {
    // Same error, different cause — the machine is offline, or the pooler is
    // down. Telling someone to switch to the pooler they are already on is
    // worse than saying nothing.
    withUrl('postgresql://postgres.abcdef:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres', () => {
      expect(explainConnectionError(unroutable)).toBe(unroutable.message);
    });
  });

  it('stays quiet for a non-Supabase host and for an unset URL', () => {
    withUrl('postgres://u:p@localhost:5432/postgres', () => {
      expect(explainConnectionError(unroutable)).toBe(unroutable.message);
    });
    withUrl(undefined, () => {
      expect(explainConnectionError(unroutable)).toBe(unroutable.message);
    });
  });

  it('passes unrelated errors through untouched', () => {
    withUrl('postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres', () => {
      const other = new Error('password authentication failed for user "postgres"');
      expect(explainConnectionError(other)).toBe(other.message);
    });
  });
});

describe('parseConnectionUrl', () => {
  // Pure — runs with no database. This is the parser that made a real
  // connection hang silently, so it is pinned here.
  it('splits at the LAST @, so an unencoded password @ still works', () => {
    const o = parseConnectionUrl('postgresql://postgres:Pa@ss1@db.example.supabase.co:5432/postgres');
    expect(o.host).toBe('db.example.supabase.co');
    expect(o.port).toBe(5432);
    expect(o.username).toBe('postgres');
    expect(o.password).toBe('Pa@ss1');
  });

  it('percent-decodes an encoded password', () => {
    expect(parseConnectionUrl('postgres://u:a%40b@h:5432/d').password).toBe('a@b');
  });

  it('handles a pooler URL with a dotted username', () => {
    const o = parseConnectionUrl('postgresql://postgres.abcdef:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
    expect(o.username).toBe('postgres.abcdef');
    expect(o.port).toBe(6543);
    expect(o.database).toBe('postgres');
  });

  it('handles a bracketed IPv6 host', () => {
    const o = parseConnectionUrl('postgres://u:p@[2406:da1c::1]:5432/postgres');
    expect(o.host).toBe('2406:da1c::1');
    expect(o.port).toBe(5432);
  });

  it('defaults the port and database when omitted', () => {
    const o = parseConnectionUrl('postgres://u:p@localhost');
    expect(o.port).toBe(5432);
    expect(o.database).toBe('postgres');
  });
});

// Skips itself when DATABASE_URL is absent, so the core suite runs anywhere.
describe.skipIf(!hasDatabase())('persistence', () => {
  const projectId = `test_${nanoIdGen()}`;
  let rootCommit: Commit;

  const commit = (id: string, parentIds: string[] = []): Commit => ({
    id, projectId, parentIds,
    schema: emptySchema(),
    message: `commit ${id}`,
    author: 'test',
    createdAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    await createProject('vitest fixture', projectId);
    rootCommit = commit(`c_${nanoIdGen()}`);
    await insertCommit(rootCommit);
  });

  afterAll(async () => {
    await db()`delete from projects where id = ${projectId}`; // cascades
    await closeDb();
  });

  it('round-trips a commit, schema included', async () => {
    const back = await getCommit(rootCommit.id);
    expect(back?.message).toBe(rootCommit.message);
    expect(back?.schema).toEqual(emptySchema());
    expect(back?.parentIds).toEqual([]);
  });

  it('builds a commit graph with parent links intact', async () => {
    const child = commit(`c_${nanoIdGen()}`, [rootCommit.id]);
    await insertCommit(child);
    const graph = await getCommitGraph(projectId);
    expect(graph.get(child.id)?.parentIds).toEqual([rootCommit.id]);
  });

  it('rejects two branches with the same name in one project', async () => {
    await createBranch(projectId, 'dup', rootCommit.id);
    await expect(createBranch(projectId, 'dup', rootCommit.id)).rejects.toThrow();
  });

  describe('advanceHead — compare-and-swap (design.md §10.1)', () => {
    it('succeeds when the expected head matches', async () => {
      const branch = await createBranch(projectId, `b_${nanoIdGen()}`, rootCommit.id);
      const next = commit(`c_${nanoIdGen()}`, [rootCommit.id]);
      await insertCommit(next);

      const moved = await advanceHead(branch.id, rootCommit.id, next.id);
      expect(moved?.headCommitId).toBe(next.id);
    });

    it('returns null when the expected head is stale', async () => {
      const branch = await createBranch(projectId, `b_${nanoIdGen()}`, rootCommit.id);
      const next = commit(`c_${nanoIdGen()}`, [rootCommit.id]);
      await insertCommit(next);

      const stale = await advanceHead(branch.id, 'a-head-that-never-existed', next.id);
      expect(stale).toBeNull();

      const branches = await listBranches(projectId);
      expect(branches.find((b) => b.id === branch.id)?.headCommitId).toBe(rootCommit.id);
    });

    it('two concurrent advances from the same head: exactly one wins', async () => {
      // The whole premise is a team sharing a database, so this is Tuesday,
      // not an exotic edge case. Last-write-wins would silently discard a merge.
      const branch = await createBranch(projectId, `b_${nanoIdGen()}`, rootCommit.id);
      const a = commit(`c_${nanoIdGen()}`, [rootCommit.id]);
      const b = commit(`c_${nanoIdGen()}`, [rootCommit.id]);
      await insertCommit(a);
      await insertCommit(b);

      const results = await Promise.all([
        advanceHead(branch.id, rootCommit.id, a.id),
        advanceHead(branch.id, rootCommit.id, b.id),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);

      const winner = results.find(Boolean)!;
      const branches = await listBranches(projectId);
      expect(branches.find((x) => x.id === branch.id)?.headCommitId).toBe(winner.headCommitId);
    });
  });
});

// Skips itself when DATABASE_URL is absent, same as `persistence` above.
describe.skipIf(!hasDatabase())('createNewProject', () => {
  it('creates a project with an empty schema on its main branch, ready to edit', async () => {
    const project = await createNewProject('vitest new-project fixture');
    try {
      expect(project.name).toBe('vitest new-project fixture');

      const branches = await listBranches(project.id);
      expect(branches).toHaveLength(1);
      expect(branches[0]!.name).toBe('main');

      const main = await getBranch(branches[0]!.id);
      const head = await getCommit(main!.headCommitId);
      expect(head?.parentIds).toEqual([]);
      expect(head?.schema).toEqual(emptySchema());
    } finally {
      await db()`delete from projects where id = ${project.id}`; // cascades to the commit and branch
    }
  });
});
