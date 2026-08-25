import { handle, ok, readJson, requireString } from '@/server/http';
import { createNewProject } from '@/server/branches-service';

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJson(request);
    const project = await createNewProject(requireString(body, 'name'));
    return ok(project, 201);
  });
}
