import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page">
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: '1.2rem' }}>Not found</h1>
        <p className="text-dim">
          This project, branch, or link doesn&apos;t exist — it may have been part of a
          demo that was reset, or the URL is stale.
        </p>
        <Link className="btn btn-primary" href="/">Back to projects</Link>
      </div>
    </main>
  );
}
