import { handle, ok, optionalArray, readJson, requireString } from '@/server/http';
import { performMerge } from '@/server/branches-service';
import type { Resolution } from '@/core/merge';

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const result = await performMerge(
      requireString(body, 'target'),
      requireString(body, 'source'),
      optionalArray<Resolution>(body, 'resolutions'),
      requireString(body, 'expectedHead'),
      requireString(body, 'author'),
    );
    return ok(result, 201);
  });
}
