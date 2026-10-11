import type { QuoteLedgerPredicate } from './ledger-types';

/** Private transport metadata, never an authorization or public request DTO. */
export type PublicationIdentity = Readonly<{
  organizationId: string;
  snapshotId: string;
  installationId: string;
  userId: string;
  baseRevision: number;
  archiveSha256: string;
  manifestSha256: string;
  sizeBytes: number;
}>;

/** A trusted caller must corroborate this exact result against PostgreSQL. */
export type PublicationResult = Readonly<{
  committed: boolean;
  revision: number;
  snapshotId: string | null;
}>;

export type PublicationAttempt = PublicationIdentity &
  Readonly<{
    id: string;
    state: 'pending' | 'committed' | 'cancelled';
    result: PublicationResult | null;
    createdAt: number;
    settledAt: number | null;
  }>;

export type PublicationBeginResult = Readonly<{
  state: 'owned' | 'held' | 'settled';
  attempt: PublicationAttempt;
}>;

export type PublicationExpectation = Readonly<{
  organizationId: string;
  snapshotId: string;
  revision: number;
  baseRevision: number;
  archiveSha256: string;
  manifestSha256: string;
}>;

/** No network, permission, PostgreSQL verification or automatic lease transfer. */
export interface PublicationLedger {
  read(
    organizationId: string,
    snapshotId: string,
  ): Promise<PublicationAttempt | null>;
  begin(identity: PublicationIdentity): Promise<PublicationBeginResult>;
  settle(
    attempt: PublicationAttempt,
    verifiedPgResult: PublicationResult,
  ): Promise<PublicationAttempt>;
  publicationPredicate(expected: PublicationExpectation): QuoteLedgerPredicate;
}

export type PublicationLedgerErrorCode =
  | 'conflict'
  | 'invalid_record'
  | 'service_unavailable';

export class PublicationLedgerError extends Error {
  constructor(readonly code: PublicationLedgerErrorCode) {
    super(code);
  }
}
