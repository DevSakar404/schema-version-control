import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compareBranches } from '@/server/branches-service';
import { getBranch } from '@/db/branches';
import { getProject } from '@/db/projects';
import type { DiffView } from '@/components/SchemaDiffTree';
import { DiffViewToggle } from '@/components/DiffViewToggle';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ base?: string; head?: string; view?: string }>;
};

export default async function ComparePage({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { base: baseId, head: headId, view: viewParam } = await searchParams;
  if (!baseId || !headId) notFound();
  const view: DiffView = viewParam === 'split' ? 'split' : 'unified';

  const [project, base, head] = await Promise.all([
    getProject(projectId),
    getBranch(baseId),
    getBranch(headId),
  ]);
  if (!project || !base || !head || base.projectId !== projectId || head.projectId !== projectId) notFound();

  const { tree } = await compareBranches(baseId, headId);

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

      {tree.totalChanges === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>These branches are identical.</p>
          <p className="text-dim" style={{ margin: '0.4rem 0 0' }}>
            Nothing has diverged between <span className="mono">{base.name}</span> and{' '}
            <span className="mono">{head.name}</span>.
          </p>
        </div>
      ) : (
        <>
          <DiffViewToggle
            tree={tree}
            initialView={view}
            urlBase={`/p/${projectId}/compare?base=${baseId}&head=${headId}`}
          />
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
