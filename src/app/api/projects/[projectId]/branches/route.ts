import { handle, ok, readJson, requireString } from '@/server/http';
import { branchFrom } from '@/server/branches-service';

type Ctx = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return handle(async () => {
    const body = await readJson(request);
    const branch = await branchFrom(
      (await params).projectId,
      requireString(body, 'name'),
      requireString(body, 'fromCommitId'),
    );
    return ok(branch, 201);
  });
}
