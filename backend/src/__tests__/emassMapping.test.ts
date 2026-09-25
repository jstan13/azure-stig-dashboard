import { poamToEmass, toEmassRiskLevel } from '../routes/emass';

describe('toEmassRiskLevel', () => {
  it.each([
    ['high', 'High'],
    ['medium', 'Moderate'],
    ['low', 'Low'],
    ['CAT I', 'High'],
    ['cat_ii', 'Moderate'],
    ['III', 'Low'],
    ['critical', 'Very High'],
    ['informational', 'Very Low'],
    ['Very High', 'Very High'],
    ['moderate', 'Moderate'],
  ])('maps %s to %s', (input, expected) => {
    expect(toEmassRiskLevel(input)).toBe(expected);
  });

  it.each([undefined, null, '', 'whatever'])('returns undefined for %p', (input) => {
    expect(toEmassRiskLevel(input as any)).toBeUndefined();
  });
});

describe('poamToEmass', () => {
  it('sends the eMASS five-point scale for CAT II POA&Ms and uses milestone due dates', () => {
    const due = '2030-06-30T12:00:00.000Z';
    const payload = poamToEmass({
      poamId: 'POA-2026-0007',
      weakness: 'No IR test',
      severity: 'medium',
      residualRisk: 'Low',
      controlAcronym: 'IR-3',
      sourceIdentifyingControl: 'Annual assessment',
      status: 'open',
      milestones: [{ description: 'Tabletop', dueDate: due }],
    });

    expect(payload).toMatchObject({
      externalUid: 'POA-2026-0007',
      controlAcronym: 'IR-3',
      sourceIdentifyingVulnerability: 'Annual assessment',
      severity: 'Moderate',
      rawSeverity: 'Moderate',
      residualRiskLevel: 'Low',
    });
    expect(payload.comments).toBeUndefined();
    expect(payload.milestones).toEqual([
      { description: 'Tabletop', scheduledCompletionDate: Math.floor(Date.parse(due) / 1000) },
    ]);
  });

  it('names the STIG scan as the source of a finding-linked POA&M', () => {
    const payload = poamToEmass({ poamId: 'POA-2026-0008', weakness: 'x', findingId: 'f1', status: 'open' });
    expect(payload.sourceIdentifyingVulnerability).toMatch(/STIG/);
  });

  it('sends Risk Accepted items with comments and no schedule or milestones', () => {
    const payload = poamToEmass({
      poamId: 'POA-2026-0009',
      weakness: 'Legacy TLS on appliance',
      severity: 'high',
      status: 'risk_accepted',
      residualRisk: 'Moderate',
      riskAcceptanceRationale: 'x'.repeat(3000),
      approvedByName: 'Jane ISSM',
      approvedAt: '2026-09-01T15:00:00.000Z',
      scheduledCompletion: '2026-12-01',
      milestones: [{ description: 'Replace appliance', dueDate: '2026-12-01' }],
    });

    expect(payload.status).toBe('Risk Accepted');
    expect(payload.scheduledCompletionDate).toBeUndefined();
    expect(payload.milestones).toBeUndefined();
    expect(payload.comments).toMatch(/^Risk accepted under POA-2026-0009 by Jane ISSM on 2026-09-01\. Residual risk: Moderate\. Rationale: x+/);
    expect(payload.comments!.length).toBe(2000);
  });

  it('sends Completed items with a completion date and comments', () => {
    const payload = poamToEmass({
      poamId: 'POA-2026-0010', weakness: 'Fixed', status: 'closed', actualCompletion: '2026-08-15T12:00:00.000Z',
    });
    expect(payload.status).toBe('Completed');
    expect(payload.completionDate).toBe(Math.floor(Date.parse('2026-08-15T12:00:00.000Z') / 1000));
    expect(payload.comments).toMatch(/2026-08-15/);
  });
});
