/**
 * POA&M CSV Exporter
 *
 * Produces a DISA-compatible POA&M CSV export.
 * Column headers align with the DoD CIO POA&M template fields.
 */

export interface PoamRow {
  poamId: string;
  weakness: string;
  severity?: string;
  status: string;
  scheduledCompletion?: Date | string | null;
  actualCompletion?: Date | string | null;
  assignedToName?: string;
  countermeasures?: string;
  resourcesRequired?: string;
  delayReason?: string;
  riskAcceptanceRationale?: string;
  milestones?: Array<{ description: string; status: string; dueDate?: string }>;
}

function esc(val: unknown): string {
  const s = val == null ? '' : String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US'); } catch { return ''; }
}

export function generatePoamCsv(poams: PoamRow[]): string {
  const headers = [
    'POA&M ID',
    'Weakness / Vulnerability',
    'Severity (CAT)',
    'Status',
    'Scheduled Completion',
    'Actual Completion',
    'Assigned To',
    'Countermeasures / Planned Completion',
    'Resources Required',
    'Delay Reason',
    'Risk Acceptance Rationale',
    'Milestones',
  ];

  const rows = poams.map((p) => {
    const catLabel =
      p.severity === 'high'   ? 'CAT I' :
      p.severity === 'medium' ? 'CAT II' :
      p.severity === 'low'    ? 'CAT III' : (p.severity ?? '');

    const milestoneSummary = (p.milestones ?? [])
      .map((m) => `[${m.status.toUpperCase()}] ${m.description}${m.dueDate ? ` (due ${fmtDate(m.dueDate)})` : ''}`)
      .join(' | ');

    return [
      esc(p.poamId),
      esc(p.weakness),
      esc(catLabel),
      esc(p.status),
      esc(fmtDate(p.scheduledCompletion)),
      esc(fmtDate(p.actualCompletion)),
      esc(p.assignedToName),
      esc(p.countermeasures),
      esc(p.resourcesRequired),
      esc(p.delayReason),
      esc(p.riskAcceptanceRationale),
      esc(milestoneSummary),
    ].join(',');
  });

  return [headers.map(esc).join(','), ...rows].join('\r\n');
}
