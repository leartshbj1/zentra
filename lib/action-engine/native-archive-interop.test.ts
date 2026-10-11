import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import type { SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readNativeArchiveEvidence } from '../../scripts/verify-action-native-interop.mjs';
import { backupManifest } from '../workspace-backup';
import { verifyCanonicalQuotePublication } from './canonical-quote';
import type {
  QuoteExecutionReservation,
  QuoteReservationBinding,
} from './ledger-types';
import type { PublicationAttempt } from './publication-ledger-types';
import {
  PUBLISHED_RESOURCES_MAX_PREFIX_BYTES,
  readPublishedResourcesPrefix,
} from './published-resources';
import {
  readCanonicalQuoteArchive,
  type CanonicalQuoteArchiveOrigin,
} from './quote-archive';
import compiledSqlite from './sqlite-wasm.test-runtime';
import type { DraftQuoteReceipt, StoredQuoteProposal } from './types';
import { captureProposal, captureQuotePlan } from './validation';

type NativeMetadata = {
  sourceCommit: string;
  appVersion: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  origin: CanonicalQuoteArchiveOrigin;
  canonicalPlanJson: string;
  sourceCanonicalJson: string;
  proposal: StoredQuoteProposal;
  reservation: QuoteExecutionReservation;
  binding: QuoteReservationBinding;
  publication: PublicationAttempt;
  receipt: DraftQuoteReceipt;
  transportManifestJson: string;
  planningTransportManifestJson: string;
  publicationContext: 'synthetic_committed_no_remote_authority';
};
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
// Default suites deliberately skip without downloaded native CI artifacts.
// This skip is NOT proof. The dedicated runner requires artifacts, exact source,
// native compile/execution evidence and a nonempty, entirely passed JSON report.
const suite = process.env.ZENTRA_ACTION_ARCHIVE_EVIDENCE
  ? describe
  : describe.skip;

