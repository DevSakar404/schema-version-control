import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, hasDatabase, closeDb, parseConnectionUrl } from '@/db/client';
import { createProject } from '@/db/projects';
import { insertCommit, getCommit, getCommitGraph } from '@/db/commits';
import { advanceHead, createBranch, listBranches } from '@/db/branches';
import { emptySchema } from '@/core/schema';
import { nanoIdGen } from '@/core/ids';
import type { Commit } from '@/core/history';

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
