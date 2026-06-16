/** Shared TypeScript types for the frontend */

export interface Machine {
  id: string;
  name: string;
  resourceId: string;
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroupName: string;
  location: string;
  osType: string;
  osVersion?: string;
  tags?: Record<string, string>;
  complianceScore: number;
  lastScanDate?: string;
  status: 'online' | 'offline' | 'unknown';
}

export interface Control {
  id: string;
  stigId: string;
  title: string;
  severity: 'high' | 'medium' | 'low' | 'informational';
  description?: string;
  checkContent?: string;
  fixText?: string;
  azurePolicyId?: string;
  defenderRuleId?: string;
}

export interface Finding {
  id: string;
  machineId: string;
  controlId: string;
  status: 'open' | 'not_a_finding' | 'not_applicable' | 'not_reviewed';
  severity: 'high' | 'medium' | 'low' | 'informational';
  comments?: string;
  findingDetails?: string;
  sourceType: string;
  /** Provenance of a manual answer: machine | pool | platform | null. */
  manualAnswerScope?: 'machine' | 'pool' | 'platform' | null;
  manualAnswerScopeId?: string | null;
  lastUpdated?: string;
  control?: Control;
}

export interface AssetPoolRef {
  id: string;
  name: string;
  role?: string | null;
}

export interface PlatformInfo {
  key: string;
  label: string;
}

export interface MachineDetail extends Machine {
  platform?: PlatformInfo;
  pools?: AssetPoolRef[];
  findings: Finding[];
  summary: {
    total: number;
    open: number;
    notAFinding: number;
    notApplicable: number;
    notReviewed: number;
    complianceScore: number;
  };
}

export interface Scan {
  id: string;
  machineId: string;
  machineName?: string;
  subscriptionId?: string;
  scanType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  totalControls: number;
  openFindings: number;
  compliantControls: number;
}

export interface GroupCompliance {
  resourceGroupName: string;
  machineCount: number;
  avgComplianceScore: number;
  machines?: Pick<Machine, 'id' | 'name' | 'complianceScore' | 'lastScanDate'>[];
  controls?: ControlRollup[];
}

export interface ControlRollup {
  controlId: string;
  stigId?: string;
  title?: string;
  severity?: string;
  open: number;
  not_a_finding: number;
  not_applicable: number;
  not_reviewed: number;
  total: number;
}

export interface AuditLog {
  id: string;
  action: string;
  actor: string;
  targetId?: string;
  targetType?: string;
  details?: Record<string, any>;
  timestamp: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
