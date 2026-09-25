/**
 * Approved POA&M risk acceptances, as they appear in checklist exports.
 *
 * A risk-accepted finding keeps its checklist status (Open); the acceptance is
 * recorded in the finding's COMMENTS so STIG Viewer, eMASS and assessors can
 * see who accepted the risk, when, and why.
 */
import { In } from 'typeorm';
import { AppDataSource, mockStore } from '../database/dataSource';
import { PoamEntity } from '../models/Poam';

export interface RiskAcceptance {
  poamId: string;
  findingId?: string | null;
  status?: string | null;
  riskAcceptanceRationale?: string | null;
  residualRisk?: string | null;
  approvedByName?: string | null;
  approvedByOid?: string | null;
  approvedAt?: Date | string | null;
}

export const isRiskAccepted = (p: RiskAcceptance | null | undefined): p is RiskAcceptance =>
  !!p && p.status === 'risk_accepted' && !!p.approvedAt;

const isoDay = (d: Date | string | null | undefined) => {
  if (!d) return undefined;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};

export function riskAcceptanceNote(p: RiskAcceptance): string {
  const who = p.approvedByName || p.approvedByOid || 'an authorized approver';
  const when = isoDay(p.approvedAt) ?? 'an unrecorded date';
  const parts = [`Risk accepted under ${p.poamId} by ${who} on ${when}.`];
  if (p.residualRisk) parts.push(`Residual risk: ${p.residualRisk}.`);
  if (p.riskAcceptanceRationale) parts.push(`Rationale: ${p.riskAcceptanceRationale}`);
  return parts.join(' ');
}

/** The finding's own comments followed by the acceptance note, if any. */
export function withRiskAcceptance(comments: string | null | undefined, p?: RiskAcceptance): string {
  const base = (comments ?? '').trim();
  if (!p) return base;
  const note = riskAcceptanceNote(p);
  return base ? `${base}\n\n${note}` : note;
}

const CHUNK = 1000;

/** Latest approved risk acceptance per finding id. */
export async function loadRiskAcceptances(findingIds: string[]): Promise<Map<string, RiskAcceptance>> {
  const byFinding = new Map<string, RiskAcceptance>();
  const ids = Array.from(new Set(findingIds.filter(Boolean)));
  if (!ids.length) return byFinding;

  let rows: RiskAcceptance[] = [];
  if (process.env.MOCK_MODE === 'true') {
    const wanted = new Set(ids);
    rows = (mockStore.poams ?? []).filter((p: any) => wanted.has(p.findingId));
  } else {
    const repo = AppDataSource.getRepository(PoamEntity);
    for (let i = 0; i < ids.length; i += CHUNK) {
      rows.push(...await repo.find({
        where: { findingId: In(ids.slice(i, i + CHUNK)), status: 'risk_accepted' },
        loadEagerRelations: false,
      }));
    }
  }

  for (const p of rows) {
    if (!isRiskAccepted(p) || !p.findingId) continue;
    const prev = byFinding.get(p.findingId);
    if (!prev || new Date(p.approvedAt!).getTime() > new Date(prev.approvedAt!).getTime()) {
      byFinding.set(p.findingId, p);
    }
  }
  return byFinding;
}
