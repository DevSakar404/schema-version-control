import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, hasDatabase, closeDb } from '@/db/client';
import { POST as mergePreview } from '@/app/api/merge/preview/route';
import { POST as mergeCommit } from '@/app/api/merge/route';
import { GET as compare } from '@/app/api/compare/route';
import { seedProject, type Seeded } from './_seed';

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request('http://test/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

describe.skipIf(!hasDatabase())('HTTP API', () => {
  let seed: Seeded;
  let ana: { id: string; headCommitId: string };
  let ben: { id: string; headCommitId: string };
  let clean: { id: string; headCommitId: string };

  beforeAll(async () => {
    seed = await seedProject();
    // Ana and Ben rename the same column differently -> concurrent_rename.
    ana = await seed.branch('ana', [{ kind: 'rename_column', columnId: 's3', name: 'contact_email' }]);
    ben = await seed.branch('ben', [{ kind: 'rename_column', columnId: 's3', name: 'email_address' }]);
    // A branch that merges cleanly.
    clean = await seed.branch('clean', [
      { kind: 'add_column', tableId: 's1', name: 'nickname', type: { kind: 'text' }, nullable: true, default: null },
    ]);
  });

  afterAll(async () => {
    await db()`delete from projects where id = ${seed.projectId}`;
    await closeDb();
  });

  describe('GET /api/compare', () => {
    it('reports a rename as a rename, not a drop plus an add', async () => {
      const res = await compare(new Request(`http://test/api/compare?base=${seed.mainBranchId}&head=${ana.id}`));
      const { body } = await json(res);
      expect(body.data.changes).toHaveLength(1);
      expect(body.data.changes[0].kind).toBe('column_renamed');
    });

    it('400s when a required query parameter is missing', async () => {
      const res = await compare(new Request('http://test/api/compare?base=x'));
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/merge/preview', () => {
    it('returns the conflict and a migration', async () => {
      const { status, body } = await json(await post(mergePreview, { target: ana.id, source: ben.id }));
      expect(status).toBe(200);
      expect(body.data.conflicts).toHaveLength(1);
      expect(body.data.conflicts[0].class).toBe('concurrent_rename');
      expect(body.data.mergeable).toBe(false);
      expect(body.data.blockedBy).toContain('conflict');
    });

    it('WRITES NOTHING — the conflict screen re-posts here on every keystroke', async () => {
      const before = await db()`select count(*)::int as n from commits where project_id = ${seed.projectId}`;
      await post(mergePreview, { target: ana.id, source: ben.id });
      await post(mergePreview, { target: ana.id, source: ben.id, resolutions: [{ conflictId: 's3:name', choice: 'theirs' }] });
      const after = await db()`select count(*)::int as n from commits where project_id = ${seed.projectId}`;
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('a resolution changes the resulting schema and clears the conflict', async () => {
      const { body } = await json(await post(mergePreview, {
        target: ana.id, source: ben.id,
        resolutions: [{ conflictId: 's3:name', choice: 'theirs' }],
      }));
      expect(body.data.conflicts).toHaveLength(0);
      expect(body.data.mergeable).toBe(true);
      const users = body.data.schema.tables.find((t: { name: string }) => t.name === 'users');
      expect(users.columns.map((c: { name: string }) => c.name)).toContain('email_address');
    });

    it('a custom resolution takes a third name neither branch proposed', async () => {
      const { body } = await json(await post(mergePreview, {
        target: ana.id, source: ben.id,
        resolutions: [{ conflictId: 's3:name', choice: 'custom', value: 'primary_email' }],
      }));
      expect(body.data.conflicts).toHaveLength(0);
      const users = body.data.schema.tables.find((t: { name: string }) => t.name === 'users');
      expect(users.columns.map((c: { name: string }) => c.name)).toContain('primary_email');
    });

    it('a clean merge produces a migration with real DDL', async () => {
      const { body } = await json(await post(mergePreview, { target: seed.mainBranchId, source: clean.id }));
      expect(body.data.mergeable).toBe(true);
      expect(body.data.statements.length).toBeGreaterThan(0);
      expect(body.data.sql).toContain('ADD COLUMN');
    });

    it('404s for a branch that does not exist', async () => {
      const res = await post(mergePreview, { target: 'nope', source: clean.id });
      expect(res.status).toBe(404);
    });

    it('400s when a required field is missing', async () => {
      const res = await post(mergePreview, { target: ana.id });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/merge', () => {
    it('422s while conflicts are unresolved, rather than committing half a merge', async () => {
      const { status, body } = await json(await post(mergeCommit, {
        target: ana.id, source: ben.id, expectedHead: ana.headCommitId, author: 'ana',
      }));
      expect(status).toBe(422);
      expect(body.error.code).toBe('not_mergeable');
      expect(body.data.conflicts).toHaveLength(1);
    });

    it('409s on a stale expectedHead and names the actual head', async () => {
      const { status, body } = await json(await post(mergeCommit, {
        target: seed.mainBranchId, source: clean.id,
        expectedHead: 'a-head-that-never-existed', author: 'ana',
      }));
      expect(status).toBe(409);
      expect(body.error.code).toBe('branch_moved');
      expect(body.data.actualHead).toBe(seed.rootCommitId);
    });

    it('commits a clean merge and advances the branch head', async () => {
      const { status, body } = await json(await post(mergeCommit, {
        target: seed.mainBranchId, source: clean.id,
        expectedHead: seed.rootCommitId, author: 'ana',
      }));
      expect(status).toBe(201);

      const [row] = await db()`select head_commit_id, parent_ids from commits
        join branches on branches.head_commit_id = commits.id
        where branches.id = ${seed.mainBranchId}`;
      expect(row!.head_commit_id).toBe(body.data.commitId);
      // A merge commit records both parents — that is what makes the next
      // merge base correct.
      expect(row!.parent_ids).toHaveLength(2);
    });

    it('the same request replayed now 409s, because the head moved', async () => {
      const res = await post(mergeCommit, {
        target: seed.mainBranchId, source: clean.id,
        expectedHead: seed.rootCommitId, author: 'ana',
      });
      expect(res.status).toBe(409);
    });
  });
});