suite(
  'real Rust collaboration ZIP → server codecs → actual SQLite WASM (synthetic authority only)',
  () => {
    let evidence: ReturnType<typeof readNativeArchiveEvidence>;
    let metadata: NativeMetadata;
    let sqliteBytes: Uint8Array<ArrayBuffer>;
    let SQL: SqlJsStatic;
    beforeAll(async () => {
      evidence = readNativeArchiveEvidence();
      metadata = evidence.metadata as NativeMetadata;
      ({ sqliteBytes } = await readCanonicalQuoteArchive(
        evidence.archive,
        metadata.origin,
      ));
      SQL = (await initSqlJs({
        instantiateWasm(
          imports: WebAssembly.Imports,
          success: (instance: WebAssembly.Instance) => void,
        ) {
          const instance = new WebAssembly.Instance(compiledSqlite, imports);
          success(instance);
          return instance.exports;
        },
        locateFile() {
          throw new Error(
            'Interop must use the installed real WASM, never a download.',
          );
        },
      })) as SqlJsStatic;
    });
    afterEach(() => {
      // Neither positive verification nor hostile-copy experiments may rewrite
      // the downloaded native ZIP or substitute a different archive in memory.
      if (!evidence || !metadata) return;
      expect(hash(evidence.archive)).toBe(metadata.archiveSha256);
      expect(hash(readFileSync(evidence.archivePath))).toBe(
        metadata.archiveSha256,
      );
    });
    const input = (bytes = sqliteBytes) => ({
      proposal: metadata.proposal,
      reservation: metadata.reservation,
      binding: metadata.binding,
      publication: metadata.publication,
      sqliteBytes: bytes,
    });

    it('correlates exact native source, canonical TS plan/source bytes and every real archive chunk', () => {
      expect(metadata.sourceCommit).toBe(evidence.expectedSource);
      expect(metadata.publicationContext).toBe(
        'synthetic_committed_no_remote_authority',
      );
      const plan = captureQuotePlan(JSON.parse(metadata.canonicalPlanJson));
      expect(JSON.stringify(plan)).toBe(metadata.canonicalPlanJson);
      expect(metadata.proposal.plan).toEqual(plan);
      expect(hash(metadata.canonicalPlanJson)).toBe(
        metadata.proposal.fingerprint,
      );
      expect(JSON.stringify(JSON.parse(metadata.sourceCanonicalJson))).toBe(
        metadata.sourceCanonicalJson,
      );
      expect(hash(metadata.sourceCanonicalJson)).toBe(
        metadata.binding.sourceCanonicalSha256,
      );
      const manifest = backupManifest(
        JSON.parse(metadata.transportManifestJson),
      );
      const planning = backupManifest(
        JSON.parse(metadata.planningTransportManifestJson),
      );
      expect(JSON.stringify(manifest)).toBe(metadata.transportManifestJson);
      expect(JSON.stringify(planning)).toBe(
        metadata.planningTransportManifestJson,
      );
      expect(hash(metadata.transportManifestJson)).toBe(
        metadata.publication.manifestSha256,
      );
      expect(hash(metadata.planningTransportManifestJson)).toBe(
        metadata.binding.planningPublication.manifestSha256,
      );
      expect(planning.sha256).toBe(
        metadata.binding.planningPublication.archiveSha256,
      );
      expect(manifest.app_version).toBe(metadata.appVersion);
      expect(manifest.sha256).toBe(metadata.archiveSha256);
      expect(manifest.size_bytes).toBe(metadata.archiveSizeBytes);
      expect(metadata.publication.archiveSha256).toBe(metadata.archiveSha256);
      expect(metadata.publication.sizeBytes).toBe(metadata.archiveSizeBytes);
      expect(metadata.publication.snapshotId).toBe(metadata.origin.snapshotId);
      expect(metadata.publication.baseRevision).toBe(
        metadata.origin.baseRevision,
      );
      let offset = 0;
      for (const chunk of manifest.chunks) {
        const bytes = evidence.archive.subarray(
          offset,
          offset + chunk.size_bytes,
        );
        expect(bytes.byteLength).toBe(chunk.size_bytes);
        expect(hash(bytes)).toBe(chunk.sha256);
        offset += chunk.size_bytes;
      }
      expect(offset).toBe(evidence.archive.byteLength);
    });

    it('reads native positional resources and the complete native SQLite without a fixture builder', async () => {
      const resources = await readPublishedResourcesPrefix(
        evidence.archive.subarray(0, PUBLISHED_RESOURCES_MAX_PREFIX_BYTES),
        {
          organizationId: metadata.origin.organizationId,
          snapshotId: metadata.origin.snapshotId,
          baseRevision: metadata.origin.baseRevision,
        },
      );
      expect(resources.resources.company.currency).toBe('CHF');
      expect(resources.resources.company.country).toBe('CH');
      expect(resources.resourcesHash).toBe(metadata.binding.resourcesSha256);
      expect(resources.customers.map((customer) => customer.id)).toContain(
        metadata.receipt.customerId,
      );
      expect(resources.articles.map((article) => article.id)).toContain(
        metadata.proposal.plan.lines[0].articleId,
      );
      const db = new SQL.Database(sqliteBytes);
      try {
        expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(62);
        for (const table of [
          'quotes',
          'quote_items',
          'action_engine_quote_receipts',
        ]) {
          expect(db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]).toBe(
            1,
          );
        }
        expect(
          db.exec(
            "SELECT COUNT(*) FROM audit_log WHERE action='create' AND entity_type='action_engine_quote'",
          )[0].values[0][0],
        ).toBe(1);
        // Native scrub keeps the private table schema and removes its intents.
        expect(
          db.exec(
            'SELECT COUNT(*) FROM company_local_action_engine_quote_outbox',
          )[0].values[0][0],
        ).toBe(0);
        const quote = db.exec('SELECT currency,number,status FROM quotes')[0]
          .values[0];
        expect(quote).toEqual(['CHF', null, 'brouillon']);
        expect(
          db.exec('SELECT typeof(quantity),quantity FROM quote_items')[0]
            .values[0],
        ).toEqual(['real', 1.25]);
      } finally {
        db.close();
      }
    });

    it('verifies actual Rust quote/line/receipt/audit facts and preserves the unnumbered human-reviewed CHF receipt', async () => {
      // Reservation/publication context is explicitly simulated metadata. No
      // hosted PG fact, authentication, entitlement or remote commit is claimed.
      const result = await verifyCanonicalQuotePublication(input());
      expect(result.receipt).toEqual(metadata.receipt);
      expect(result.receipt).toMatchObject({
        organizationId: metadata.origin.organizationId,
        proposalId: metadata.proposal.id,
        fingerprint: metadata.proposal.fingerprint,
        customerId: metadata.reservation.customerId,
        quoteId: metadata.reservation.quoteId,
        quoteNumber: null,
        status: 'draft',
        requiresHumanValidation: true,
      });
      expect(metadata.proposal.plan.currency).toBe('CHF');
      expect(result.reservationId).toBe(metadata.reservation.id);
      expect(result.archiveSha256).toBe(metadata.archiveSha256);
      expect(result.manifestSha256).toBe(metadata.publication.manifestSha256);
      expect(result.sqliteSha256).toBe(hash(sqliteBytes));
      expect(result.receiptSha256).toBe(hash(JSON.stringify(result.receipt)));
      expect(result.canonicalFactsSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps identifiers distinct and canonicalizes TS field order without changing the native fingerprint', () => {
      const ids = [
        metadata.proposal.id,
        metadata.reservation.id,
        metadata.reservation.quoteId,
        metadata.reservation.customerId,
        metadata.origin.snapshotId,
        metadata.binding.planningPublication.snapshotId,
        metadata.publication.id,
      ];
      expect(new Set(ids).size).toBe(ids.length);
      const reordered = Object.fromEntries(
        Object.entries(metadata.proposal.plan).reverse(),
      );
      const captured = captureProposal(
        { ...metadata.proposal, plan: reordered },
        {
          organizationId: metadata.origin.organizationId,
          userId: metadata.reservation.userId,
        },
      );
      expect(JSON.stringify(captured.plan)).toBe(metadata.canonicalPlanJson);
      expect(hash(JSON.stringify(captured.plan))).toBe(
        metadata.proposal.fingerprint,
      );
    });

    it.each(['organization', 'sha256'] as const)(
      'refuses a mismatched archive %s without relaxing its origin',
      async (field) => {
        const origin = { ...metadata.origin };
        if (field === 'organization') origin.organizationId = 'foreign-company';
        else origin.archiveSha256 = '0'.repeat(64);
        await expect(
          readCanonicalQuoteArchive(evidence.archive, origin),
        ).rejects.toMatchObject({ code: 'invalid_archive' });
      },
    );
    it('refuses corrupt native ZIP structure even if the claimed archive SHA is recomputed', async () => {
      const corrupt = new Uint8Array(evidence.archive);
      corrupt[0] ^= 255;
      await expect(
        readCanonicalQuoteArchive(corrupt, {
          ...metadata.origin,
          archiveSha256: hash(corrupt),
        }),
      ).rejects.toMatchObject({ code: 'invalid_archive' });
    });
    it('refuses a truncated native ZIP even if the claimed archive SHA is recomputed', async () => {
      const truncated = evidence.archive.slice(0, -12);
      await expect(
        readCanonicalQuoteArchive(truncated, {
          ...metadata.origin,
          archiveSha256: hash(truncated),
        }),
      ).rejects.toMatchObject({ code: 'invalid_archive' });
    });

    function hostileDerivedSqlite(statement: string): Uint8Array<ArrayBuffer> {
      // Only a disposable COPY of SQLite extracted from the real Rust ZIP is
      // mutated. These bytes are hostile reader inputs, never a Rust-produced
      // archive or a valid native transition. No ZIP/database is built from zero.
      const db = new SQL.Database(sqliteBytes);
      try {
        db.run('PRAGMA foreign_keys=OFF');
        const triggers = db.exec(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('quotes','quote_items','audit_log')",
        );
        for (const row of triggers[0]?.values ?? []) {
          const name = String(row[0]).replaceAll('"', '""');
          db.run(`DROP TRIGGER "${name}"`);
        }
        db.run(statement);
        return new Uint8Array(db.export());
      } finally {
        db.close();
      }
    }
    it.each([
      ['quote', 'DELETE FROM quotes'],
      ['lines', 'DELETE FROM quote_items'],
      [
        'audit',
        "DELETE FROM audit_log WHERE entity_type='action_engine_quote'",
      ],
    ])(
      'refuses absent %s in hostile SQLite derived from the real archive',
      async (_label, statement) => {
        const changed = hostileDerivedSqlite(statement);
        await expect(
          verifyCanonicalQuotePublication(input(changed)),
        ).rejects.toThrow();
      },
    );
    it('can corroborate the shared facts without any private outbox table', async () => {
      const withoutPrivateTable = hostileDerivedSqlite(
        'DROP TABLE company_local_action_engine_quote_outbox',
      );
      const result = await verifyCanonicalQuotePublication(
        input(withoutPrivateTable),
      );
      expect(result.receipt).toEqual(metadata.receipt);
    });
    it('refuses a coherently claimed fingerprint of noncanonical plan bytes', async () => {
      const fingerprint = hash(` ${metadata.canonicalPlanJson}`);
      await expect(
        verifyCanonicalQuotePublication({
          ...input(),
          proposal: { ...metadata.proposal, fingerprint },
          reservation: { ...metadata.reservation, fingerprint },
        }),
      ).rejects.toMatchObject({ code: 'invalid_publication' });
    });
    it.each(['proposal', 'reservation', 'quote'] as const)(
      'refuses substitution of the reserved %s identifier',
      async (field) => {
        const changed = 'f94f948b-7f03-4564-80a3-030b2d34a7c2';
        const value = input();
        if (field === 'proposal') {
          value.proposal = { ...metadata.proposal, id: changed };
          value.reservation = { ...metadata.reservation, proposalId: changed };
        } else if (field === 'reservation')
          value.reservation = { ...metadata.reservation, id: changed };
        else value.reservation = { ...metadata.reservation, quoteId: changed };
        await expect(verifyCanonicalQuotePublication(value)).rejects.toThrow();
      },
    );
  },
);
