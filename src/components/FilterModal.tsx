'use client';

/**
 * The schema editor's advanced filter — a centered modal, portaled straight
 * into `document.body`.
 *
 * The portal isn't decoration, it's load-bearing: `.page` (an ancestor of
 * wherever this component would otherwise render) has a static
 * `backdrop-filter` for its frosted-glass background, and per spec
 * `backdrop-filter` makes an element the CONTAINING BLOCK for any
 * `position: fixed` descendant. Rendered in place, this modal's `top: 50%`
 * would center within `.page`'s own (often much taller than one screen)
 * box, not the viewport — meaning it could paint far above or below
 * whatever's actually in view, depending on scroll position and how much
 * content the page has above it. `createPortal` into `document.body`
 * sidesteps the whole class of bug: body has no transform/filter of its
 * own, so `position: fixed` here means what it's supposed to.
 *
 * Apply/Reset, not instant: toggling a chip only edits `draft`, passed back
 * up to the caller which owns the APPLIED facets actually used to filter
 * the table list. Apply promotes draft to applied; closing without Apply
 * (Escape, the backdrop, the × button) just discards the draft — the
 * caller re-syncs draft from applied the next time it opens the modal.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';
import type { Column, ColumnType, Constraint, Schema, Table } from '@/core/schema';

export type NullableFacet = 'nullable' | 'not_null';
export type DefaultFacet = 'has_default' | 'no_default';
export type IndexFacet = 'unique' | 'non_unique';

export interface Facets {
  types: Set<ColumnType['kind']>;
  nullable: Set<NullableFacet>;
  defaults: Set<DefaultFacet>;
  constraintKinds: Set<Constraint['kind']>;
  indexUnique: Set<IndexFacet>;
}

export function emptyFacets(): Facets {
  return { types: new Set(), nullable: new Set(), defaults: new Set(), constraintKinds: new Set(), indexUnique: new Set() };
}

export function facetCount(f: Facets): number {
  return f.types.size + f.nullable.size + f.defaults.size + f.constraintKinds.size + f.indexUnique.size;
}

export function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

/**
 * Type/nullable/default all have to hold for the SAME column — "nullable
 * text columns with no default" is one condition on one column, not three
 * independent ones that could each be satisfied by a different column in
 * the table. Constraint kind and index uniqueness are separate dimensions
 * below, checked against constraints/indexes directly, since those aren't
 * columns at all.
 */
function columnMatchesFacets(column: Column, f: Facets): boolean {
  if (f.types.size > 0 && !f.types.has(column.type.kind)) return false;
  if (f.nullable.size > 0 && !f.nullable.has(column.nullable ? 'nullable' : 'not_null')) return false;
  if (f.defaults.size > 0 && !f.defaults.has(column.default !== null ? 'has_default' : 'no_default')) return false;
  return true;
}

// Every empty group is "no constraint from this dimension" — a table
// passes a group check automatically until at least one chip in it is on.
export function tableMatchesFacets(schema: Schema, table: Table, f: Facets): boolean {
  const columnFacetsActive = f.types.size > 0 || f.nullable.size > 0 || f.defaults.size > 0;
  if (columnFacetsActive && !table.columns.some((c) => columnMatchesFacets(c, f))) return false;

  if (f.constraintKinds.size > 0) {
    const hasMatch = schema.constraints.some((c) => c.tableId === table.id && f.constraintKinds.has(c.kind));
    if (!hasMatch) return false;
  }

  if (f.indexUnique.size > 0) {
    const hasMatch = schema.indexes.some((i) => i.tableId === table.id && f.indexUnique.has(i.unique ? 'unique' : 'non_unique'));
    if (!hasMatch) return false;
  }

  return true;
}

const KINDS: ColumnType['kind'][] = [
  'smallint', 'int', 'bigint', 'boolean', 'uuid', 'date', 'timestamptz', 'jsonb', 'text', 'varchar', 'numeric',
];

const CONSTRAINT_KINDS: { kind: Constraint['kind']; label: string }[] = [
  { kind: 'primary_key', label: 'primary key' },
  { kind: 'unique', label: 'unique' },
  { kind: 'check', label: 'check' },
  { kind: 'foreign_key', label: 'foreign key' },
];

