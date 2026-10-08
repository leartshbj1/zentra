import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
import { LEGACY_COUNTRY_GUARD_CODE } from './international/legacy-country-guard';
const spies = vi.hoisted(() => ({ database: vi.fn(), fileArchive: vi.fn(), session: vi.fn(), rate: vi.fn() }));
vi.mock('@/lib/runtime', () => ({ database: spies.database, fileArchive: spies.fileArchive }));
vi.mock('@/lib/account', async original => ({ ...await original<object>(), requireDeviceSession: spies.session, enforceAccountRateLimit: spies.rate }));
import * as surface0 from './business-sync-blob-store';
import * as surface1 from './business-sync-bootstrap';
import * as surface2 from './business-sync-committed-files';
import * as surface3 from './business-sync-credit-projection';
import * as surface4 from './business-sync-files-http';
import * as surface5 from './business-sync-files';
import * as surface6 from './business-sync-history';
import * as surface7 from './business-sync-integrity';
import * as surface8 from './business-sync-native-guard-digests';
import * as surface9 from './business-sync-publication';
import * as surface10 from './business-sync-retirement';
import * as surface11 from './business-sync-state-fingerprint';
import * as surface12 from './business-sync-transaction-chunk';
import * as surface13 from './business-sync-transaction-commit';
import * as surface14 from './business-sync-transaction-delivery';
import * as surface15 from './business-sync-transaction-files';
import * as surface16 from './business-sync-transaction-fingerprint';
import * as surface17 from './business-sync-transaction-review';
import * as surface18 from './business-sync-transaction-transitions';
import * as surface19 from './business-sync-transaction-validation';
import * as surface20 from './business-sync-transactions';
import * as surface21 from './business-sync-validation';
import * as surface24 from './company-copy';
import * as surface25 from './document-number-reservations';
import * as surface26 from './workspace-backup';

