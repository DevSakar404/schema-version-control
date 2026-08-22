import { nanoid } from 'nanoid';

/**
 * Every entity carries an immutable synthetic id minted at creation.
 * `name` is an ordinary mutable attribute. See design.md §3.1 — this is the
 * decision the rest of the codebase rests on.
 */
export type Id = string;

/**
 * Id generation is a parameter, never an import, so core stays pure and tests
 * can assert on exact schema values (design.md §4).
 */
export type IdGen = () => Id;

export const nanoIdGen: IdGen = () => nanoid(12);

/** Deterministic generator for tests: counterIdGen('c') yields c1, c2, c3… */
export function counterIdGen(prefix: string): IdGen {
  let n = 0;
  return () => `${prefix}${++n}`;
}
