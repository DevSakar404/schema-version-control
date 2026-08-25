/**
 * Apply supabase/migrations/*.sql in order. Idempotent — safe to re-run.
 * Usage: npm run db:migrate
 *
 * Imports parseConnectionUrl from the app rather than re-implementing it: the
 * last-`@` handling is subtle enough that two copies would drift.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { explainConnectionError, parseConnectionUrl } from '../src/db/client';

// A missing .env is the likeliest state of a fresh clone, and readFileSync's
// ENOENT stack trace is not an answer to it. Say what to run instead.
if (!existsSync('.env')) {
  console.error('No .env file found. Create one first:\n\n  cp .env.example .env\n');
  process.exit(1);
}

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (m?.[1] && !process.env[m[1]]) {
    process.env[m[1]] = (m[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1');
  }
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const sql = postgres({ ...parseConnectionUrl(url), ssl: 'require', prepare: false, max: 1 });
const dir = 'supabase/migrations';

try {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    process.stdout.write(`applying ${file} ... `);
    await sql.unsafe(readFileSync(join(dir, file), 'utf8'));
    console.log('ok');
  }
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('projects','commits','branches')
    order by table_name
  `;
  console.log(`tables present: ${rows.map((r) => r.table_name).join(', ') || '(none)'}`);
} catch (e) {
  console.error('FAILED:', explainConnectionError(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
