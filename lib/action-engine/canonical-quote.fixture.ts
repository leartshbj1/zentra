/** Synthetic cross-language fixture: real native SQL schema, executed by Node
 * SQLite. This is not a native writer execution or a production data sample. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureQuotePlan } from './validation';
import { verifyCanonicalQuotePublication } from './canonical-quote';
import type {
  QuoteExecutionReservation,
  QuoteReservationBinding,
} from './ledger-types';
import type { PublicationAttempt } from './publication-ledger-types';
import type { DraftQuoteReceipt, StoredQuoteProposal } from './types';

const hash = (raw: string | Uint8Array) =>
  createHash('sha256').update(raw).digest('hex');
export function makeCanonicalQuoteFixture(kind: 'new' | 'existing' = 'new') {
  const root = process.env.ZENTRA_NATIVE_SOURCE_ROOT;
  if (!root)
    throw new Error(
      'ZENTRA_NATIVE_SOURCE_ROOT required; native SQL is not silently substituted.',
    );
  const directory = mkdtempSync(join(tmpdir(), 'zentra-canonical-')),
    path = join(directory, 'database.sqlite3');
  const sql = new DatabaseSync(path);
  const schema = readFileSync(
    join(root, 'desktop/src-tauri/src/schema.rs'),
    'utf8',
  );
  for (const table of [
    'clients',
    'projects',
    'catalog_items',
    'quotes',
    'quote_items',
    'audit_log',
    'settings',
  ]) {
    const statement = schema.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`),
    )?.[0];
    if (!statement) throw new Error(`Actual native table missing: ${table}`);
    sql.exec(statement);
  }
  sql.exec(
    readFileSync(
      join(root, 'desktop/src-tauri/src/action_engine_quote_schema.sql'),
      'utf8',
    ),
  );
  const organizationId = 'synthetic-company',
    userId = 'synthetic-user',
    customerId = '960e994b-bbf2-4538-b58c-588112da7849';
  const source = {
    id: 'synthetic-source',
    revision: 'synthetic-source-v1',
    organizationId,
    senderEmail: 'synthetic@example.test',
    senderName: 'Atelier Été 👩‍🔧',
    subject: 'Installation',
    body: 'Installer 1.25 radiateurs puis 3 supports',
  };
  const plan = captureQuotePlan({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId,
    contextRevision: 'synthetic-context',
    sourceId: source.id,
    sourceRevision: source.revision,
    status: 'ready',
    reasons: [],
    customer:
      kind === 'new'
        ? { kind: 'new', name: source.senderName, email: source.senderEmail }
        : {
            kind: 'existing',
            id: customerId,
            revision: 'customer-v1',
            name: source.senderName,
          },
    title: 'Installation — étage 2',
    currency: 'CHF',
    lines: [
      {
        articleId: 'radiator-a',
        articleRevision: 'article-v1',
        description: 'Radiateur — Été',
        unit: 'pièce',
        quantityMilli: 1250,
        unitPriceCents: 19901,
        taxRateBp: 810,
        netCents: 24876,
        evidence: 'Installer 1.25 radiateurs',
      },
      {
        articleId: 'support-a',
        articleRevision: 'article-v1',
        description: 'Support',
        unit: 'pièce',
        quantityMilli: 3000,
        unitPriceCents: 100,
        taxRateBp: 810,
        netCents: 300,
        evidence: '3 supports',
      },
    ],
    netCents: 25176,
    confidence: 0.99,
    requiresHumanValidation: true,
  });
  const proposal: StoredQuoteProposal = {
    id: 'synthetic-proposal',
    organizationId,
    fingerprint: hash(JSON.stringify(plan)),
    plan,
  };
  const r: QuoteExecutionReservation = {
    id: 'efc98ca7-0913-4a53-85c6-d3d38737d9db',
    organizationId,
    proposalId: proposal.id,
    fingerprint: proposal.fingerprint,
    userId,
    installationId: '788659d9-f20e-4eae-9c0f-146057b0bfb0',
    customerId,
    quoteId: '02c11008-6c2d-49b3-8d0f-50cfb6b218eb',
    createdAt: 1791720000,
    receipt: null,
  };
  const binding: QuoteReservationBinding = {
    resourcesSha256: 'b'.repeat(64),
    sourceCanonicalSha256: hash(JSON.stringify(source)),
    planningPublication: {
      organizationId,
      snapshotId: '68c9d889-ecfb-4fcb-a4aa-3bed171a68aa',
      baseRevision: 3,
      revision: 4,
      archiveSha256: 'c'.repeat(64),
      manifestSha256: 'd'.repeat(64),
    },
  };
  const publication: PublicationAttempt = {
    id: '5ab9766b-aa17-494e-91e3-7e11267cd920',
    organizationId,
    snapshotId: 'b80324c2-dffe-475a-8a85-1c10b65a2cf5',
    installationId: r.installationId,
    userId,
    baseRevision: 4,
    archiveSha256: 'e'.repeat(64),
    manifestSha256: 'f'.repeat(64),
    sizeBytes: 20000,
    state: 'committed',
    result: {
      committed: true,
      revision: 5,
      snapshotId: 'b80324c2-dffe-475a-8a85-1c10b65a2cf5',
    },
    createdAt: r.createdAt + 5,
    settledAt: r.createdAt + 10,
  };
  const createdAt = '2026-10-11T12:00:01Z';
  const customer = {
    id: customerId,
    name: source.senderName,
    email: source.senderEmail,
    country: 'CH',
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const lines = plan.lines.map((p, position) => {
    const bytes = Buffer.from(
      hash(
        `action-engine-quote-line-v1\n${proposal.id}\n${proposal.fingerprint}\n${r.quoteId}\n${position}`,
      ).slice(0, 32),
      'hex',
    );
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const h = bytes.toString('hex'),
      id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const vat = Number(
      (BigInt(p.netCents) * BigInt(p.taxRateBp) + BigInt(5000)) / BigInt(10000),
    );
    return {
      id,
      quoteId: r.quoteId,
      catalogItemId: p.articleId,
      position,
      description: p.description,
      quantityMilli: p.quantityMilli,
      unit: p.unit,
      unitPriceCents: p.unitPriceCents,
      discountBp: 0,
      vatBp: p.taxRateBp,
      lineNetCents: p.netCents,
      lineVatCents: vat,
      lineTotalCents: p.netCents + vat,
      createdAt,
      updatedAt: createdAt,
    };
  });
  const vat = lines.reduce((n, x) => n + x.lineVatCents, 0);
  const quote = {
    id: r.quoteId,
    clientId: customerId,
    projectId: null,
    number: null,
    title: plan.title,
    status: 'brouillon',
    issueDate: '2026-10-11',
    validUntil: '2026-11-10',
    currency: 'CHF',
    subtotalCents: plan.netCents,
    discountCents: 0,
    vatCents: vat,
    totalCents: plan.netCents + vat,
    notes: null,
    terms: null,
    snapshotJson: null,
    createdAt,
    updatedAt: createdAt,
  };
  sql
    .prepare(
      'INSERT INTO clients(id,name,email,country,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      customerId,
      customer.name,
      customer.email,
      customer.country,
      createdAt,
      createdAt,
    );
  for (const line of plan.lines)
    sql
      .prepare(
        'INSERT INTO catalog_items(id,kind,name,created_at,updated_at) VALUES(?,?,?,?,?)',
      )
      .run(line.articleId, 'product', line.description, createdAt, createdAt);
  sql
    .prepare('INSERT INTO quotes VALUES(' + Array(18).fill('?').join(',') + ')')
    .run(...Object.values(quote));
  for (const line of lines) {
    const values = Object.values(line);
    values[5] = line.quantityMilli / 1000;
    sql
      .prepare(
        'INSERT INTO quote_items VALUES(' + Array(15).fill('?').join(',') + ')',
      )
      .run(...values);
  }
  const receipt: DraftQuoteReceipt = {
    organizationId,
    proposalId: r.proposalId,
    fingerprint: r.fingerprint,
    customerId,
    quoteId: r.quoteId,
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  };
  const receiptJson = JSON.stringify(receipt),
    receiptSha256 = hash(receiptJson);
  const requestSha256 = hash(
    JSON.stringify([
      1,
      organizationId,
      userId,
      r.installationId,
      r.proposalId,
      r.id,
      r.fingerprint,
      binding.sourceCanonicalSha256,
      binding.resourcesSha256,
      plan.contextRevision,
      customerId,
      r.quoteId,
    ]),
  );
  sql
    .prepare(
      'INSERT INTO action_engine_quote_receipts VALUES(' +
        Array(17).fill('?').join(',') +
        ')',
    )
    .run(
      organizationId,
      source.id,
      plan.kind,
      proposal.id,
      r.id,
      r.fingerprint,
      requestSha256,
      binding.resourcesSha256,
      plan.contextRevision,
      userId,
      r.installationId,
      customerId,
      r.quoteId,
      JSON.stringify(plan),
      receiptJson,
      receiptSha256,
      createdAt,
    );
  const creationJson = JSON.stringify({
    version: 1,
    sourceCanonicalSha256: binding.sourceCanonicalSha256,
    customerCreated: kind === 'new',
    customer,
    quote,
    lines,
  });
  const payloadJson = JSON.stringify({
    creationJson,
    creationSha256: hash(creationJson),
    netCents: plan.netCents,
    quantityMilli: plan.lines.map((x) => x.quantityMilli),
    receipt,
    requestSha256,
    reservationId: r.id,
    totalCents: quote.totalCents,
    vatCents: vat,
  });
  const auditId = 'a7897a54-a45a-4a94-b0e9-ab28a52cfb9b',
    occurredAt = '2026-10-11T12:00:02Z';
  sql
    .prepare('INSERT INTO audit_log VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      auditId,
      occurredAt,
      'local_user',
      'create',
      'action_engine_quote',
      r.quoteId,
      payloadJson,
      null,
      hash(
        `\n${auditId}\n${occurredAt}\nlocal_user\ncreate\naction_engine_quote\n${r.quoteId}\n${payloadJson}`,
      ),
    );
  // Corruption tests deliberately model a hostile archive, not a permitted
  // native edit. Disabling fixture FK checks does not change production code.
  sql.exec('PRAGMA foreign_keys=OFF');
  const bytes = () => new Uint8Array(readFileSync(path));
  const input = () => ({
    proposal,
    reservation: r,
    binding,
    publication,
    sqliteBytes: bytes(),
  });
  return {
    sql,
    proposal,
    reservation: r,
    binding,
    publication,
    receipt,
    source,
    lines,
    quote,
    customer,
    input,
    bytes,
    verify: () => verifyCanonicalQuotePublication(input()),
    close() {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
