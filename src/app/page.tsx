import { redirect } from 'next/navigation';
import { getProject } from '@/db/projects';
import { DEMO_PROJECT_ID } from '@/seed/demo';
import { SeedButton } from '@/components/SeedButton';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const demo = await getProject(DEMO_PROJECT_ID);
  if (demo) redirect(`/p/${demo.id}`);

  return (
    <main className="page">
      <h1>Schema Version Control</h1>
      <p className="text-dim">Branch, diff, and merge for database schemas.</p>

      <div className="card" style={{ marginTop: '2rem' }}>
        <p style={{ marginTop: 0 }}>No demo project yet.</p>
        <p className="text-dim">
          Seed a small storefront schema with two branches already diverged in
          three different ways — a rename conflict, a hazard no conflict
          detector would catch, and a table dropped out from under a change to
          it — so there is something to look at immediately.
        </p>
        <SeedButton label="Seed the demo" />
      </div>
    </main>
  );
}
