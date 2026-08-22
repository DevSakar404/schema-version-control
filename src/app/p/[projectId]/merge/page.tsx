import Link from 'next/link';
import { notFound } from 'next/navigation';
import { previewMerge } from '@/server/branches-service';
import { Unprocessable } from '@/server/http';
import { getProject } from '@/db/projects';
import { MergeBoard } from '@/components/MergeBoard';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ target?: string; source?: string }>;
};

export default async function MergePage({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { target, source } = await searchParams;
  if (!target || !source) notFound();

  const project = await getProject(projectId);
  if (!project) notFound();

  let preview: Awaited<ReturnType<typeof previewMerge>>;
  try {
    preview = await previewMerge(target, source, []);
  } catch (e) {
    if (e instanceof Unprocessable) {
      return (
        <main className="page">
          <p className="text-dim"><Link href={`/p/${projectId}`}>{project.name}</Link></p>
          <div className="card"><p style={{ margin: 0 }}>{e.message}</p></div>
        </main>
      );
    }
    throw e;
  }

  return (
    <main className="page">
      <p className="text-dim" style={{ marginBottom: '0.25rem' }}>
        <Link href="/">Projects</Link> / <Link href={`/p/${projectId}`}>{project.name}</Link>
      </p>
      <h1 style={{ marginTop: 0 }}>
        <span className="mono">{preview.source.name}</span>
        <span className="text-dim" style={{ margin: '0 0.5rem' }}>→</span>
        <span className="mono">{preview.target.name}</span>
      </h1>

      <MergeBoard projectId={projectId} targetId={target} sourceId={source} initialPreview={preview} />
    </main>
  );
}
