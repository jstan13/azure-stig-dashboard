/**
 * POA&M CSV Exporter
 *
 * Produces a DISA-compatible POA&M CSV export.
 * Column headers align with the DoD CIO POA&M template fields.
 */

export interface PoamRow {
  poamId: string;
  weakness: string;
  severity?: string | null;
  status: string;
  controlAcronym?: string | null;
  sourceIdentifyingControl?: string | null;
  findingId?: string | null;
  scheduledCompletion?: Date | string | null;
  actualCompletion?: Date | string | null;
  assignedToName?: string;
  countermeasures?: string;
  resourcesRequired?: string;
  delayReason?: string;
  riskAcceptanceRationale?: string;
  residualRisk?: string;
  approvedByName?: string | null;
  approvedByOid?: string | null;
  approvedAt?: Date | string | null;
  milestones?: Array<{ description: string; status: string; dueDate?: string | Date }>;
}

function esc(val: unknown): string {
  let s = val == null ? '' : String(val);
  // Neutralise CSV/Excel formula injection (=, +, -, @, tab, CR) per OWASP by
  // prefixing a leading apostrophe so spreadsheet apps treat the cell as text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
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
    'Security Control',
    'Source Identifying Weakness',
    'Scheduled Completion',
    'Actual Completion',
    'Assigned To',
    'Countermeasures / Planned Completion',
    'Resources Required',
    'Delay Reason',
    'Risk Acceptance Rationale',
    'Residual Risk',
    'Risk Accepted By',
    'Risk Accepted Date',
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

    const accepted = p.status === 'risk_accepted' && !!p.approvedAt;

    return [
      esc(p.poamId),
      esc(p.weakness),
      esc(catLabel),
      esc(p.status),
      esc(p.controlAcronym),
      esc(p.sourceIdentifyingControl || (p.findingId ? 'STIG scan finding' : '')),
      esc(fmtDate(p.scheduledCompletion)),
      esc(fmtDate(p.actualCompletion)),
      esc(p.assignedToName),
      esc(p.countermeasures),
      esc(p.resourcesRequired),
      esc(p.delayReason),
      esc(p.riskAcceptanceRationale),
      esc(p.residualRisk),
      esc(accepted ? (p.approvedByName || p.approvedByOid) : ''),
      esc(accepted ? fmtDate(p.approvedAt) : ''),
      esc(milestoneSummary),
    ].join(',');
  });

  return [headers.map(esc).join(','), ...rows].join('\r\n');
}
