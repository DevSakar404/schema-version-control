import { describe, it, expect } from 'vitest';
import { threeWayMerge, type Resolution } from '@/core/merge';
import { validate } from '@/core/validate';
import { applyOps, type SchemaOp } from '@/core/ops';
import { findColumn, type Schema } from '@/core/schema';
import { counterIdGen } from '@/core/ids';
import { base } from './fixture';

const branch = (ops: SchemaOp[], prefix = 'n') => applyOps(base(), ops, counterIdGen(prefix));
const merge = (ours: Schema, theirs: Schema, resolutions: Resolution[] = []) =>
  threeWayMerge(base(), ours, theirs, resolutions, { oursLabel: 'Ana', theirsLabel: 'Ben' });

const renameC2 = (to: string) => branch([{ kind: 'rename_column', columnId: 'c2', name: to }]);

describe('resolutions (design.md §7.5)', () => {
  const ours = renameC2('contact_email');
  const theirs = renameC2('email_address');

  it('"ours" takes our value', () => {
    const r = merge(ours, theirs, [{ conflictId: 'c2:name', choice: 'ours' }]);
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('contact_email');
  });

  it('"theirs" takes their value', () => {
    const r = merge(ours, theirs, [{ conflictId: 'c2:name', choice: 'theirs' }]);
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('email_address');
  });

  it('"custom" takes a THIRD value neither branch proposed', () => {
    // The reason this tool beats a text merge: when two engineers rename the
    // same column differently they were usually both reaching for the same
    // clarification, and the right answer is often a name neither picked.
    const r = merge(ours, theirs, [{ conflictId: 'c2:name', choice: 'custom', value: 'primary_email' }]);
    expect(r.conflicts).toHaveLength(0);
    expect(findColumn(r.schema, 'c2')!.column.name).toBe('primary_email');
  });

  it('custom resolution works for a retype too', () => {
    const r = merge(
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'text' } }]),
      branch([{ kind: 'retype_column', columnId: 'c2', type: { kind: 'varchar', length: 100 } }]),
      [{ conflictId: 'c2:type', choice: 'custom', value: { kind: 'varchar', length: 512 } }],
    );
    expect(findColumn(r.schema, 'c2')!.column.type).toEqual({ kind: 'varchar', length: 512 });
  });

  it('an unknown conflictId is simply not applied, leaving the conflict open', () => {
    const r = merge(ours, theirs, [{ conflictId: 'does-not-exist', choice: 'ours' }]);
    expect(r.conflicts).toHaveLength(1);
  });

  it('conflict ids are stable across repeated previews', () => {
    expect(merge(ours, theirs).conflicts[0]!.id).toBe(merge(ours, theirs).conflicts[0]!.id);
  });
});

