import { handle, ok, requireParam } from '@/server/http';
import { compareBranches } from '@/server/branches-service';

export async function GET(request: Request) {
  return handle(async () => {
    const changes = await compareBranches(
      requireParam(request.url, 'base'),
      requireParam(request.url, 'head'),
    );
    return ok({ changes });
  });
}
