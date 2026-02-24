/**
 * Base connector interface — all Azure connectors implement this.
 * In MOCK_MODE connectors return pre-seeded data without making real API calls.
 */

export interface ConnectorResult<T> {
  data: T[];
  nextToken?: string; // for pagination / incremental updates
  scannedAt: Date;
  source: string;
}

export interface ScanOptions {
  subscriptionIds?: string[];
  resourceGroupNames?: string[];
  resourceIds?: string[];      // on-demand per single resource
  since?: Date;                // incremental: only changes after this timestamp
  maxResults?: number;
}

export abstract class BaseConnector {
  protected readonly mockMode: boolean;

  constructor() {
    this.mockMode = process.env.MOCK_MODE === 'true';
  }

  abstract scan(options?: ScanOptions): Promise<ConnectorResult<any>>;
}
