/** Executes the actual private native housekeeping SQL on Node SQLite.
 * This is not compilation or execution of the Rust writer/transport. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
const suite = root ? describe : describe.skip;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const org = 'synthetic-company';
const proposal = 'synthetic-proposal';
const source = 'synthetic-source';
const reservation = 'efc98ca7-0913-4a53-85c6-d3d38737d9db';
const quote = '02c11008-6c2d-49b3-8d0f-50cfb6b218eb';
const customer = '960e994b-bbf2-4538-b58c-588112da7849';
const installation = '788659d9-f20e-4eae-9c0f-146057b0bfb0';
const snapshot = 'e93d5c2b-fb02-4ebd-81b2-4f1c11ceca0c';
const now = '2026-10-11T00:00:00Z';
const plan = JSON.stringify({
  schemaVersion: 1,
  engineVersion: 'action-engine-quote-v1',
  kind: 'prepare_quote_draft',
  organizationId: org,
  contextRevision: 'synthetic-context',
  sourceId: source,
  status: 'ready',
  reasons: [],
  requiresHumanValidation: true,
});
const fingerprint = hash(plan);
const receipt = JSON.stringify({
  organizationId: org,
  proposalId: proposal,
  fingerprint,
  customerId: customer,
  quoteId: quote,
  quoteNumber: null,
  status: 'draft',
  requiresHumanValidation: true,
});
const receiptSha = hash(receipt);
const payload = JSON.stringify({
  organizationId: org,
  proposalId: proposal,
  reservationId: reservation,
  fingerprint,
  customerId: customer,
  quoteId: quote,
  receiptSha256: receiptSha,
});
const manifest = {
  format: 'zentra-cloud-backup',
  version: 1,
  app_version: '1.90.15',
  sha256: 'c'.repeat(64),
  size_bytes: 100,
  chunks: [{ sha256: 'd'.repeat(64), size_bytes: 100 }],
};
const table = 'company_local_action_engine_quote_publications';
function candidate(overrides: Record<string, SQLInputValue> = {}) {
  const manifestJson = JSON.stringify(manifest);
  return {
    organization_id: org,
    source_id: source,
    action_kind: 'prepare_quote_draft',
    proposal_id: proposal,
    reservation_id: reservation,
    fingerprint,
    actor_user_id: 'synthetic-user',
    installation_id: installation,
    customer_id: customer,
    quote_id: quote,
    receipt_sha256: receiptSha,
    snapshot_id: snapshot,
    base_revision: 4,
    archive_sha256: manifest.sha256,
    manifest_sha256: hash(manifestJson),
    manifest_json: manifestJson,
    size_bytes: manifest.size_bytes,
    local_clock: 12,
    created_at: now,
    published_revision: null,
    published_at: null,
    ...overrides,
  } satisfies Record<string, SQLInputValue>;
}
function insertCandidate(
  overrides: Record<string, SQLInputValue> = {},
  verb = 'INSERT',
) {
  const row = candidate(overrides);
  db.prepare(
    `${verb} INTO ${table} (${Object.keys(row).join(',')}) VALUES(${Object.keys(
      row,
    )
      .map(() => '?')
      .join(',')})`,
  ).run(...Object.values(row));
}
function withManifest(value: unknown) {
  const text = JSON.stringify(value);
  return { manifest_json: text, manifest_sha256: hash(text) };
}
let db: DatabaseSync;
let migration: string;

function seed() {
  db.prepare(
    `INSERT INTO action_engine_quote_receipts VALUES(${Array(17).fill('?').join(',')})`,
  ).run(
    org,
    source,
    'prepare_quote_draft',
    proposal,
    reservation,
    fingerprint,
    'a'.repeat(64),
    'b'.repeat(64),
    'synthetic-context',
    'synthetic-user',
    installation,
    customer,
    quote,
    plan,
    receipt,
    receiptSha,
    now,
  );
  db.prepare(
    `INSERT INTO company_local_action_engine_quote_outbox VALUES(?,?,?,?,?,?,'pending',0,?,?)`,
  ).run(org, proposal, quote, fingerprint, payload, hash(payload), now, now);
}

suite('actual native private publication housekeeping SQL', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE existing_business(id TEXT PRIMARY KEY,value TEXT); INSERT INTO existing_business VALUES('keep','unchanged'); PRAGMA user_version=61;",
    );
    db.exec(
      readFileSync(
        join(root!, 'desktop/src-tauri/src/action_engine_quote_schema.sql'),
        'utf8',
      ),
    );
    migration = readFileSync(
      join(
        root!,
        'desktop/src-tauri/src/action_engine_quote_publication_schema.sql',
      ),
      'utf8',
    );
    db.exec(migration);
    seed();
  });
  afterEach(() => db.close());

  it('is additive and does not change the shared archive version', () => {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    expect(
      db.prepare("SELECT value FROM existing_business WHERE id='keep'").get()
        ?.value,
    ).toBe('unchanged');
    db.exec(migration);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM company_local_action_engine_quote_outbox',
        )
        .get()?.n,
    ).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('stores a pending transport candidate without confirming the business receipt', () => {
    insertCandidate();
    expect(
      db.prepare(`SELECT published_revision,published_at FROM ${table}`).get(),
    ).toMatchObject({ published_revision: null, published_at: null });
    db.prepare(`UPDATE ${table} SET published_revision=5,published_at=?`).run(
      now,
    );
    expect(
      db.prepare(`SELECT published_revision FROM ${table}`).get()
        ?.published_revision,
    ).toBe(5);
    expect(
      db
        .prepare('SELECT state FROM company_local_action_engine_quote_outbox')
        .get()?.state,
    ).toBe('pending');
    expect(
      db.prepare('SELECT receipt_json FROM action_engine_quote_receipts').get()
        ?.receipt_json,
    ).toBe(receipt);
  });
  it('retains distinct publication candidates for the same immutable creation', () => {
    insertCandidate();
    insertCandidate({
      snapshot_id: '3412bb18-3d98-4e83-b7ef-df8f3398e035',
      base_revision: 5,
      local_clock: 13,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(2);
  });
  for (const verb of [
    'INSERT',
    'INSERT OR REPLACE',
    'REPLACE',
    'INSERT OR IGNORE',
  ])
    it(`refuses identity replay even through ${verb}`, () => {
      insertCandidate();
      expect(() => insertCandidate({}, verb)).toThrow(
        'action_quote_publication_conflict',
      );
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(1);
    });
  for (const [field, value] of Object.entries({
    organization_id: 'other-company',
    source_id: 'other-source',
    action_kind: 'other-action',
    proposal_id: 'other-proposal',
    reservation_id: '2b3492b3-45f3-402f-b09c-64d88e151102',
    fingerprint: 'e'.repeat(64),
    actor_user_id: 'other-user',
    installation_id: 'fd99c03e-119e-42c8-8ff5-1db0c49f15e9',
    customer_id: 'other-customer',
    quote_id: 'fd99c03e-119e-42c8-8ff5-1db0c49f15e9',
    receipt_sha256: 'e'.repeat(64),
  }))
    it(`requires the exact originating receipt/outbox for ${field}`, () => {
      expect(() => insertCandidate({ [field]: value })).toThrow();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
    });
  for (const [field, value] of Object.entries({
    organization_id: 'other-company',
    source_id: 'other-source',
    action_kind: 'other-action',
    proposal_id: 'other-proposal',
    reservation_id: '2b3492b3-45f3-402f-b09c-64d88e151102',
    fingerprint: 'e'.repeat(64),
    actor_user_id: 'other-user',
    installation_id: 'fd99c03e-119e-42c8-8ff5-1db0c49f15e9',
    customer_id: 'other-customer',
    quote_id: 'fd99c03e-119e-42c8-8ff5-1db0c49f15e9',
    receipt_sha256: 'e'.repeat(64),
    snapshot_id: '3412bb18-3d98-4e83-b7ef-df8f3398e035',
    base_revision: 5,
    archive_sha256: 'e'.repeat(64),
    manifest_sha256: 'e'.repeat(64),
    manifest_json: '{}',
    size_bytes: 101,
    local_clock: 13,
    created_at: '2026-10-11T00:00:01Z',
  }))
    it(`keeps ${field} immutable even during publication acknowledgement`, () => {
      insertCandidate();
      expect(() =>
        db
          .prepare(
            `UPDATE ${table} SET ${field}=?,published_revision=base_revision+1,published_at=?`,
          )
          .run(value, now),
      ).toThrow('action_quote_publication_immutable');
      expect(
        db.prepare(`SELECT published_revision FROM ${table}`).get()
          ?.published_revision,
      ).toBeNull();
    });
  const invalidCandidates: Record<string, SQLInputValue>[] = [
    { snapshot_id: 'E93D5C2B-FB02-4EBD-81B2-4F1C11CECA0C' },
    { snapshot_id: 'e93d5c2b-fb02-5ebd-81b2-4f1c11ceca0c' },
    { snapshot_id: 'e93d5c2b-fb02-4ebd-71b2-4f1c11ceca0c' },
    { base_revision: -1 },
    { base_revision: 1.5 },
    { base_revision: 9007199254740991 },
    { local_clock: -1 },
    { local_clock: 1.5 },
    { size_bytes: 0 },
    { size_bytes: 536870913 },
    { archive_sha256: 'C'.repeat(64) },
    { manifest_sha256: 'z'.repeat(64) },
    { created_at: 'now' },
  ];
  for (const overrides of invalidCandidates)
    it(`rejects malformed transport identity/range ${JSON.stringify(overrides)}`, () => {
      expect(() => insertCandidate(overrides)).toThrow();
    });
  const badManifests: [string, unknown][] = [
    ['unknown field', { ...manifest, secret: 'never-copy' }],
    ['missing field', { ...manifest, app_version: undefined }],
    ['wrong format', { ...manifest, format: 'other' }],
    ['string version', { ...manifest, version: '1' }],
    ['wrong version', { ...manifest, version: 2 }],
    ['archive hash mismatch', { ...manifest, sha256: 'e'.repeat(64) }],
    ['size mismatch', { ...manifest, size_bytes: 101 }],
    ['empty chunks', { ...manifest, chunks: [] }],
    [
      'too many chunks',
      { ...manifest, chunks: Array(65).fill(manifest.chunks[0]) },
    ],
    [
      'chunk unknown field',
      { ...manifest, chunks: [{ ...manifest.chunks[0], extra: 1 }] },
    ],
    ['chunk missing hash', { ...manifest, chunks: [{ size_bytes: 100 }] }],
    [
      'chunk invalid hash',
      {
        ...manifest,
        chunks: [{ ...manifest.chunks[0], sha256: 'Z'.repeat(64) }],
      },
    ],
    [
      'chunk string size',
      { ...manifest, chunks: [{ ...manifest.chunks[0], size_bytes: '100' }] },
    ],
    [
      'chunk negative size',
      { ...manifest, chunks: [{ ...manifest.chunks[0], size_bytes: -100 }] },
    ],
    [
      'nonfinal short chunk',
      {
        ...manifest,
        chunks: [
          { ...manifest.chunks[0], size_bytes: 50 },
          { ...manifest.chunks[0], size_bytes: 50 },
        ],
      },
    ],
    ['primitive chunk', { ...manifest, chunks: [100] }],
  ];
  for (const [name, value] of badManifests)
    it(`rejects closed manifest violation: ${name}`, () => {
      expect(() => insertCandidate(withManifest(value))).toThrow();
    });
  it('rejects duplicate manifest and chunk keys', () => {
    for (const text of [
      JSON.stringify(manifest).replace('{', '{"version":1,'),
      JSON.stringify(manifest).replace(
        '"chunks":[{',
        '"chunks":[{"size_bytes":100,',
      ),
    ])
      expect(() =>
        insertCandidate({ manifest_json: text, manifest_sha256: hash(text) }),
      ).toThrow('action_quote_publication_invalid');
  });
  for (const revision of [4, 6, 5.5])
    it(`rejects acknowledgement with revision ${revision} instead of base+1`, () => {
      insertCandidate();
      expect(() =>
        db
          .prepare(`UPDATE ${table} SET published_revision=?,published_at=?`)
          .run(revision, now),
      ).toThrow();
    });
  it('never admits a newly inserted row as already published', () => {
    expect(() =>
      insertCandidate({ published_revision: 5, published_at: now }),
    ).toThrow('action_quote_publication_invalid');
  });
  it('makes an acknowledged revision terminal and permits only an identical replay', () => {
    insertCandidate();
    const statement = db.prepare(
      `UPDATE ${table} SET published_revision=?,published_at=?`,
    );
    statement.run(5, now);
    statement.run(5, now);
    for (const values of [
      [null, null],
      [6, now],
      [5, '2026-10-11T00:00:01Z'],
    ] as const)
      expect(() => statement.run(...values)).toThrow(
        'action_quote_publication_immutable',
      );
  });
  it('requires the local outbox and prevents purging its child in the wrong order', () => {
    insertCandidate();
    expect(() =>
      db.exec('DELETE FROM company_local_action_engine_quote_outbox'),
    ).toThrow('FOREIGN KEY');
    db.exec(
      `BEGIN IMMEDIATE; DELETE FROM ${table}; DELETE FROM company_local_action_engine_quote_outbox; COMMIT;`,
    );
    expect(() => insertCandidate()).toThrow('action_quote_publication_receipt');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(1);
  });
  it('can round-trip private acknowledged facts through pending then acknowledgement in one transaction', () => {
    insertCandidate();
    db.prepare(`UPDATE ${table} SET published_revision=5,published_at=?`).run(
      now,
    );
    const before = db.prepare(`SELECT * FROM ${table}`).get();
    db.exec(
      `BEGIN IMMEDIATE; DELETE FROM ${table}; DELETE FROM company_local_action_engine_quote_outbox;`,
    );
    db.prepare(
      `INSERT INTO company_local_action_engine_quote_outbox VALUES(?,?,?,?,?,?,'pending',0,?,?)`,
    ).run(org, proposal, quote, fingerprint, payload, hash(payload), now, now);
    insertCandidate();
    db.prepare(`UPDATE ${table} SET published_revision=5,published_at=?`).run(
      now,
    );
    db.exec('COMMIT');
    expect(db.prepare(`SELECT * FROM ${table}`).get()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rolls back a partial multi-candidate binding when the second candidate is invalid', () => {
    db.exec('BEGIN IMMEDIATE');
    insertCandidate();
    expect(() =>
      insertCandidate({
        snapshot_id: '3412bb18-3d98-4e83-b7ef-df8f3398e035',
        receipt_sha256: 'e'.repeat(64),
      }),
    ).toThrow();
    db.exec('ROLLBACK');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM company_local_action_engine_quote_outbox',
        )
        .get()?.n,
    ).toBe(1);
  });
});
