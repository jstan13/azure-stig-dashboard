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
      sourceIdentifyingControl: 'Annual assessment',
      severity: 'Moderate',
      rawSeverity: 'Moderate',
      residualRiskLevel: 'Low',
    });
    expect(payload.milestones).toEqual([
      { description: 'Tabletop', scheduledCompletionDate: Math.floor(Date.parse(due) / 1000) },
    ]);
  });
});
