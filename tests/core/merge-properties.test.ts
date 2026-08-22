import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '@/core/merge';
import { validate } from '@/core/validate';
import { applyOps, type SchemaOp } from '@/core/ops';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

/**
 * Properties, not examples. Each catches a whole class of bug at once —
 * these are the tests that fail when someone "optimises" merge later.
 */
const branch = (ops: SchemaOp[], prefix = 'n') => applyOps(base(), ops, counterIdGen(prefix));

const scenarios: { name: string; ours: SchemaOp[]; theirs: SchemaOp[] }[] = [
  {
    name: 'independent renames',
    ours: [{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }],
    theirs: [{ kind: 'rename_column', columnId: 'c3', name: 'years' }],
  },
  {
    name: 'rename versus retype on one column',
    ours: [{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }],
    theirs: [{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }],
  },
  {
    name: 'conflicting renames',
    ours: [{ kind: 'rename_column', columnId: 'c2', name: 'a' }],
    theirs: [{ kind: 'rename_column', columnId: 'c2', name: 'b' }],
  },
  {
    name: 'convergent deletion',
    ours: [{ kind: 'drop_column', columnId: 'c3' }],
    theirs: [{ kind: 'drop_column', columnId: 'c3' }],
  },
  {
    name: 'delete versus modify across containment',
    ours: [{ kind: 'drop_table', tableId: 't1' }],
    theirs: [{ kind: 'rename_column', columnId: 'c2', name: 'contact_email' }],
  },
  {
    name: 'nullability and default on one column',
    ours: [{ kind: 'set_column_nullable', columnId: 'c3', nullable: false }],
    theirs: [{ kind: 'set_column_default', columnId: 'c3', default: '0' }],
  },
];

describe('merging a branch into itself is a no-op', () => {
  it.each(scenarios)('$name', ({ ours }) => {
    const b = branch(ours, 'a');
    const r = threeWayMerge(base(), b, b);
    expect(r.conflicts).toHaveLength(0);
    expect(r.schema).toEqual(b);
  });
});

describe('merging with no divergence fast-forwards exactly', () => {
  it.each(scenarios)('$name', ({ ours }) => {
    const b = branch(ours, 'a');
    expect(threeWayMerge(base(), base(), b).schema).toEqual(b);
    expect(threeWayMerge(base(), b, base()).schema).toEqual(b);
  });
});

describe('merge is order-independent', () => {
  // An implementation that iterates a Map and lets insertion order decide a
  // winner passes every example test and fails this one.
  it.each(scenarios)('$name', ({ ours, theirs }) => {
    const a = branch(ours, 'a');
    const b = branch(theirs, 'b');
    const forward = threeWayMerge(base(), a, b);
    const reverse = threeWayMerge(base(), b, a);

    expect(forward.schema).toEqual(reverse.schema);
    expect(forward.conflicts.map((c) => c.id).sort()).toEqual(reverse.conflicts.map((c) => c.id).sort());
    expect(forward.conflicts.map((c) => c.class).sort()).toEqual(reverse.conflicts.map((c) => c.class).sort());
  });
});

describe('validity is preserved', () => {
  it('the base fixture is itself clean', () => {
    expect(validate(base())).toEqual([]);
  });

  it.each(scenarios)('a clean merge of $name yields no error hazards', ({ ours, theirs }) => {
    const r = threeWayMerge(base(), branch(ours, 'a'), branch(theirs, 'b'));
    if (r.conflicts.length === 0) {
      expect(r.hazards.filter((h) => h.severity === 'error')).toEqual([]);
    }
  });
});

describe('resolving every conflict always clears them', () => {
  it.each(scenarios)('$name', ({ ours, theirs }) => {
    const a = branch(ours, 'a');
    const b = branch(theirs, 'b');
    const first = threeWayMerge(base(), a, b);
    const resolved = threeWayMerge(
      base(), a, b,
      first.conflicts.map((c) => ({ conflictId: c.id, choice: 'ours' as const })),
    );
    expect(resolved.conflicts).toHaveLength(0);
  });
});
