import { handle, ok } from '@/server/http';
import { seedDemo } from '@/seed/demo';

/**
 * Resets the demo project to its known-good state. Idempotent: always
 * deletes and rebuilds the same fixed project id, so a reviewer who has
 * broken the demo while exploring the editor recovers with one click,
 * without a redeploy.
 */
export async function POST() {
  return handle(async () => ok(await seedDemo()));
}
