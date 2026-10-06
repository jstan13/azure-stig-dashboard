import { ControlEntity } from '../models/Control';
import { compareControls } from '../stigs/stigReleaseService';
import { ParsedControl } from '../stigs/xccdfParser';

function installed(overrides: Partial<ControlEntity> = {}): ControlEntity {
  return Object.assign(new ControlEntity(), {
    id: 'Example|V1R1|V-1',
    vulnId: 'V-1',
    ruleId: 'SV-1r1_rule',
    stigId: 'EX-01',
    title: 'Example rule',
    severity: 'medium',
    description: 'Discussion',
    checkContent: 'Check it',
    fixText: 'Fix it',
    ccis: ['CCI-000001'],
  }, overrides);
}

function available(overrides: Partial<ParsedControl> = {}): ParsedControl {
  return {
    id: 'Example|V-1',
    vulnId: 'V-1',
    ruleId: 'SV-1r1_rule',
    stigId: 'EX-01',
    groupId: 'SRG-1',
    title: 'Example rule',
    severity: 'medium',
    description: 'Discussion',
    checkContent: 'Check it',
    fixText: 'Fix it',
    checkType: 'Manual',
    checkParameters: {},
    ccis: ['CCI-000001'],
    stigName: 'Example',
    ...overrides,
  };
}

describe('STIG release comparison', () => {
  it('reports added, removed, changed, and severity-changed rules', () => {
    const diff = compareControls(
      [
        installed(),
        installed({ id: 'Example|V1R1|V-2', vulnId: 'V-2' }),
        installed({ id: 'Example|V1R1|V-3', vulnId: 'V-3', severity: 'low' }),
      ],
      [
        available({ title: 'Revised example rule' }),
        available({ id: 'Example|V-3', vulnId: 'V-3', severity: 'high' }),
        available({ id: 'Example|V-4', vulnId: 'V-4' }),
      ],
    );

    expect(diff).toEqual({
      added: ['V-4'],
      removed: ['V-2'],
      changed: ['V-1', 'V-3'],
      severityChanged: ['V-3'],
    });
  });

  it('does not flag unchanged rule content', () => {
    expect(compareControls([installed()], [available()])).toEqual({
      added: [],
      removed: [],
      changed: [],
      severityChanged: [],
    });
  });
});
