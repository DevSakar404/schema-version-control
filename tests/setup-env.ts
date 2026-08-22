import { readFileSync } from 'node:fs';

/**
 * Load .env into process.env for tests.
 *
 * Vite only exposes VITE_-prefixed vars via import.meta.env, and the database
 * tests need the real connection string. Values already in the environment win,
 * so CI can override without touching the file.
 */
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
  }
} catch {
  // No .env — database tests skip themselves.
}
