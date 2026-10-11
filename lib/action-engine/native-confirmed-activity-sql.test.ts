/** Actual native activity-selection SQL against actual additive schemas on Node
 * SQLite. Synthetic admitted records are not native receipts. No Rust, local
 * authorization, semantic corroboration or authenticated A7 is executed here. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
const suite = root ? describe : describe.skip;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const org = 'synthetic-activity-company';
const actor = 'synthetic-activity-user';
const uuid = (id: number) =>
  '00000000-0000-4000-8000-' + id.toString().padStart(12, '0');
const installation = uuid(1);
const at = '2026-10-11T00:00:00Z';
const outbox = 'company_local_action_engine_quote_outbox';
const confirmations = 'company_local_action_engine_quote_confirmations';
const publications = 'company_local_action_engine_quote_publications';
let db: DatabaseSync;
let query: string;
let rust: string;
let schemas: string[];
let sequence: number;

function insert(table: string, row: Record<string, SQLInputValue>) {
  db.prepare(
    'INSERT INTO ' +
      table +
      ' (' +
      Object.keys(row).join(',') +
      ') VALUES(' +
      Object.keys(row)
        .map(() => '?')
        .join(',') +
      ')',
  ).run(...Object.values(row));
}

type Seed = {
  proposal: string;
  organization?: string;
  user?: string;
  installationId?: string;
  marker?: boolean;
  terminal?: boolean;
  confirmedAt?: string;
};
function seed({
  proposal,
  organization = org,
  user = actor,
  installationId = installation,
  marker = true,
  terminal = true,
  confirmedAt = at,
}: Seed) {
  const id = ++sequence * 10;
  const source = 'synthetic-source-' + id;
  const reservation = uuid(id + 1),
    customer = uuid(id + 2),
    quote = uuid(id + 3),
    snapshot = uuid(id + 4);
  const plan = JSON.stringify({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: organization,
    contextRevision: 'synthetic-context',
    sourceId: source,
    status: 'ready',
    reasons: [],
    requiresHumanValidation: true,
  });
  const fingerprint = hash(plan);
  const receipt = JSON.stringify({
    organizationId: organization,
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
    organizationId: organization,
    proposalId: proposal,
    reservationId: reservation,
    fingerprint,
    customerId: customer,
    quoteId: quote,
    receiptSha256: receiptSha,
  });
  const manifest = JSON.stringify({
    format: 'zentra-cloud-backup',
    version: 1,
    app_version: '1.90.15',
    sha256: 'c'.repeat(64),
    size_bytes: 100,
    chunks: [{ sha256: 'd'.repeat(64), size_bytes: 100 }],
  });
  db.prepare(
    'INSERT INTO action_engine_quote_receipts VALUES(' +
      Array(17).fill('?').join(',') +
      ')',
  ).run(
    organization,
    source,
    'prepare_quote_draft',
    proposal,
    reservation,
    fingerprint,
    hash(proposal),
    'b'.repeat(64),
    'synthetic-context',
    user,
    installationId,
    customer,
    quote,
    plan,
    receipt,
    receiptSha,
    at,
  );
  db.prepare(
    'INSERT INTO ' + outbox + " VALUES(?,?,?,?,?,?,'pending',0,?,?)",
  ).run(
    organization,
    proposal,
    quote,
    fingerprint,
    payload,
    hash(payload),
    at,
    at,
  );
  const facts = {
    organization_id: organization,
    source_id: source,
    action_kind: 'prepare_quote_draft',
    proposal_id: proposal,
    reservation_id: reservation,
    fingerprint,
    actor_user_id: user,
    installation_id: installationId,
    customer_id: customer,
    quote_id: quote,
    receipt_sha256: receiptSha,
    snapshot_id: snapshot,
  };
  insert(publications, {
    ...facts,
    base_revision: 4,
    archive_sha256: 'c'.repeat(64),
    manifest_sha256: hash(manifest),
    manifest_json: manifest,
    size_bytes: 100,
    local_clock: 12,
    created_at: at,
    published_revision: null,
    published_at: null,
  });
  if (marker) insert(confirmations, { ...facts, confirmed_at: confirmedAt });
  if (terminal)
    db.prepare(
      'UPDATE ' +
        outbox +
        " SET state='confirmed',updated_at=? WHERE organization_id=? AND proposal_id=?",
    ).run(confirmedAt, organization, proposal);
  return { ...facts, confirmed_at: confirmedAt };
}

function rows(
  limit = 20,
  after = '',
  organization = org,
  user = actor,
  installationId = installation,
) {
  // Includes the lookahead. Rust must corroborate every result before trimming.
  return db
    .prepare(query)
    .all(organization, user, installationId, after, limit + 1);
}
function proposals(result: ReturnType<typeof rows>) {
  return result.map((row) => row.proposal_id);
}

suite('actual native confirmed-activity SQL selection', () => {
  beforeAll(() => {
    rust = readFileSync(
      join(root!, 'desktop/src-tauri/src/action_engine_quote_publication.rs'),
      'utf8',
    );
    const matches = [
      ...rust.matchAll(
        /\bconst\s+ACTIVITY_SQL\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#\s*;/g,
      ),
    ];
    if (matches.length !== 1)
      throw new Error('Expected exactly one native ACTIVITY_SQL raw string');
    query = matches[0][1];
    schemas = [
      'action_engine_quote_schema.sql',
      'action_engine_quote_publication_schema.sql',
      'action_engine_quote_confirmation_schema.sql',
    ].map((name) =>
      readFileSync(join(root!, 'desktop/src-tauri/src', name), 'utf8'),
    );
  });
  beforeEach(() => {
    sequence = 0;
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const schema of schemas) db.exec(schema);
  });
  afterEach(() => db.close());

  it('extracts the actual marker columns and five bindings without changing schema62', () => {
    const columns = db
      .prepare(query)
      .columns()
      .map((column) => column.name);
    expect(columns).toEqual([
      'organization_id',
      'source_id',
      'action_kind',
      'proposal_id',
      'reservation_id',
      'fingerprint',
      'actor_user_id',
      'installation_id',
      'customer_id',
      'quote_id',
      'receipt_sha256',
      'snapshot_id',
      'confirmed_at',
    ]);
    expect(() =>
      db.prepare(query).all(org, actor, installation, '', 21, 'extra'),
    ).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(62);
    console.info(
      'Native confirmed activity SQL provenance (Node SQLite only):',
      JSON.stringify({
        nativeSourceRoot: root,
        rustSourceSha256: hash(rust),
        schemaSha256: schemas.map(hash),
        querySha256: hash(query),
        columns,
        bindings: [
          'organizationId',
          'actorUserId',
          'installationId',
          'afterProposalId or empty',
          'visiblePageSize + 1',
        ],
      }),
    );
  });
  it('returns no fact for no local confirmation or a transport/publication acknowledgement alone', () => {
    expect(rows()).toEqual([]);
    seed({
      proposal: 'not-canonically-confirmed',
      marker: false,
      terminal: false,
    });
    db.prepare(
      'UPDATE ' + publications + ' SET published_revision=5,published_at=?',
    ).run(at);
    expect(rows()).toEqual([]);
  });
  it('returns the immutable marker identity and actual quote id', () => {
    const fact = seed({ proposal: 'confirmed' });
    expect(rows()).toEqual([{ ...fact }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('isolates organizations with the same proposal id', () => {
    const own = seed({ proposal: 'same-id' });
    seed({ proposal: 'same-id', organization: 'other-company' });
    expect(rows()).toEqual([{ ...own }]);
  });
  it('excludes confirmations made under another actor or installation', () => {
    const own = seed({ proposal: 'visible' });
    seed({ proposal: 'other-actor', user: 'other-user' });
    seed({ proposal: 'other-device', installationId: uuid(99) });
    expect(rows()).toEqual([{ ...own }]);
  });
  it('uses bound selectors rather than interpolating actor, organization or cursor', () => {
    seed({ proposal: 'visible' });
    expect(rows(20, '', "' OR 1=1 --")).toEqual([]);
    expect(rows(20, '', org, "' OR 1=1 --")).toEqual([]);
    expect(rows(20, '', org, actor, "' OR 1=1 --")).toEqual([]);
    expect(proposals(rows(20, "' OR 1=1 --"))).toEqual(['visible']);
  });
  it('selects bounded binary proposal pages with an exclusive cursor and lookahead', () => {
    for (const proposal of ['b', 'a', 'A', '_', 'aa']) seed({ proposal });
    expect(proposals(rows(2))).toEqual(['A', '_', 'a']);
    expect(proposals(rows(2, '_'))).toEqual(['a', 'aa', 'b']);
    expect(proposals(rows(2, 'aa'))).toEqual(['b']);
    expect(rows(2, 'b')).toEqual([]);
  });
  it('does not treat confirmation time as a durable notification watermark', () => {
    seed({ proposal: 'b', confirmedAt: '2026-10-11T00:00:01Z' });
    seed({ proposal: 'a', confirmedAt: '2026-10-11T00:00:02Z' });
    expect(proposals(rows())).toEqual(['a', 'b']);
    expect(proposals(rows(20, 'a'))).toEqual(['b']);
    expect(db.prepare('SELECT count(*) n FROM ' + confirmations).get()?.n).toBe(
      2,
    );
  });
  it('remains a stable single record after repeated reads and rejects marker replay', () => {
    const fact = seed({ proposal: 'once' });
    const first = rows();
    expect(rows()).toEqual(first);
    expect(() => insert(confirmations, fact)).toThrow();
    expect(() =>
      db.prepare('UPDATE ' + confirmations + ' SET quote_id=?').run(uuid(999)),
    ).toThrow();
    expect(rows()).toEqual(first);
  });
  it('deliberately surfaces nonterminal corruption for Rust corroboration instead of hiding it', () => {
    seed({ proposal: 'partial-ack', terminal: false });
    expect(proposals(rows())).toEqual(['partial-ack']);
    expect(db.prepare('SELECT state FROM ' + outbox).get()?.state).toBe(
      'pending',
    );
    // Selection is not the public activity DTO; it cannot prove A10 by itself.
  });
  it('deliberately surfaces an orphaned receipt for Rust fail-closed corroboration', () => {
    seed({ proposal: 'missing-receipt' });
    // Simulate external corruption only in this disposable in-memory QA DB.
    // Production triggers and foreign keys remain unchanged.
    db.exec(
      'DROP TRIGGER action_engine_quote_receipt_delete; PRAGMA foreign_keys=OFF',
    );
    db.prepare('DELETE FROM action_engine_quote_receipts').run();
    db.exec('PRAGMA foreign_keys=ON');
    expect(proposals(rows())).toEqual(['missing-receipt']);
    expect(
      db.prepare('SELECT count(*) n FROM action_engine_quote_receipts').get()
        ?.n,
    ).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all().length).toBeGreaterThan(
      0,
    );
  });
});
