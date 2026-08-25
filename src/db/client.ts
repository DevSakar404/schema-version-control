import postgres from 'postgres';

/**
 * Database connection.
 *
 * Two settings are not defaults and both are required against Supabase's
 * transaction pooler, confirmed against a live instance:
 *
 *   prepare: false  pgbouncer in transaction mode rejects prepared statements
 *   ssl: 'require'  Supabase refuses plaintext connections
 */
export type Db = postgres.Sql;

/**
 * Stashed on `globalThis`, not a plain module-scope variable.
 *
 * In Next.js dev mode, webpack HMR re-executes this module on nearly every
 * save that touches its dependency graph — a module-scope `let client` resets
 * to null in the new instance, but the OLD instance's live pool (up to `max`
 * connections each) is never closed, since nothing calls `.end()` on it. Over
 * a long editing session that leaks a handful of connections per reload,
 * eventually exhausting a low connection ceiling with an error that looks
 * like normal load rather than a leak. `globalThis` survives module
 * re-execution, so HMR reuses the same pool instead of abandoning it — the
 * same pattern Prisma's and Drizzle's own Next.js docs prescribe for this
 * exact failure mode. It's also just the correct singleton pattern outside
 * dev mode, so there's no environment check needed here.
 */
const globalForDb = globalThis as unknown as { __schemaVersionControlDb?: Db };

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function db(): Db {
  if (globalForDb.__schemaVersionControlDb) return globalForDb.__schemaVersionControlDb;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  globalForDb.__schemaVersionControlDb = postgres({
    ...parseConnectionUrl(url), ssl: 'require', prepare: false, max: 5,
  });
  return globalForDb.__schemaVersionControlDb;
}

/** Close the pool. Used by tests; the app leaves it open for reuse. */
export async function closeDb(): Promise<void> {
  await globalForDb.__schemaVersionControlDb?.end({ timeout: 5 });
  globalForDb.__schemaVersionControlDb = undefined;
}

interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

/**
 * Parse a Postgres connection URL by splitting at the LAST `@`, not the first.
 *
 * A URI is formally credentials@host, so a password containing `@` must be
 * percent-encoded — and in practice people paste the password straight in.
 * Standard parsers then read the host as `part-of-password@realhost`, which
 * does not resolve, and the connection hangs on DNS with no error at all.
 * Splitting at the last `@` accepts both the encoded and the raw form.
 *
 * ponytail: assumes the host itself contains no `@`, which is true for every
 * DNS name and every IPv4/IPv6 literal.
 */
export function parseConnectionUrl(url: string): ConnectionOptions {
  const body = url.replace(/^postgres(ql)?:\/\//, '');
  const at = body.lastIndexOf('@');
  if (at === -1) throw new Error('DATABASE_URL is missing credentials');

  const credentials = body.slice(0, at);
  const colon = credentials.indexOf(':');
  const username = colon === -1 ? credentials : credentials.slice(0, colon);
  const rawPassword = colon === -1 ? '' : credentials.slice(colon + 1);

  const [hostPart = '', pathPart = 'postgres'] = body.slice(at + 1).split('/');
  const [host = '', port = '5432'] = splitHostPort(hostPart);

  return {
    host,
    port: Number(port),
    database: (pathPart.split('?')[0] || 'postgres'),
    username,
    password: safeDecode(rawPassword),
  };
}

/** Split host:port, tolerating a bracketed IPv6 literal. */
function splitHostPort(hostPart: string): [string, string] {
  if (hostPart.startsWith('[')) {
    const close = hostPart.indexOf(']');
    return [hostPart.slice(1, close), hostPart.slice(close + 2) || '5432'];
  }
  const colon = hostPart.lastIndexOf(':');
  return colon === -1 ? [hostPart, '5432'] : [hostPart.slice(0, colon), hostPart.slice(colon + 1)];
}

/** Percent-decode when the value is encoded; pass it through untouched when not. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Rewrite an unroutable-host failure into the fix for it.
 *
 * Supabase's dashboard offers two connection strings, and the one the copy
 * button hands you first is the DIRECT connection —
 * `db.<ref>.supabase.co:5432` — which on the free tier resolves only to an
 * IPv6 address. On any network without an IPv6 route (most home ISPs, plenty
 * of office networks, and every Vercel function — see D41) the driver fails
 * with `connect ENETUNREACH 2406:da1c:...:5432`.
 *
 * That message names neither Supabase, nor IPv6, nor the pooler that fixes
 * it. `npm run db:migrate` is the first command a fresh clone runs, so this
 * error *is* the setup experience: someone who has never seen this repo hits
 * it before they have seen a single screen. Documenting the fix in the README
 * is not enough, because the error gives no reason to go looking there.
 *
 * Returns the driver's message untouched when this is not that failure — a
 * genuinely offline machine, or a host that has nothing to do with Supabase,
 * should not be told to go change its connection pooler.
 */
export function explainConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const unroutable = /ENETUNREACH|EHOSTUNREACH/.test(`${message} ${String(code ?? '')}`);
  if (!unroutable) return message;

  const host = hostOf(process.env.DATABASE_URL);
  if (!host?.startsWith('db.') || !host.endsWith('.supabase.co')) return message;

  return `${message}

Cannot reach this host:
  ${host}
That is Supabase's DIRECT connection, and it resolves only to an IPv6
address — your network has no IPv6 route to it. Nothing is wrong with the
database, the password, or this project.

Fix it in three steps:
  1. Supabase dashboard -> Connect -> Connection string -> URI
  2. Choose "Transaction pooler", NOT "Direct connection". Its host ends in
     .pooler.supabase.com and its port is 6543.
  3. Put that string in DATABASE_URL (keep your password), then re-run.

The pooler is reachable over IPv4. This is the same reason the deployed app
uses it; decisions.md D41 has the full story.

Already changed it and still seeing this? Then the value above is not coming
from the file you edited. In precedence order, check:
  1. an exported shell variable  ->  unset DATABASE_URL
  2. .env.local, which Next.js loads ahead of .env
  3. a .env in a different directory than the one you are running from`;
}

/** Host of a connection URL, or undefined if it is absent or unparseable. */
function hostOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return parseConnectionUrl(url.trim()).host;
  } catch {
    return undefined;
  }
}

/**
 * Assert that a statement which must return a row actually did.
 *
 * INSERT ... RETURNING always yields a row, but the driver's type does not say
 * so. Failing loudly beats a non-null assertion that turns a driver surprise
 * into an undefined-property crash three frames away.
 */
export function expectRow<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`expected ${what} to return a row, got none`);
  return row;
}
