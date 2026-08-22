import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compareBranches } from '@/server/branches-service';
import { getBranch } from '@/db/branches';
import { getProject } from '@/db/projects';
import { ChangeRow } from '@/components/ChangeRow';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ base?: string; head?: string }>;
};

export default async function ComparePage({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { base: baseId, head: headId } = await searchParams;
  if (!baseId || !headId) notFound();

  const [project, base, head] = await Promise.all([
    getProject(projectId),
    getBranch(baseId),
    getBranch(headId),
  ]);
  if (!project || !base || !head || base.projectId !== projectId || head.projectId !== projectId) notFound();

  const { groups, headSchema } = await compareBranches(baseId, headId);
  const totalChanges = groups.reduce((n, g) => n + g.changes.length, 0);

  return (
    <main className="page">
      <p className="text-dim" style={{ marginBottom: '0.25rem' }}>
        <Link href="/">Projects</Link> / <Link href={`/p/${projectId}`}>{project.name}</Link>
      </p>
      <h1 style={{ marginTop: 0 }}>
        <span className="mono">{base.name}</span>
        <span className="text-dim" style={{ margin: '0 0.5rem' }}>→</span>
        <span className="mono">{head.name}</span>
      </h1>

      {totalChanges === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>These branches are identical.</p>
          <p className="text-dim" style={{ margin: '0.4rem 0 0' }}>
            Nothing has diverged between <span className="mono">{base.name}</span> and{' '}
            <span className="mono">{head.name}</span>.
          </p>
        </div>
      ) : (
        <>
          <p className="text-dim">
            {totalChanges} change{totalChanges === 1 ? '' : 's'} across {groups.length} table
            {groups.length === 1 ? '' : 's'}.
          </p>
          {groups.map((group) => (
            <section key={group.table?.id ?? '(unresolved)'} className="card" style={{ marginBottom: '1rem' }}>
              <h2 className="mono" style={{ margin: '0 0 0.25rem', fontSize: '1.05rem' }}>
                {group.table?.name ?? 'unresolved'}
              </h2>
              {group.changes.map((change, i) => (
                <ChangeRow key={i} change={change} schema={headSchema} />
              ))}
            </section>
          ))}
          <div style={{ marginTop: '1.5rem' }}>
            <Link className="btn btn-primary" href={`/p/${projectId}/merge?target=${baseId}&source=${headId}`}>
              Merge {head.name} into {base.name}
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
