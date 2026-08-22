import Link from 'next/link';
import { listProjects } from '@/db/projects';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const projects = await listProjects();

  return (
    <main className="page">
      <h1>Schema Version Control</h1>
      <p className="text-dim">Branch, diff, and merge for database schemas.</p>

      {projects.length === 0 ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <p>No projects yet.</p>
          <p className="text-dim">
            Run <code>npm run db:seed</code> to load a demo project with two branches
            already diverged and a live conflict waiting.
          </p>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
          {projects.map((p) => (
            <li key={p.id} className="card" style={{ marginBottom: '0.75rem' }}>
              <Link href={`/p/${p.id}`}>{p.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
