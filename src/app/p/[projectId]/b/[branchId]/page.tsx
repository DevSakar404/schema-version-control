import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBranchSchema } from '@/server/branches-service';
import { NotFound } from '@/server/http';
import { getBranch } from '@/db/branches';
import { getProject } from '@/db/projects';
import { SchemaTree } from '@/components/SchemaTree';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ projectId: string; branchId: string }> };

export default async function BranchEditorPage({ params }: Props) {
  const { projectId, branchId } = await params;

  const [branch, project] = await Promise.all([getBranch(branchId), getProject(projectId)]);
  if (!branch || !project || branch.projectId !== projectId) notFound();

  let schema: Awaited<ReturnType<typeof getBranchSchema>>;
  try {
    schema = await getBranchSchema(branchId);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }

  return (
    <main className="page">
      <p className="text-dim" style={{ marginBottom: '0.25rem' }}>
        <Link href="/">Projects</Link> / <Link href={`/p/${projectId}`}>{project.name}</Link>
      </p>
      <h1 className="mono" style={{ marginTop: 0 }}>{branch.name}</h1>

      <SchemaTree
        branchId={branch.id}
        branchName={branch.name}
        headCommitId={schema.headCommitId}
        schema={schema.schema}
      />
    </main>
  );
}
