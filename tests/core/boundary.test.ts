import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * design.md §13 — src/core/ is pure: no database, no React, no I/O.
 *
 * eslint enforces this too, but an inline disable comment silences a lint
 * rule and cannot silence a test. This is the one that actually holds.
 */
const CORE = join(process.cwd(), 'src', 'core');

const FORBIDDEN = [
  { pattern: /from\s+['"][^'"]*\/db(\/|['"])/, why: 'persistence' },
  { pattern: /from\s+['"][^'"]*\/app(\/|['"])/, why: 'app layer' },
  { pattern: /from\s+['"][^'"]*\/components\//, why: 'UI' },
  { pattern: /from\s+['"]next(\/|['"])/, why: 'the framework' },
  { pattern: /from\s+['"]react(-dom)?['"]/, why: 'React' },
  { pattern: /\bfetch\s*\(/, why: 'network I/O' },
  { pattern: /\bDate\.now\s*\(/, why: 'ambient time (inject it instead)' },
  { pattern: /\bMath\.random\s*\(/, why: 'ambient randomness (inject an IdGen)' },
];

function tsFilesUnder(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found = found.concat(tsFilesUnder(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('core purity boundary', () => {
  it('finds the core directory', () => {
    expect(statSync(CORE).isDirectory()).toBe(true);
  });

  it('no file under src/core imports or performs I/O', () => {
    const violations: string[] = [];
    for (const file of tsFilesUnder(CORE)) {
      const source = readFileSync(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(source)) {
          violations.push(`${file.replace(process.cwd() + '/', '')} depends on ${why}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
