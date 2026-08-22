import { handle, ok } from '@/server/http';
import { getBranchSchema } from '@/server/branches-service';

type Ctx = { params: Promise<{ branchId: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  return handle(async () => ok(await getBranchSchema((await params).branchId)));
}
