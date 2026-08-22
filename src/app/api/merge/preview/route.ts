import { handle, ok, optionalArray, readJson, requireString } from '@/server/http';
import { previewMerge } from '@/server/branches-service';
import type { Resolution } from '@/core/merge';

/** Read-only. The conflict screen re-posts here on every resolution change. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    return ok(
      await previewMerge(
        requireString(body, 'target'),
        requireString(body, 'source'),
        optionalArray<Resolution>(body, 'resolutions'),
      ),
    );
  });
}
