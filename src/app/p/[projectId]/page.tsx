import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GitBranch, RotateCcw } from 'lucide-react';
import { getProjectOverview } from '@/server/branches-service';
import { NotFound } from '@/server/http';
import { NewBranchForm } from '@/components/NewBranchForm';
import { SeedButton } from '@/components/SeedButton';
import { BranchActions } from '@/components/BranchActions';
import { DEMO_PROJECT_ID } from '@/seed/demo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ projectId: string }> };

export default async function ProjectPage({ params }: Props) {
  const { projectId } = await params;

  let overview: Awaited<ReturnType<typeof getProjectOverview>>;
  try {
    overview = await getProjectOverview(projectId);
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }

  const { project, branches } = overview;
  const main = branches.find((b) => b.isDefault);
  // main first, then most recently updated
  const ordered = [...branches].sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <main className="page">
      <p className="text-dim" style={{ marginBottom: '0.25rem' }}>
        <Link href="/">Projects</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <h1 style={{ margin: 0 }}>{project.name}</h1>
        {project.id === DEMO_PROJECT_ID && (
          <SeedButton label="Reset demo" icon={<RotateCcw size={14} strokeWidth={2.25} aria-hidden />} />
        )}
      </div>

      <NewBranchForm
        projectId={project.id}
        branches={branches.map((b) => ({ id: b.id, name: b.name, headCommitId: b.headCommitId }))}
      />

      <table className="branch-table" style={{ marginTop: '1.5rem' }}>
        <thead>
          <tr>
            <th>Branch</th>
            <th>Last change</th>
            <th>Diverged</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ordered.map((b) => (
            <tr key={b.id}>
              <td>
                <span className="branch-name">
                  <GitBranch size={14} strokeWidth={2} aria-hidden />
                  <Link href={`/p/${project.id}/b/${b.id}`} className="mono" style={{ fontWeight: b.isDefault ? 700 : 500 }}>
                    {b.name}
                  </Link>
                </span>
                {b.isDefault && (
                  <span className="pill pill-accent" style={{ marginLeft: '0.5rem' }}>
                    default
                  </span>
                )}
              </td>
              <td>
                <div className="commit-message" title={b.lastMessage ?? undefined}>
                  {b.lastMessage || <span className="text-dim">—</span>}
                </div>
                {b.lastAuthor && <div className="text-dim">by {b.lastAuthor}</div>}
              </td>
              <td>
                {b.isDefault ? (
                  <span className="text-dim">—</span>
                ) : b.ahead === 0 && b.behind === 0 ? (
                  <span className="text-dim">up to date</span>
                ) : (
                  <span className="mono text-dim">
                    {b.ahead > 0 && <span style={{ color: 'var(--safe)' }}>+{b.ahead}</span>}
                    {b.ahead > 0 && b.behind > 0 && ' / '}
                    {b.behind > 0 && <span style={{ color: 'var(--warning)' }}>-{b.behind}</span>}
                  </span>
                )}
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {!b.isDefault && main && (
                  <BranchActions
                    projectId={project.id}
                    branch={{ id: b.id, name: b.name }}
                    others={branches.filter((other) => other.id !== b.id).map((o) => ({ id: o.id, name: o.name }))}
                    defaultAgainstId={main.id}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
