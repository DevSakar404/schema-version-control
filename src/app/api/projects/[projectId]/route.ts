import { handle, ok } from '@/server/http';
import { getProjectOverview } from '@/server/branches-service';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  return handle(async () => ok(await getProjectOverview((await params).projectId)));
}
