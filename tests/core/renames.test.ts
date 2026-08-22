import { describe, it, expect } from 'vitest';
import { orderRenames, occupiedKey, type RenameStep } from '@/core/renames';

const step = (entityId: string, from: string, to: string, scope = 't1'): RenameStep => ({
  entityId,
  scope,
  from,
  to,
});
const names = (steps: RenameStep[]) => steps.map((s) => `${s.from}->${s.to}`);
const finalNames = (steps: RenameStep[]) => new Map(steps.map((s) => [s.entityId, s.to]));

describe('acyclic ordering', () => {
  it('a rename waits for whatever holds its target name to move first', () => {
    // a -> b, and b -> c. Renaming a first would collide with the live b.
    const out = orderRenames([step('x', 'a', 'b'), step('y', 'b', 'c')]);
    expect(names(out)).toEqual(['b->c', 'a->b']);
  });

  it('independent renames need no temporaries', () => {
    const out = orderRenames([step('x', 'a', 'p'), step('y', 'b', 'q')]);
    expect(names(out)).toEqual(['a->p', 'b->q']);
    expect(out.some((s) => s.temporary)).toBe(false);
  });

  it('a three-step chain resolves back to front', () => {
    const out = orderRenames([step('x', 'a', 'b'), step('y', 'b', 'c'), step('z', 'c', 'd')]);
    expect(names(out)).toEqual(['c->d', 'b->c', 'a->b']);
  });
});

describe('the swap, where no two-statement ordering exists', () => {
  const swap = () => orderRenames([step('x', 'a', 'b'), step('y', 'b', 'a')]);

  it('emits THREE steps via a temporary', () => {
    // An implementation returning two steps has the right final names and
    // cannot run: whichever goes first briefly duplicates a name.
    expect(swap()).toHaveLength(3);
    expect(names(swap())).toEqual(['a->__tmp_1', 'b->a', '__tmp_1->b']);
  });

  it('marks exactly one step as temporary', () => {
    expect(swap().filter((s) => s.temporary)).toHaveLength(1);
  });

  it('still lands both entities on their intended names', () => {
    const final = finalNames(swap());
    expect(final.get('x')).toBe('b');
    expect(final.get('y')).toBe('a');
  });

  it('never has two entities holding one name at any point', () => {
    // Replay the steps and assert the invariant Postgres enforces.
    const live = new Map<string, string>([['x', 'a'], ['y', 'b']]);
    for (const s of swap()) {
      live.set(s.entityId, s.to);
      expect(new Set(live.values()).size).toBe(live.size);
    }
  });
});

describe('longer cycles', () => {
  it('a three-cycle needs only one temporary', () => {
    const out = orderRenames([step('x', 'a', 'b'), step('y', 'b', 'c'), step('z', 'c', 'a')]);
    expect(out.filter((s) => s.temporary)).toHaveLength(1);
    const final = finalNames(out);
    expect([final.get('x'), final.get('y'), final.get('z')]).toEqual(['b', 'c', 'a']);
  });

  it('two independent cycles get distinct temporaries', () => {
    const out = orderRenames([
      step('x', 'a', 'b'),
      step('y', 'b', 'a'),
      step('p', 'c', 'd'),
      step('q', 'd', 'c'),
    ]);
    const temps = out.filter((s) => s.temporary).map((s) => s.to);
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
  });
});

describe('temporary names never clobber something real', () => {
  it('skips a name the schema already uses', () => {
    const occupied = new Set([occupiedKey('t1', '__tmp_1')]);
    const out = orderRenames([step('x', 'a', 'b'), step('y', 'b', 'a')], occupied);
    expect(out.find((s) => s.temporary)!.to).toBe('__tmp_2');
  });
});

describe('scopes are independent', () => {
  it('a to b on one table and b to a on ANOTHER is not a cycle', () => {
    // Column names are scoped per table, so these never collide.
    const out = orderRenames([step('x', 'a', 'b', 't1'), step('y', 'b', 'a', 't2')]);
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.temporary)).toBe(false);
  });
});

describe('degenerate inputs', () => {
  it('an empty list produces nothing', () => {
    expect(orderRenames([])).toEqual([]);
  });

  it('a single rename passes straight through', () => {
    expect(names(orderRenames([step('x', 'a', 'b')]))).toEqual(['a->b']);
  });

  it('renaming into a name nothing holds needs no reordering', () => {
    expect(names(orderRenames([step('x', 'a', 'zzz')]))).toEqual(['a->zzz']);
  });
});
