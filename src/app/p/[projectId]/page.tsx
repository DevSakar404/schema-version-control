import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProjectOverview } from '@/server/branches-service';
import { NotFound } from '@/server/http';
import { NewBranchForm } from '@/components/NewBranchForm';

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
      <h1>{project.name}</h1>

      <NewBranchForm
        projectId={project.id}
        branches={branches.map((b) => ({ id: b.id, name: b.name, headCommitId: b.headCommitId }))}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1.5rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
            <th style={{ padding: '0.5rem 0.25rem' }}>Branch</th>
            <th style={{ padding: '0.5rem 0.25rem' }}>Last change</th>
            <th style={{ padding: '0.5rem 0.25rem' }}>Diverged</th>
            <th style={{ padding: '0.5rem 0.25rem' }} />
          </tr>
        </thead>
        <tbody>
          {ordered.map((b) => (
            <tr key={b.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '0.6rem 0.25rem' }}>
                <span className="mono" style={{ fontWeight: b.isDefault ? 700 : 500 }}>
                  {b.name}
                </span>
                {b.isDefault && (
                  <span className="pill" style={{ marginLeft: '0.5rem', background: 'var(--border)' }}>
                    default
                  </span>
                )}
              </td>
              <td style={{ padding: '0.6rem 0.25rem' }}>
                <div>{b.lastMessage || <span className="text-dim">—</span>}</div>
                {b.lastAuthor && <div className="text-dim">by {b.lastAuthor}</div>}
              </td>
              <td style={{ padding: '0.6rem 0.25rem' }}>
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
              <td style={{ padding: '0.6rem 0.25rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {!b.isDefault && main && (
                  <>
                    <Link
                      className="btn"
                      href={`/p/${project.id}/compare?base=${main.id}&head=${b.id}`}
                      style={{ marginRight: '0.4rem' }}
                    >
                      Compare
                    </Link>
                    <Link className="btn btn-primary" href={`/p/${project.id}/merge?target=${main.id}&source=${b.id}`}>
                      Merge
                    </Link>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
