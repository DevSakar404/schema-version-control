import Link from 'next/link';
import { listProjects } from '@/db/projects';
import { SeedButton } from '@/components/SeedButton';
import { NewProjectForm } from '@/components/NewProjectForm';

export const dynamic = 'force-dynamic';

/**
 * Deliberately does NOT redirect into the demo project, even though it
 * usually exists. It used to — landing a first-time visitor straight in the
 * demo — but every page's "Projects" breadcrumb links back to `/`, and an
 * unconditional redirect turned that into a dead loop: click it and you're
 * bounced right back to the page you were already on, with no way to ever
 * see an actual list. This page has to be a stable place to land.
 */
export default async function Home() {
  const projects = await listProjects();

  return (
    <main className="page">
      <h1>Schema Version Control</h1>
      <p className="text-dim">Branch, diff, and merge for database schemas.</p>

      <div style={{ marginTop: '1.5rem' }}>
        <NewProjectForm />
      </div>

      {projects.length === 0 ? (
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
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
          {projects.map((p) => (
            <li key={p.id} className="card" style={{ marginBottom: '0.75rem' }}>
              <Link href={`/p/${p.id}`} style={{ fontWeight: 600 }}>{p.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