export function FilterModal({
  open,
  draft,
  onToggleType,
  onToggleNullable,
  onToggleDefault,
  onToggleConstraintKind,
  onToggleIndexUnique,
  onApply,
  onReset,
  onClose,
}: {
  open: boolean;
  draft: Facets;
  onToggleType: (kind: ColumnType['kind']) => void;
  onToggleNullable: (v: NullableFacet) => void;
  onToggleDefault: (v: DefaultFacet) => void;
  onToggleConstraintKind: (kind: Constraint['kind']) => void;
  onToggleIndexUnique: (v: IndexFacet) => void;
  onApply: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  // Every toggle click updates `draft` in the PARENT (SchemaTree owns the
  // facet state), so this component re-renders on every chip press — and
  // `onClose` arrives as a fresh inline arrow each time. Stashing the
  // latest one in a ref, rather than putting it in the effect's deps,
  // keeps the effect (scroll lock, listeners, initial focus) from tearing
  // down and rebuilding itself on every toggle — which would otherwise
  // restore focus to the trigger button and then immediately recapture it
  // into the modal, once per keystroke.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Scroll lock, Escape-to-close, a focus trap, and focus restoration — a
  // `role="dialog" aria-modal="true"` is a promise to assistive tech that
  // focus can't silently leak into the (visually covered, but still
  // otherwise focusable) page behind it. Queries focusable elements live on
  // every Tab press rather than once on open, since the Reset button's
  // `disabled` state changes as facets are toggled.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      (triggerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const draftCount = facetCount(draft);

  return createPortal(
    <>
      <div className="filter-modal-backdrop" onClick={onClose} />
      <div ref={modalRef} className="filter-modal" role="dialog" aria-modal="true" aria-label="Advanced filters">
        <div className="filter-modal-header">
          <strong>Filters</strong>
          <button type="button" className="btn" onClick={onClose} aria-label="Close filters">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="filter-modal-body">
          <FacetGroup label="Column type">
            {KINDS.map((k) => (
              <Chip key={k} label={k} active={draft.types.has(k)} onClick={() => onToggleType(k)} />
            ))}
          </FacetGroup>

          <FacetGroup label="Nullability">
            <Chip label="nullable" active={draft.nullable.has('nullable')} onClick={() => onToggleNullable('nullable')} />
            <Chip label="NOT NULL" active={draft.nullable.has('not_null')} onClick={() => onToggleNullable('not_null')} />
          </FacetGroup>

          <FacetGroup label="Default value">
            <Chip label="has default" active={draft.defaults.has('has_default')} onClick={() => onToggleDefault('has_default')} />
            <Chip label="no default" active={draft.defaults.has('no_default')} onClick={() => onToggleDefault('no_default')} />
          </FacetGroup>

          <FacetGroup label="Constraint kind">
            {CONSTRAINT_KINDS.map(({ kind, label }) => (
              <Chip key={kind} label={label} active={draft.constraintKinds.has(kind)} onClick={() => onToggleConstraintKind(kind)} />
            ))}
          </FacetGroup>

          <FacetGroup label="Index">
            <Chip label="unique" active={draft.indexUnique.has('unique')} onClick={() => onToggleIndexUnique('unique')} />
            <Chip label="non-unique" active={draft.indexUnique.has('non_unique')} onClick={() => onToggleIndexUnique('non_unique')} />
          </FacetGroup>
        </div>

        <div className="filter-modal-footer">
          <button type="button" className="btn" disabled={draftCount === 0} onClick={onReset}>
            <RotateCcw size={13} strokeWidth={2} aria-hidden />
            Reset
          </button>
          <button type="button" className="btn btn-primary" onClick={onApply}>
            Apply{draftCount > 0 ? ` (${draftCount})` : ''}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`chip${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
      {label}
    </button>
  );
}

function FacetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-dim" style={{ fontSize: '0.72rem', fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
        {label}
      </div>
      <div className="chip-row">{children}</div>
    </div>
  );
}
