import { NextResponse } from 'next/server';
import { explainConnectionError } from '@/db/client';

/**
 * Response envelope. Every route returns `{ data }` or `{ error }`, so the
 * client has exactly one shape to branch on.
 */
export type ApiError = { code: string; message: string };

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

export function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Thrown by validators; turned into a 400 by `handle`. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** Thrown when a referenced entity does not exist; turned into a 404. */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/** Thrown when the request is well-formed but cannot be carried out; a 422. */
export class Unprocessable extends Error {
  constructor(
    message: string,
    readonly code = 'unprocessable',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'Unprocessable';
  }
}

/** Thrown when a branch moved under us; a 409. */
export class Conflicted extends Error {
  constructor(
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'Conflicted';
  }
}

/**
 * Run a handler, mapping domain errors onto status codes.
 *
 * The boundary between the browser and the pure core: `src/core` assumes
 * well-formed input, so everything untrusted is rejected here rather than
 * deeper in, where a bad value would surface as a confusing crash.
 */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BadRequest) return fail('bad_request', e.message, 400);
    if (e instanceof NotFound) return fail('not_found', e.message, 404);
    if (e instanceof Conflicted) {
      return NextResponse.json(
        { error: { code: 'branch_moved', message: e.message }, data: e.details },
        { status: 409 },
      );
    }
    if (e instanceof Unprocessable) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message }, data: e.details },
        { status: 422 },
      );
    }
    // Not just `e.message`: a misconfigured DATABASE_URL surfaces here as an
    // unroutable-address error, and the fix for it is worth stating (D43).
    const message = e ? explainConnectionError(e) : 'unexpected error';
    return fail('internal', message, 500);
  }
}

/* ------------------------------------------------------------ validation */

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequest('request body must be a JSON object');
    }
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof BadRequest) throw e;
    throw new BadRequest('request body is not valid JSON');
  }
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function requireArray<T>(body: Record<string, unknown>, key: string): T[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new BadRequest(`"${key}" must be an array`);
  return value as T[];
}

export function optionalArray<T>(body: Record<string, unknown>, key: string): T[] {
  return body[key] === undefined ? [] : requireArray<T>(body, key);
}

export function requireParam(url: string, key: string): string {
  const value = new URL(url).searchParams.get(key);
  if (!value) throw new BadRequest(`query parameter "${key}" is required`);
  return value;
}