describe('name collision (design.md §7.4)', () => {
  it('two branches rename DIFFERENT columns to the same name -> conflict', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'contact' }]),
    );
    expect(r.conflicts.map((c) => c.class)).toContain('name_collision');
  });

  it('one branch alone creating the duplicate is a HAZARD, not a conflict', () => {
    const r = merge(
      branch([
        { kind: 'rename_column', columnId: 'c2', name: 'contact' },
        { kind: 'rename_column', columnId: 'c3', name: 'contact' },
      ]),
      base(),
    );
    expect(r.conflicts.map((c) => c.class)).not.toContain('name_collision');
    expect(r.hazards.map((h) => h.class)).toContain('duplicate_name');
  });

  it('the description tells the user what to do', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'contact' }]),
    );
    const c = r.conflicts.find((x) => x.class === 'name_collision')!;
    expect(c.description).toContain('Pick a different name');
  });

  it('exposes both colliding entities, attributed to a side, so the UI knows what it can rename', () => {
    const r = merge(
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'contact' }]),
    );
    const c = r.conflicts.find((x) => x.class === 'name_collision')!;
    expect(c.collisionMembers).toEqual(
      expect.arrayContaining([
        { id: 'c2', name: 'contact', side: 'ours' },
        { id: 'c3', name: 'contact', side: 'theirs' },
      ]),
    );
  });

  it('a custom resolution renames ONE colliding entity and clears the conflict', () => {
    // The core gap this closes: findNameCollisions ran after resolutions
    // were applied, so there was structurally no way to resolve one. This is
    // the first assertion that a name collision can actually be resolved.
    const r = threeWayMerge(
      base(),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'contact' }]),
      [{ conflictId: 'c2+c3:name_collision', choice: 'custom', value: { entityId: 'c3', name: 'contact_alt' } }],
      { oursLabel: 'ana', theirsLabel: 'ben' },
    );
    expect(r.conflicts.map((c) => c.class)).not.toContain('name_collision');
    const table = r.schema.tables[0]!;
    expect(table.columns.find((c) => c.id === 'c2')!.name).toBe('contact');
    expect(table.columns.find((c) => c.id === 'c3')!.name).toBe('contact_alt');
  });

  it('a resolution naming an id NOT in this collision is a no-op — the conflict stays open', () => {
    const r = threeWayMerge(
      base(),
      branch([{ kind: 'rename_column', columnId: 'c2', name: 'contact' }]),
      branch([{ kind: 'rename_column', columnId: 'c3', name: 'contact' }]),
      [{ conflictId: 'c2+c3:name_collision', choice: 'custom', value: { entityId: 'not-a-member', name: 'whatever' } }],
      { oursLabel: 'ana', theirsLabel: 'ben' },
    );
    expect(r.conflicts.map((c) => c.class)).toContain('name_collision');
  });

  it('resolving onto a name a THIRD, untouched column already holds surfaces as a duplicate_name HAZARD, not a re-flagged conflict', () => {
    // "existing" is inherited unchanged by both branches — neither branch
    // touched it, so by the same rule that makes a solo collision a hazard
    // rather than a conflict (§7.4), a collision the RESOLUTION itself
    // introduces against untouched state belongs to validate(), not to a
    // re-detected name_collision. It IS still caught — just one layer over.
    const withThird = branch([
      { kind: 'add_column', tableId: 't1', name: 'existing', type: { kind: 'text' }, nullable: true, default: null },
    ], 'z');
    const r = threeWayMerge(
      withThird,
      applyOps(withThird, [{ kind: 'rename_column', columnId: 'c2', name: 'contact' }], counterIdGen('a')),
      applyOps(withThird, [{ kind: 'rename_column', columnId: 'c3', name: 'contact' }], counterIdGen('b')),
      [{ conflictId: 'c2+c3:name_collision', choice: 'custom', value: { entityId: 'c3', name: 'existing' } }],
      { oursLabel: 'ana', theirsLabel: 'ben' },
    );
    expect(r.conflicts.some((c) => c.class === 'name_collision')).toBe(false);
    expect(r.hazards.map((h) => h.class)).toContain('duplicate_name');
  });
});

describe('hazards through merge — the zero-conflict broken schema (design.md §8)', () => {
  // Nothing is deleted, so containment correctly stays quiet. Nothing is
  // edited twice, so no key pairs. The COMBINATION is still invalid.
  const ours = branch([{ kind: 'retype_column', columnId: 'c1', type: { kind: 'uuid' } }], 'a');
  const theirs = (() => {
    const next = counterIdGen('o');
    let s = applyOps(base(), [{ kind: 'create_table', name: 'orders' }], next);
    s = applyOps(s, [{ kind: 'add_column', tableId: 'o1', name: 'user_id', type: { kind: 'int' }, nullable: false, default: null }], next);
    return applyOps(s, [{
      kind: 'add_constraint',
      constraint: {
        name: 'orders_user_fkey', tableId: 'o1', kind: 'foreign_key',
        columnIds: ['o2'], referencedTableId: 't1', referencedColumnIds: ['c1'],
        onDelete: 'cascade', onUpdate: 'no_action',
      },
    }], next);
  })();

  it('merges with NO conflicts and still produces an error hazard', () => {
    const r = merge(ours, theirs);
    expect(r.conflicts).toHaveLength(0);
    const fk = r.hazards.find((h) => h.class === 'foreign_key_type_mismatch');
    expect(fk?.severity).toBe('error');
  });

  it('attribution names BOTH sides (D24)', () => {
    const r = merge(ours, theirs);
    const fk = r.hazards.find((h) => h.class === 'foreign_key_type_mismatch')!;
    expect(fk.causedBy).not.toBeNull();
    expect(fk.causedBy!.ours.map((c) => c.kind)).toContain('column_retyped');
    expect(fk.causedBy!.theirs.map((c) => c.kind)).toContain('constraint_added');
  });

  it('validate() itself stays anonymous — no causedBy anywhere in its output', () => {
    // Provenance must not leak downward into the pure function over time.
    for (const h of validate(merge(ours, theirs).schema)) {
      expect(h).not.toHaveProperty('causedBy');
    }
  });

  it('a hazard nobody touched carries causedBy: null', () => {
    const r = merge(base(), base());
    for (const h of r.hazards) expect(h.causedBy).toBeNull();
  });
});
