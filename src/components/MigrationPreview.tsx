'use client';

/**
 * The migration output (design.md §9, §12). The merged schema answers an
 * academic question; this answers the user's actual one — what do I run on
 * Monday. Every statement carries a safety badge, and anything not `safe`
 * shows its `note` right beside the badge rather than making the user go
 * looking for why.
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Statement } from '@/core/migrate';
import type { Safety } from '@/core/safety';

const SAFETY: Record<Safety, { pillClass: string; label: string }> = {
  safe: { pillClass: 'pill-safe', label: 'safe' },
  destructive: { pillClass: 'pill-danger', label: 'destructive' },
  lossy: { pillClass: 'pill-warning', label: 'lossy' },
  blocking: { pillClass: 'pill-blocking', label: 'blocking' },
};

export function MigrationPreview({ statements, sql }: { statements: Statement[]; sql: string }) {
  const [copied, setCopied] = useState(false);
  const counts = statements.reduce<Record<Safety, number>>(
    (acc, s) => ({ ...acc, [s.safety]: (acc[s.safety] ?? 0) + 1 }),
    { safe: 0, destructive: 0, lossy: 0, blocking: 0 },
  );

  async function copy() {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Migration</h2>
        <button type="button" className="btn" onClick={copy} disabled={statements.length === 0}>
          {copied ? <Check size={14} strokeWidth={2.25} aria-hidden /> : <Copy size={14} strokeWidth={2} aria-hidden />}
          {copied ? 'Copied' : 'Copy SQL'}
        </button>
      </div>

      {statements.length === 0 ? (
        <p className="text-dim" style={{ margin: 0 }}>No schema changes to apply.</p>
      ) : (
        <>
          <p className="text-dim" style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>
            {statements.length} statement{statements.length === 1 ? '' : 's'}.
            {counts.destructive > 0 && ` ${counts.destructive} destructive.`}
            {counts.lossy > 0 && ` ${counts.lossy} lossy.`}
            {counts.blocking > 0 && ` ${counts.blocking} blocking.`}
          </p>
          <div>
            {statements.map((statement) => (
              <StatementRow key={statement.id} statement={statement} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function StatementRow({ statement }: { statement: Statement }) {
  const { pillClass, label } = SAFETY[statement.safety];
  const isTemp = statement.op.kind === 'rename_step' && statement.sql.includes('__tmp');
  return (
    <div style={{ padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
        <span className={`pill ${pillClass}`} style={{ flexShrink: 0 }}>{label}</span>
        <code className="mono" style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{statement.sql}</code>
      </div>
      {statement.note && (
        <p className="text-dim" style={{ margin: '0.25rem 0 0 3.6rem', fontSize: '0.8rem' }}>{statement.note}</p>
      )}
      {isTemp && (
        <p className="text-dim" style={{ margin: '0.25rem 0 0 3.6rem', fontSize: '0.8rem' }}>
          Uses a temporary name to break a rename cycle — the final schema doesn&apos;t keep it.
        </p>
      )}
    </div>
  );
}
