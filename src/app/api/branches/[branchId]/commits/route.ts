import { handle, ok, readJson, requireArray, requireString } from '@/server/http';
import { commitOps } from '@/server/branches-service';
import type { SchemaOp } from '@/core/ops';

type Ctx = { params: Promise<{ branchId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return handle(async () => {
    const body = await readJson(request);
    const result = await commitOps(
      (await params).branchId,
      requireArray<SchemaOp>(body, 'ops'),
      requireString(body, 'message'),
      requireString(body, 'author'),
      requireString(body, 'expectedHead'),
    );
    return ok(result, 201);
  });
}
