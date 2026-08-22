import type { Id } from './ids';

/**
 * Rename ordering and cycle breaking (design.md §9.1.1).
 *
 * Renames cannot be emitted in arbitrary order. Renaming `a` to `b` while `b`
 * still exists is rejected by Postgres, so a rename must wait for whatever
 * currently holds its target name to move out of the way first.
 *
 * When those dependencies form a cycle — swapping two names is the smallest
 * case — no ordering exists at all, and the cycle has to be broken with a
 * temporary name.
 *
 * This is the one place in the migration planner where a topological sort
 * genuinely earns its keep. The foreign-key phases deliberately avoid graphs,
 * because FK cycles are unbreakable and must be sidestepped by phase
 * separation instead. Same shape of problem, opposite correct answer.
 */
export interface RenameStep {
  entityId: Id;
  /** 'table' for tables, or the owning tableId for columns. Names are unique per scope. */
  scope: string;
  from: string;
  to: string;
  /** Set when this step exists only to break a cycle. */
  temporary?: boolean;
}

export type TempNamer = (attempt: number) => string;

export const defaultTempNamer: TempNamer = (n) => `__tmp_${n}`;

/** Every name live in a scope, in the form orderRenames expects. */
export function occupiedKey(scope: string, name: string): string {
  return `${scope} ${name}`;
}

/**
 * Order renames so each is legal at the moment it runs, inserting temporary
 * names where a cycle makes that impossible.
 *
 * `occupiedNames` is every name live in the schema before the migration runs,
 * keyed by occupiedKey — used so a generated temporary cannot collide with
 * something that already exists.
 */
export function orderRenames(
  renames: RenameStep[],
  occupiedNames: ReadonlySet<string> = new Set(),
  mintTemp: TempNamer = defaultTempNamer,
): RenameStep[] {
  const byScope = new Map<string, RenameStep[]>();
  for (const step of renames) {
    byScope.set(step.scope, [...(byScope.get(step.scope) ?? []), step]);
  }

  const taken = new Set(occupiedNames);
  let tempCounter = 0;
  const nextTemp = (scope: string): string => {
    let name: string;
    do {
      name = mintTemp(++tempCounter);
    } while (taken.has(occupiedKey(scope, name)));
    taken.add(occupiedKey(scope, name));
    return name;
  };

  // Scopes are independent: renaming a to b on one table and b to a on
  // another is not a cycle, because column names are scoped per table.
  return [...byScope.entries()].flatMap(([scope, steps]) => orderScope(scope, steps, nextTemp));
}

function orderScope(
  scope: string,
  steps: RenameStep[],
  nextTemp: (scope: string) => string,
): RenameStep[] {
  /** Which pending rename currently holds a given name. */
  const holderOf = new Map<string, RenameStep>();
  for (const step of steps) holderOf.set(step.from, step);

  const ordered: RenameStep[] = [];
  const deferred: RenameStep[] = [];
  const state = new Map<RenameStep, 'visiting' | 'done'>();

  const visit = (step: RenameStep): void => {
    const status = state.get(step);
    if (status === 'done') return;

    if (status === 'visiting') {
      // Re-entered a step still on the stack, so its dependencies form a
      // cycle. Move this one to a temporary name now and schedule its real
      // rename for after the rest of the cycle has unwound.
      const temp = nextTemp(scope);
      ordered.push({ ...step, to: temp, temporary: true });
      deferred.push({ ...step, from: temp });
      state.set(step, 'done');
      return;
    }

    state.set(step, 'visiting');
    const blocker = holderOf.get(step.to);
    if (blocker && blocker !== step) visit(blocker);

    // A cycle break may already have emitted and completed this step.
    if (state.get(step) === 'visiting') {
      state.set(step, 'done');
      ordered.push(step);
    }
  };

  for (const step of steps) visit(step);

  // Deferred halves run last, once their target names are free.
  return [...ordered, ...deferred];
}
