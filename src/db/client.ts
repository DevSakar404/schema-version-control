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

let client: Db | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function db(): Db {
  if (client) return client;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  client = postgres({ ...parseConnectionUrl(url), ssl: 'require', prepare: false, max: 5 });
  return client;
}

/** Close the pool. Used by tests; the app leaves it open for reuse. */
export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = null;
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