// Deliberately incomplete arguments: a country denial must precede body parsing,
// legacy receipt/replay queries, reservations, storage and financial work.
const entries: { name: string; call: (organization: string, db: D1Database, body: Request) => Promise<unknown> }[] = [
  { name: 'business-sync-blob-store.ts:storedBlobPart', call: (organization, _db, _body) => surface0.storedBlobPart((organization) as unknown as Parameters<typeof surface0.storedBlobPart>[0], (`business-sync/${organization}/fixture`) as unknown as Parameters<typeof surface0.storedBlobPart>[1], (0) as unknown as Parameters<typeof surface0.storedBlobPart>[2]) },
  { name: 'business-sync-blob-store.ts:verifyStoredBlob', call: (organization, _db, _body) => surface0.verifyStoredBlob((organization) as unknown as Parameters<typeof surface0.verifyStoredBlob>[0], ([]) as unknown as Parameters<typeof surface0.verifyStoredBlob>[1], (0) as unknown as Parameters<typeof surface0.verifyStoredBlob>[2], (undefined) as unknown as Parameters<typeof surface0.verifyStoredBlob>[3], ((index: number) => `business-sync/${organization}/fixture/${index}`) as unknown as Parameters<typeof surface0.verifyStoredBlob>[4]) },
  { name: 'business-sync-bootstrap.ts:bootstrapStatus', call: (organization, _db, _body) => surface1.bootstrapStatus((session(organization)) as unknown as Parameters<typeof surface1.bootstrapStatus>[0], (undefined) as unknown as Parameters<typeof surface1.bootstrapStatus>[1]) },
  { name: 'business-sync-bootstrap.ts:beginBootstrap', call: (organization, _db, _body) => surface1.beginBootstrap((session(organization)) as unknown as Parameters<typeof surface1.beginBootstrap>[0], (undefined) as unknown as Parameters<typeof surface1.beginBootstrap>[1], (undefined) as unknown as Parameters<typeof surface1.beginBootstrap>[2]) },
  { name: 'business-sync-bootstrap.ts:uploadBootstrapChunk', call: (organization, _db, body) => surface1.uploadBootstrapChunk((session(organization)) as unknown as Parameters<typeof surface1.uploadBootstrapChunk>[0], (undefined) as unknown as Parameters<typeof surface1.uploadBootstrapChunk>[1], (undefined) as unknown as Parameters<typeof surface1.uploadBootstrapChunk>[2], (body) as unknown as Parameters<typeof surface1.uploadBootstrapChunk>[3]) },
  { name: 'business-sync-bootstrap.ts:abandonBootstrap', call: (organization, _db, _body) => surface1.abandonBootstrap((session(organization)) as unknown as Parameters<typeof surface1.abandonBootstrap>[0], (undefined) as unknown as Parameters<typeof surface1.abandonBootstrap>[1]) },
  { name: 'business-sync-committed-files.ts:committedBusinessTransactionFile', call: (organization, _db, _body) => surface2.committedBusinessTransactionFile((session(organization)) as unknown as Parameters<typeof surface2.committedBusinessTransactionFile>[0], (undefined) as unknown as Parameters<typeof surface2.committedBusinessTransactionFile>[1], (undefined) as unknown as Parameters<typeof surface2.committedBusinessTransactionFile>[2], (undefined) as unknown as Parameters<typeof surface2.committedBusinessTransactionFile>[3]) },
  { name: 'business-sync-credit-projection.ts:creditProjectionStatus', call: (organization, db, _body) => surface3.creditProjectionStatus(({ db, binding: ["transfer", organization] }) as unknown as Parameters<typeof surface3.creditProjectionStatus>[0]) },
  { name: 'business-sync-credit-projection.ts:validateCreditProjection', call: (organization, db, _body) => surface3.validateCreditProjection(({ db, binding: ["transfer", organization] }) as unknown as Parameters<typeof surface3.validateCreditProjection>[0]) },
  { name: 'business-sync-files-http.ts:businessFilesSession', call: (organization, _db, body) => surface4.businessFilesSession((body) as unknown as Parameters<typeof surface4.businessFilesSession>[0]) },
  { name: 'business-sync-files.ts:businessFilesStatus', call: (organization, _db, _body) => surface5.businessFilesStatus((session(organization)) as unknown as Parameters<typeof surface5.businessFilesStatus>[0], (undefined) as unknown as Parameters<typeof surface5.businessFilesStatus>[1]) },
  { name: 'business-sync-files.ts:beginBusinessFiles', call: (organization, _db, _body) => surface5.beginBusinessFiles((session(organization)) as unknown as Parameters<typeof surface5.beginBusinessFiles>[0], (undefined) as unknown as Parameters<typeof surface5.beginBusinessFiles>[1], (undefined) as unknown as Parameters<typeof surface5.beginBusinessFiles>[2]) },
  { name: 'business-sync-files.ts:uploadBusinessFilePage', call: (organization, _db, body) => surface5.uploadBusinessFilePage((session(organization)) as unknown as Parameters<typeof surface5.uploadBusinessFilePage>[0], (undefined) as unknown as Parameters<typeof surface5.uploadBusinessFilePage>[1], (undefined) as unknown as Parameters<typeof surface5.uploadBusinessFilePage>[2], (body) as unknown as Parameters<typeof surface5.uploadBusinessFilePage>[3]) },
  { name: 'business-sync-files.ts:businessFileStatus', call: (organization, _db, _body) => surface5.businessFileStatus((session(organization)) as unknown as Parameters<typeof surface5.businessFileStatus>[0], (undefined) as unknown as Parameters<typeof surface5.businessFileStatus>[1], (undefined) as unknown as Parameters<typeof surface5.businessFileStatus>[2]) },
  { name: 'business-sync-files.ts:uploadBusinessFilePart', call: (organization, _db, body) => surface5.uploadBusinessFilePart((session(organization)) as unknown as Parameters<typeof surface5.uploadBusinessFilePart>[0], (undefined) as unknown as Parameters<typeof surface5.uploadBusinessFilePart>[1], (undefined) as unknown as Parameters<typeof surface5.uploadBusinessFilePart>[2], (undefined) as unknown as Parameters<typeof surface5.uploadBusinessFilePart>[3], (body) as unknown as Parameters<typeof surface5.uploadBusinessFilePart>[4]) },
  { name: 'business-sync-files.ts:verifyBusinessFile', call: (organization, _db, _body) => surface5.verifyBusinessFile((session(organization)) as unknown as Parameters<typeof surface5.verifyBusinessFile>[0], (undefined) as unknown as Parameters<typeof surface5.verifyBusinessFile>[1], (undefined) as unknown as Parameters<typeof surface5.verifyBusinessFile>[2]) },
  { name: 'business-sync-files.ts:completeBusinessFiles', call: (organization, _db, _body) => surface5.completeBusinessFiles((session(organization)) as unknown as Parameters<typeof surface5.completeBusinessFiles>[0], (undefined) as unknown as Parameters<typeof surface5.completeBusinessFiles>[1]) },
  { name: 'business-sync-files.ts:cleanupBootstrapFiles', call: (organization, _db, _body) => surface5.cleanupBootstrapFiles((organization) as unknown as Parameters<typeof surface5.cleanupBootstrapFiles>[0], (undefined) as unknown as Parameters<typeof surface5.cleanupBootstrapFiles>[1]) },
  { name: 'business-sync-history.ts:historyHead', call: (organization, _db, _body) => surface6.historyHead((session(organization)) as unknown as Parameters<typeof surface6.historyHead>[0]) },
  { name: 'business-sync-history.ts:historyChunk', call: (organization, _db, _body) => surface6.historyChunk((session(organization)) as unknown as Parameters<typeof surface6.historyChunk>[0], (undefined) as unknown as Parameters<typeof surface6.historyChunk>[1], (undefined) as unknown as Parameters<typeof surface6.historyChunk>[2]) },
  { name: 'business-sync-history.ts:historyFilePage', call: (organization, _db, _body) => surface6.historyFilePage((session(organization)) as unknown as Parameters<typeof surface6.historyFilePage>[0], (undefined) as unknown as Parameters<typeof surface6.historyFilePage>[1], (undefined) as unknown as Parameters<typeof surface6.historyFilePage>[2]) },
  { name: 'business-sync-history.ts:historyFilePart', call: (organization, _db, _body) => surface6.historyFilePart((session(organization)) as unknown as Parameters<typeof surface6.historyFilePart>[0], (undefined) as unknown as Parameters<typeof surface6.historyFilePart>[1], (undefined) as unknown as Parameters<typeof surface6.historyFilePart>[2], (undefined) as unknown as Parameters<typeof surface6.historyFilePart>[3]) },
  { name: 'business-sync-integrity.ts:bootstrapIntegrityStatus', call: (organization, _db, _body) => surface7.bootstrapIntegrityStatus((session(organization)) as unknown as Parameters<typeof surface7.bootstrapIntegrityStatus>[0], (undefined) as unknown as Parameters<typeof surface7.bootstrapIntegrityStatus>[1]) },
  { name: 'business-sync-integrity.ts:validateBootstrapIntegrity', call: (organization, _db, _body) => surface7.validateBootstrapIntegrity((session(organization)) as unknown as Parameters<typeof surface7.validateBootstrapIntegrity>[0], (undefined) as unknown as Parameters<typeof surface7.validateBootstrapIntegrity>[1]) },
  { name: 'business-sync-native-guard-digests.ts:nativeGuardDigests', call: (organization, _db, _body) => surface8.nativeGuardDigests((undefined) as unknown as Parameters<typeof surface8.nativeGuardDigests>[0], (organization) as unknown as Parameters<typeof surface8.nativeGuardDigests>[1], (undefined) as unknown as Parameters<typeof surface8.nativeGuardDigests>[2], (undefined) as unknown as Parameters<typeof surface8.nativeGuardDigests>[3], (undefined) as unknown as Parameters<typeof surface8.nativeGuardDigests>[4]) },
  { name: 'business-sync-publication.ts:publishedHistory', call: (organization, _db, _body) => surface9.publishedHistory((session(organization)) as unknown as Parameters<typeof surface9.publishedHistory>[0], (undefined) as unknown as Parameters<typeof surface9.publishedHistory>[1]) },
  { name: 'business-sync-publication.ts:publishBootstrap', call: (organization, _db, _body) => surface9.publishBootstrap((session(organization)) as unknown as Parameters<typeof surface9.publishBootstrap>[0], (undefined) as unknown as Parameters<typeof surface9.publishBootstrap>[1]) },
  { name: 'business-sync-retirement.ts:businessRetirement', call: (organization, _db, _body) => surface10.businessRetirement((session(organization)) as unknown as Parameters<typeof surface10.businessRetirement>[0], (undefined) as unknown as Parameters<typeof surface10.businessRetirement>[1]) },
  { name: 'business-sync-retirement.ts:retireBusinessTransactions', call: (organization, _db, _body) => surface10.retireBusinessTransactions((session(organization)) as unknown as Parameters<typeof surface10.retireBusinessTransactions>[0], (undefined) as unknown as Parameters<typeof surface10.retireBusinessTransactions>[1]) },
  { name: 'business-sync-retirement.ts:businessRetirementCancellation', call: (organization, _db, _body) => surface10.businessRetirementCancellation((session(organization)) as unknown as Parameters<typeof surface10.businessRetirementCancellation>[0], (undefined) as unknown as Parameters<typeof surface10.businessRetirementCancellation>[1]) },
  { name: 'business-sync-retirement.ts:cancelBusinessRetirement', call: (organization, _db, _body) => surface10.cancelBusinessRetirement((session(organization)) as unknown as Parameters<typeof surface10.cancelBusinessRetirement>[0], (undefined) as unknown as Parameters<typeof surface10.cancelBusinessRetirement>[1]) },
  { name: 'business-sync-retirement.ts:requireUnretiredTransaction', call: (organization, _db, _body) => surface10.requireUnretiredTransaction((session(organization)) as unknown as Parameters<typeof surface10.requireUnretiredTransaction>[0], ({ organization_id: organization }) as unknown as Parameters<typeof surface10.requireUnretiredTransaction>[1]) },
  { name: 'business-sync-state-fingerprint.ts:fingerprintStatePage', call: (organization, db, _body) => surface11.fingerprintStatePage((db) as unknown as Parameters<typeof surface11.fingerprintStatePage>[0], (undefined) as unknown as Parameters<typeof surface11.fingerprintStatePage>[1], (organization) as unknown as Parameters<typeof surface11.fingerprintStatePage>[2], (undefined) as unknown as Parameters<typeof surface11.fingerprintStatePage>[3]) },
  { name: 'business-sync-transaction-chunk.ts:readBusinessTransactionChunkBytes', call: (organization, _db, _body) => surface12.readBusinessTransactionChunkBytes((undefined) as unknown as Parameters<typeof surface12.readBusinessTransactionChunkBytes>[0], ({ organization_id: organization }) as unknown as Parameters<typeof surface12.readBusinessTransactionChunkBytes>[1], (0) as unknown as Parameters<typeof surface12.readBusinessTransactionChunkBytes>[2]) },
  { name: 'business-sync-transaction-chunk.ts:readBusinessTransactionChunk', call: (organization, _db, _body) => surface12.readBusinessTransactionChunk((undefined) as unknown as Parameters<typeof surface12.readBusinessTransactionChunk>[0], ({ organization_id: organization }) as unknown as Parameters<typeof surface12.readBusinessTransactionChunk>[1], (0) as unknown as Parameters<typeof surface12.readBusinessTransactionChunk>[2]) },
  { name: 'business-sync-transaction-commit.ts:committedBusinessTransaction', call: (organization, _db, _body) => surface13.committedBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface13.committedBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransaction>[1]) },
  { name: 'business-sync-transaction-commit.ts:committedBusinessTransactionResource', call: (organization, _db, _body) => surface13.committedBusinessTransactionResource((session(organization)) as unknown as Parameters<typeof surface13.committedBusinessTransactionResource>[0], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransactionResource>[1], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransactionResource>[2], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransactionResource>[3]) },
  { name: 'business-sync-transaction-commit.ts:committedBusinessTransactionsSince', call: (organization, _db, _body) => surface13.committedBusinessTransactionsSince((session(organization)) as unknown as Parameters<typeof surface13.committedBusinessTransactionsSince>[0], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransactionsSince>[1], (undefined) as unknown as Parameters<typeof surface13.committedBusinessTransactionsSince>[2]) },
  { name: 'business-sync-transaction-commit.ts:commitBusinessTransaction', call: (organization, _db, _body) => surface13.commitBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface13.commitBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface13.commitBusinessTransaction>[1]) },
  { name: 'business-sync-transaction-delivery.ts:businessTransactionDeliveryStatus', call: (organization, _db, _body) => surface14.businessTransactionDeliveryStatus((session(organization)) as unknown as Parameters<typeof surface14.businessTransactionDeliveryStatus>[0], (undefined) as unknown as Parameters<typeof surface14.businessTransactionDeliveryStatus>[1]) },
  { name: 'business-sync-transaction-delivery.ts:preparedBusinessTransactionDelivery', call: (organization, _db, _body) => surface14.preparedBusinessTransactionDelivery((session(organization)) as unknown as Parameters<typeof surface14.preparedBusinessTransactionDelivery>[0], (undefined) as unknown as Parameters<typeof surface14.preparedBusinessTransactionDelivery>[1]) },
  { name: 'business-sync-transaction-delivery.ts:prepareBusinessTransactionDelivery', call: (organization, _db, _body) => surface14.prepareBusinessTransactionDelivery((session(organization)) as unknown as Parameters<typeof surface14.prepareBusinessTransactionDelivery>[0], (undefined) as unknown as Parameters<typeof surface14.prepareBusinessTransactionDelivery>[1]) },
  { name: 'business-sync-transaction-delivery.ts:businessTransactionDeliveryResource', call: (organization, _db, _body) => surface14.businessTransactionDeliveryResource((session(organization)) as unknown as Parameters<typeof surface14.businessTransactionDeliveryResource>[0], (undefined) as unknown as Parameters<typeof surface14.businessTransactionDeliveryResource>[1], (undefined) as unknown as Parameters<typeof surface14.businessTransactionDeliveryResource>[2], (undefined) as unknown as Parameters<typeof surface14.businessTransactionDeliveryResource>[3]) },
  { name: 'business-sync-transaction-files.ts:businessTransactionFileStatus', call: (organization, _db, _body) => surface15.businessTransactionFileStatus((session(organization)) as unknown as Parameters<typeof surface15.businessTransactionFileStatus>[0], (undefined) as unknown as Parameters<typeof surface15.businessTransactionFileStatus>[1], (undefined) as unknown as Parameters<typeof surface15.businessTransactionFileStatus>[2]) },
  { name: 'business-sync-transaction-files.ts:uploadBusinessTransactionFilePart', call: (organization, _db, body) => surface15.uploadBusinessTransactionFilePart((session(organization)) as unknown as Parameters<typeof surface15.uploadBusinessTransactionFilePart>[0], (undefined) as unknown as Parameters<typeof surface15.uploadBusinessTransactionFilePart>[1], (undefined) as unknown as Parameters<typeof surface15.uploadBusinessTransactionFilePart>[2], (0) as unknown as Parameters<typeof surface15.uploadBusinessTransactionFilePart>[3], (body) as unknown as Parameters<typeof surface15.uploadBusinessTransactionFilePart>[4]) },
  { name: 'business-sync-transaction-files.ts:verifyBusinessTransactionFile', call: (organization, _db, _body) => surface15.verifyBusinessTransactionFile((session(organization)) as unknown as Parameters<typeof surface15.verifyBusinessTransactionFile>[0], (undefined) as unknown as Parameters<typeof surface15.verifyBusinessTransactionFile>[1], (undefined) as unknown as Parameters<typeof surface15.verifyBusinessTransactionFile>[2]) },
  { name: 'business-sync-transaction-fingerprint.ts:completedTransactionFingerprint', call: (organization, _db, _body) => surface16.completedTransactionFingerprint((session(organization)) as unknown as Parameters<typeof surface16.completedTransactionFingerprint>[0], (undefined) as unknown as Parameters<typeof surface16.completedTransactionFingerprint>[1]) },
  { name: 'business-sync-transaction-fingerprint.ts:businessTransactionFingerprintStatus', call: (organization, _db, _body) => surface16.businessTransactionFingerprintStatus((session(organization)) as unknown as Parameters<typeof surface16.businessTransactionFingerprintStatus>[0], (undefined) as unknown as Parameters<typeof surface16.businessTransactionFingerprintStatus>[1]) },
  { name: 'business-sync-transaction-fingerprint.ts:fingerprintBusinessTransaction', call: (organization, _db, _body) => surface16.fingerprintBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface16.fingerprintBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface16.fingerprintBusinessTransaction>[1]) },
  { name: 'business-sync-transaction-review.ts:transactionReviewContext', call: (organization, _db, _body) => surface17.transactionReviewContext((session(organization)) as unknown as Parameters<typeof surface17.transactionReviewContext>[0], (undefined) as unknown as Parameters<typeof surface17.transactionReviewContext>[1]) },
  { name: 'business-sync-transaction-review.ts:businessTransactionReviewStatus', call: (organization, _db, _body) => surface17.businessTransactionReviewStatus((session(organization)) as unknown as Parameters<typeof surface17.businessTransactionReviewStatus>[0], (undefined) as unknown as Parameters<typeof surface17.businessTransactionReviewStatus>[1]) },
  { name: 'business-sync-transaction-review.ts:beginBusinessTransactionReview', call: (organization, _db, _body) => surface17.beginBusinessTransactionReview((session(organization)) as unknown as Parameters<typeof surface17.beginBusinessTransactionReview>[0], (undefined) as unknown as Parameters<typeof surface17.beginBusinessTransactionReview>[1]) },
  { name: 'business-sync-transaction-review.ts:reviewBusinessTransaction', call: (organization, _db, _body) => surface17.reviewBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface17.reviewBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface17.reviewBusinessTransaction>[1]) },
  { name: 'business-sync-transaction-transitions.ts:validateTransactionTransitions', call: (organization, _db, _body) => surface18.validateTransactionTransitions(({ manifest: { organization_id: organization } }) as unknown as Parameters<typeof surface18.validateTransactionTransitions>[0]) },
  { name: 'business-sync-transaction-validation.ts:validatedTransactionContext', call: (organization, _db, _body) => surface19.validatedTransactionContext((session(organization)) as unknown as Parameters<typeof surface19.validatedTransactionContext>[0], (undefined) as unknown as Parameters<typeof surface19.validatedTransactionContext>[1]) },
  { name: 'business-sync-transaction-validation.ts:businessTransactionValidationStatus', call: (organization, _db, _body) => surface19.businessTransactionValidationStatus((session(organization)) as unknown as Parameters<typeof surface19.businessTransactionValidationStatus>[0], (undefined) as unknown as Parameters<typeof surface19.businessTransactionValidationStatus>[1]) },
  { name: 'business-sync-transaction-validation.ts:validateBusinessTransaction', call: (organization, _db, _body) => surface19.validateBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface19.validateBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface19.validateBusinessTransaction>[1]) },
  { name: 'business-sync-transactions.ts:requireBusinessTransaction', call: (organization, _db, _body) => surface20.requireBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface20.requireBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface20.requireBusinessTransaction>[1]) },
  { name: 'business-sync-transactions.ts:beginBusinessTransaction', call: (organization, _db, _body) => surface20.beginBusinessTransaction((session(organization)) as unknown as Parameters<typeof surface20.beginBusinessTransaction>[0], (undefined) as unknown as Parameters<typeof surface20.beginBusinessTransaction>[1]) },
  { name: 'business-sync-transactions.ts:businessTransactionStatus', call: (organization, _db, _body) => surface20.businessTransactionStatus((session(organization)) as unknown as Parameters<typeof surface20.businessTransactionStatus>[0], (undefined) as unknown as Parameters<typeof surface20.businessTransactionStatus>[1]) },
  { name: 'business-sync-transactions.ts:uploadBusinessTransactionChunk', call: (organization, _db, body) => surface20.uploadBusinessTransactionChunk((session(organization)) as unknown as Parameters<typeof surface20.uploadBusinessTransactionChunk>[0], (undefined) as unknown as Parameters<typeof surface20.uploadBusinessTransactionChunk>[1], (0) as unknown as Parameters<typeof surface20.uploadBusinessTransactionChunk>[2], (body) as unknown as Parameters<typeof surface20.uploadBusinessTransactionChunk>[3]) },
  { name: 'business-sync-validation.ts:bootstrapValidationContext', call: (organization, _db, _body) => surface21.bootstrapValidationContext((session(organization)) as unknown as Parameters<typeof surface21.bootstrapValidationContext>[0], (undefined) as unknown as Parameters<typeof surface21.bootstrapValidationContext>[1]) },
  { name: 'business-sync-validation.ts:requireStructuralValidation', call: (organization, db, _body) => surface21.requireStructuralValidation(({ db, binding: ["transfer", organization] }) as unknown as Parameters<typeof surface21.requireStructuralValidation>[0]) },
  { name: 'business-sync-validation.ts:structuralValidationStatus', call: (organization, _db, _body) => surface21.structuralValidationStatus((session(organization)) as unknown as Parameters<typeof surface21.structuralValidationStatus>[0], (undefined) as unknown as Parameters<typeof surface21.structuralValidationStatus>[1]) },
  { name: 'business-sync-validation.ts:validateBootstrapStructure', call: (organization, _db, _body) => surface21.validateBootstrapStructure((session(organization)) as unknown as Parameters<typeof surface21.validateBootstrapStructure>[0], (undefined) as unknown as Parameters<typeof surface21.validateBootstrapStructure>[1]) },
  { name: 'company-copy.ts:companyCopy', call: (organization, _db, _body) => surface24.companyCopy((organization) as unknown as Parameters<typeof surface24.companyCopy>[0]) },
  { name: 'company-copy.ts:publishCompanyCopy', call: (organization, _db, _body) => surface24.publishCompanyCopy((session(organization)) as unknown as Parameters<typeof surface24.publishCompanyCopy>[0], (undefined) as unknown as Parameters<typeof surface24.publishCompanyCopy>[1], (undefined) as unknown as Parameters<typeof surface24.publishCompanyCopy>[2]) },
  { name: 'company-copy.ts:requireCompanyCopy', call: (organization, _db, _body) => surface24.requireCompanyCopy((organization) as unknown as Parameters<typeof surface24.requireCompanyCopy>[0], (undefined) as unknown as Parameters<typeof surface24.requireCompanyCopy>[1]) },
  { name: 'document-number-reservations.ts:reserveDocumentNumbers', call: (organization, _db, _body) => surface25.reserveDocumentNumbers((session(organization)) as unknown as Parameters<typeof surface25.reserveDocumentNumbers>[0], (undefined) as unknown as Parameters<typeof surface25.reserveDocumentNumbers>[1]) },
  { name: 'workspace-backup.ts:listBackups', call: (organization, _db, _body) => surface26.listBackups((organization) as unknown as Parameters<typeof surface26.listBackups>[0]) },
  { name: 'workspace-backup.ts:beginBackup', call: (organization, _db, _body) => surface26.beginBackup((session(organization)) as unknown as Parameters<typeof surface26.beginBackup>[0], (undefined) as unknown as Parameters<typeof surface26.beginBackup>[1], ({ organization_id: organization }) as unknown as Parameters<typeof surface26.beginBackup>[2]) },
  { name: 'workspace-backup.ts:uploadBackupChunk', call: (organization, _db, body) => surface26.uploadBackupChunk((body) as unknown as Parameters<typeof surface26.uploadBackupChunk>[0], (organization) as unknown as Parameters<typeof surface26.uploadBackupChunk>[1], (undefined) as unknown as Parameters<typeof surface26.uploadBackupChunk>[2], (0) as unknown as Parameters<typeof surface26.uploadBackupChunk>[3]) },
  { name: 'workspace-backup.ts:completeBackup', call: (organization, _db, _body) => surface26.completeBackup((organization) as unknown as Parameters<typeof surface26.completeBackup>[0], (undefined) as unknown as Parameters<typeof surface26.completeBackup>[1]) },
  { name: 'workspace-backup.ts:getBackup', call: (organization, _db, _body) => surface26.getBackup((organization) as unknown as Parameters<typeof surface26.getBackup>[0], (undefined) as unknown as Parameters<typeof surface26.getBackup>[1]) },
  { name: 'workspace-backup.ts:downloadBackupChunk', call: (organization, _db, _body) => surface26.downloadBackupChunk((organization) as unknown as Parameters<typeof surface26.downloadBackupChunk>[0], (undefined) as unknown as Parameters<typeof surface26.downloadBackupChunk>[1], (0) as unknown as Parameters<typeof surface26.downloadBackupChunk>[2]) },
  { name: 'workspace-backup.ts:deleteBackup', call: (organization, _db, _body) => surface26.deleteBackup((organization) as unknown as Parameters<typeof surface26.deleteBackup>[0], (undefined) as unknown as Parameters<typeof surface26.deleteBackup>[1]) },
];
function session(organizationId: string): DeviceSessionContext {
  return { organizationId, organizationName: 'Fixture', installationId: 'fixture-device', userId: 'fixture-owner', role: 'owner', sessionId: 'fixture-session', subscriptionId: 'fixture-subscription', entitlementValidUntil: 2000000000 };
}
let sql: DatabaseSync;
let database: D1Database;
let outage: Error | undefined;
const external = vi.fn();
const business = vi.fn();
const country = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); outage = undefined;
  sql = new DatabaseSync(':memory:');
  // Predicate fixture only. READY here does not bypass the actual 0085 trigger
  // or prove admission; real migration/workerd tests separately keep it closed.
  sql.exec('CREATE TABLE international_workspace_creation_intents(organization_id TEXT PRIMARY KEY,country_code TEXT,state TEXT)');
  database = { prepare: (query: string) => {
    if (!/^SELECT 1 AS blocked FROM international_workspace_creation_intents\s+WHERE organization_id=\? AND country_code='US' LIMIT 1$/.test(query.trim())) {
      business(query); throw new Error('unexpected legacy business SQL');
    }
    return { bind: (organization: string) => ({ first: async () => {
      country(organization, query); if (outage) throw outage;
      return sql.prepare(query).get(organization) ?? null;
    } }) };
  } } as unknown as D1Database;
  spies.database.mockReturnValue(database);
  spies.fileArchive.mockImplementation(() => { throw new Error('unexpected R2 access'); });
  spies.session.mockResolvedValue(session('fixture-us'));
  spies.rate.mockImplementation(() => { throw new Error('unexpected rate mutation'); });
  external.mockImplementation(() => { throw new Error('unexpected network/PG access'); });
  vi.stubGlobal('fetch', external);
});
afterEach(() => { sql.close(); vi.unstubAllGlobals(); });
function unreadBody() {
  const request = new Request('https://fixture.invalid/upload', { method: 'PUT', body: 'fixture' });
  const reads = [vi.spyOn(request, 'arrayBuffer'), vi.spyOn(request, 'json'), vi.spyOn(request, 'text')];
  return { request, reads };
}
function noLegacyEffects(reads: ReturnType<typeof unreadBody>['reads']) {
  expect(country).toHaveBeenCalledTimes(1);
  expect(business).not.toHaveBeenCalled();
  expect(spies.fileArchive).not.toHaveBeenCalled();
  expect(spies.rate).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
  reads.forEach(read => expect(read).not.toHaveBeenCalled());
}
for (const state of ['reserved', 'postgres_confirmed', 'ready']) describe('legacy library refusal for US predicate '+state, () => {
  it.each(entries)('$name refuses before legacy effects', async ({ call }) => {
    sql.prepare('INSERT INTO international_workspace_creation_intents VALUES(?, ?, ?)').run('fixture-us', 'US', state);
    const body = unreadBody();
    await expect(call('fixture-us', database, body.request)).rejects.toMatchObject({ status: 409, code: LEGACY_COUNTRY_GUARD_CODE });
    expect(country.mock.calls[0][0]).toBe('fixture-us');
    noLegacyEffects(body.reads);
  });
});
describe('failed attestation stays closed at every library boundary', () => {
  it.each(entries)('$name propagates unavailable D1 before legacy effects', async ({ call }) => {
    outage = new Error('fixture D1 unavailable'); const body = unreadBody();
    await expect(call('fixture-us', database, body.request)).rejects.toBe(outage);
    noLegacyEffects(body.reads);
  });
});
it('binds the raw storage identity and rejects a different organization namespace before R2', async () => {
  const blob = entries.find(entry => entry.name.endsWith(':storedBlobPart'))!;
  // Invoke the real export directly with a mismatched namespace.
  const storageModule = await import('./business-sync-blob-store');
  await expect(storageModule.storedBlobPart('fixture-ch', 'business-sync/fixture-us/file/0', 1)).rejects.toMatchObject({ status: 409 });
  expect(country.mock.calls[0][0]).toBe('fixture-ch'); expect(blob).toBeDefined();
  expect(spies.fileArchive).not.toHaveBeenCalled(); expect(business).not.toHaveBeenCalled();
});
it('checks the CH organization once when verifying multiple stored fragments', async () => {
  const { verifyStoredBlob, SYNC_BLOB_PART_BYTES } = await import('./business-sync-blob-store');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const bytes = new Uint8Array(SYNC_BLOB_PART_BYTES + 1).fill(65);
  const chunks = [bytes.slice(0, SYNC_BLOB_PART_BYTES), bytes.slice(SYNC_BLOB_PART_BYTES)];
  const key = (index: number) => `business-sync/fixture-ch/fixture/${index}`;
  const get = vi.fn(async (objectKey: string) => {
    const index = Number(objectKey.split('/').at(-1));
    const body = chunks[index];
    return { size: body.length, body: new Response(body).body };
  });
  spies.fileArchive.mockReturnValue({ get });
  await verifyStoredBlob('fixture-ch', chunks.map((part, index) => ({
    part_index: index, sha256: hash(part), size_bytes: part.length, object_key: key(index),
  })), bytes.length, hash(bytes), key);
  expect(country).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(2);
  expect(business).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
});
