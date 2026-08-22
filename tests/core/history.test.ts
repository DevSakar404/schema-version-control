import { describe, it, expect } from 'vitest';
import { findMergeBase, aheadBehind, ancestorsOf, type Commit } from '@/core/history';
import { emptySchema } from '@/core/schema';

/** Build a DAG from an adjacency description: id -> parent ids. */
function dag(spec: Record<string, string[]>): Map<string, Commit> {
  return new Map(
    Object.entries(spec).map(([id, parentIds]) => [
      id,
      { id, projectId: 'p', parentIds, schema: emptySchema(), message: id, author: 'test', createdAt: '2026-01-01T00:00:00Z' },
    ]),
  );
}

describe('ancestorsOf', () => {
  it('includes the commit itself', () => {
    expect([...ancestorsOf(dag({ a: [], b: ['a'] }), 'b')].sort()).toEqual(['a', 'b']);
  });
});

describe('findMergeBase', () => {
  it('linear history — the base of a descendant and its ancestor is the ancestor', () => {
    const d = dag({ a: [], b: ['a'], c: ['b'] });
    expect(findMergeBase(d, 'c', 'a')).toBe('a');
  });

  it('simple fork — two branches share their fork point', () => {
    //   a - b - c   (ours)
    //     \ d - e   (theirs)
    const d = dag({ a: [], b: ['a'], c: ['b'], d: ['a'], e: ['d'] });
    expect(findMergeBase(d, 'c', 'e')).toBe('a');
  });

  it('finds the base THROUGH a merge commit with two parents', () => {
    // This is where a naive first-parent walk breaks.
    //   a - b ---- m - f   (ours)
    //     \ c ---/     \ g (theirs branches off m)
    const d = dag({ a: [], b: ['a'], c: ['a'], m: ['b', 'c'], f: ['m'], g: ['m'] });
    expect(findMergeBase(d, 'f', 'g')).toBe('m');
  });

  it('prefers the nearest common ancestor, not merely a common one', () => {
    const d = dag({ a: [], b: ['a'], c: ['b'], e: ['b'] });
    expect(findMergeBase(d, 'c', 'e')).toBe('b'); // 'a' is also common, but further
  });

  it('criss-cross terminates and returns a valid candidate', () => {
    // Two branches that each merged the other once. There is no single best
    // base; any of the candidates is defensible, but it must not hang.
    const d = dag({
      a: [], b: ['a'], c: ['a'],
      m1: ['b', 'c'], m2: ['c', 'b'],
      x: ['m1'], y: ['m2'],
    });
    const base = findMergeBase(d, 'x', 'y');
    expect(['b', 'c']).toContain(base);
  });

  it('returns null for disconnected histories', () => {
    expect(findMergeBase(dag({ a: [], z: [] }), 'a', 'z')).toBeNull();
  });

  it('the base of a commit with itself is itself', () => {
    expect(findMergeBase(dag({ a: [], b: ['a'] }), 'b', 'b')).toBe('b');
  });
});

describe('aheadBehind', () => {
  it('a branch that has not moved while main advanced is purely behind', () => {
    const d = dag({ a: [], b: ['a'], c: ['b'] });
    expect(aheadBehind(d, 'a', 'c')).toEqual({ ahead: 0, behind: 2 });
  });

  it('counts divergence in both directions', () => {
    const d = dag({ a: [], b: ['a'], c: ['b'], d: ['a'] });
    expect(aheadBehind(d, 'd', 'c')).toEqual({ ahead: 1, behind: 2 });
  });

  it('identical heads are neither ahead nor behind', () => {
    const d = dag({ a: [], b: ['a'] });
    expect(aheadBehind(d, 'b', 'b')).toEqual({ ahead: 0, behind: 0 });
  });
});
