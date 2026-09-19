import { BrainError } from './types.js';

export interface TransferLoss {
  code: string;
  record?: { kind: 'entity' | 'edge'; id: string };
  fields?: string[];
  message: string;
}
export interface TransferMapping {
  kind: 'entity' | 'edge';
  externalId: string;
  localId: string;
  status: 'new' | 'unchanged' | 'conflict' | 'deleted';
}
/** Safe metadata only; retained claims are available through normal source policy. */
export interface TransferReport {
  format: 'calliope-brain-transfer-report/v1';
  operation: 'import' | 'export';
  representation: 'graph-projection';
  origin: { id: string; revision: string };
  destinationRevision?: string;
  manifestHash: string | null;
  metadataSourceId?: string;
  losses: TransferLoss[];
  mappings: TransferMapping[];
  conflicts: number;
  changes: number;
}
export class BrainTransferError extends BrainError {
  constructor(
    code: 'invalid' | 'conflict',
    message: string,
    readonly report: TransferReport,
  ) {
    super(code, message);
    this.name = 'BrainTransferError';
  }
}
