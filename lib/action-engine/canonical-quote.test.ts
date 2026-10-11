import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const compiled = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  return new WebAssembly.Module(
    readFileSync(
      createRequire(import.meta.url).resolve(
        'sql.js/dist/sql-wasm-browser.wasm',
      ),
    ),
  );
});
vi.mock('sql.js/dist/sql-wasm-browser.wasm?module', () => ({
  default: compiled,
}));
import { makeCanonicalQuoteFixture } from './canonical-quote.fixture';
import {
  captureVerifiedCanonicalQuote,
  verifyCanonicalQuotePublication,
} from './canonical-quote';

const suite = process.env.ZENTRA_NATIVE_SOURCE_ROOT ? describe : describe.skip;
let fixture: ReturnType<typeof makeCanonicalQuoteFixture> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
suite('canonical schema62 quote confirmation from actual SQLite rows', () => {
  for (const kind of ['new', 'existing'] as const)
    it(`corroborates ${kind} customer, Unicode, fractions, deterministic IDs and cent rounding`, async () => {
      fixture = makeCanonicalQuoteFixture(kind);
      const result = await fixture.verify();
      expect(result.receipt).toEqual(fixture.receipt);
      expect(result.canonicalFactsSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(captureVerifiedCanonicalQuote(result)).toBe(result);
      expect(() => captureVerifiedCanonicalQuote({ ...result })).toThrow(
        'invalid_publication',
      );
      expect(() =>
        captureVerifiedCanonicalQuote(JSON.parse(JSON.stringify(result))),
      ).toThrow('invalid_publication');
      expect(JSON.stringify(result)).not.toContain(fixture.source.senderEmail);
      expect(JSON.stringify(result)).not.toContain(fixture.source.body);
    });
  const mutations = [
    "UPDATE quotes SET title='changed'",
    "UPDATE quotes SET status='emis',number='DV-1'",
    'DELETE FROM quotes',
    'DELETE FROM quote_items WHERE position=1',
    "UPDATE quote_items SET catalog_item_id='wrong' WHERE position=0",
    'UPDATE quote_items SET quantity=1.251 WHERE position=0',
    'UPDATE quote_items SET unit_price_cents=19902 WHERE position=0',
    'UPDATE quote_items SET vat_bp=0 WHERE position=0',
    'UPDATE quote_items SET line_total_cents=line_total_cents+1 WHERE position=0',
    "UPDATE clients SET name='different'",
    "UPDATE clients SET archived_at='2026-10-12'",
    "UPDATE clients SET email='other@example.test'",
    "UPDATE quotes SET notes='new note'",
    "UPDATE quotes SET updated_at='2026-10-12T12:00:00Z'",
    "UPDATE quote_items SET id='44444444-4444-4444-8444-444444444444' WHERE position=0",
    "INSERT INTO quote_items SELECT 'extra',quote_id,catalog_item_id,2,description,quantity,unit,unit_price_cents,discount_bp,vat_bp,line_net_cents,line_vat_cents,line_total_cents,created_at,updated_at FROM quote_items WHERE position=0",
    'UPDATE quotes SET total_cents=9007199254740993',
    "UPDATE audit_log SET payload_json='{}'",
    "UPDATE audit_log SET entry_hash='bad'",
    'DELETE FROM audit_log',
  ];
  for (const mutation of mutations)
    it(`refuses first proof after ${mutation}`, async () => {
      fixture = makeCanonicalQuoteFixture();
      fixture.sql.exec(mutation);
      await expect(fixture.verify()).rejects.toThrow();
      expect(
        fixture.sql
          .prepare('SELECT count(*) AS n FROM action_engine_quote_receipts')
          .get()?.n,
      ).toBe(1);
    });
  it('returns a bounded error for malformed audit JSON', async () => {
    fixture = makeCanonicalQuoteFixture();
    fixture.sql.exec("UPDATE audit_log SET payload_json='private malformed {'");
    await expect(fixture.verify()).rejects.toThrow('invalid_publication');
  });
  const digest = (raw: string) =>
    createHash('sha256').update(raw).digest('hex');
  function rewriteAudit(
    change: (payload: Record<string, unknown>) => void,
    actor = 'local_user',
  ) {
    const row = fixture!.sql.prepare('SELECT * FROM audit_log').get()!;
    const payload = JSON.parse(String(row.payload_json));
    change(payload);
    const payloadJson = JSON.stringify(payload);
    const entryHash = digest(
      `${String(row.previous_hash ?? '')}\n${String(row.id)}\n${String(row.occurred_at)}\n${actor}\ncreate\naction_engine_quote\n${String(row.entity_id)}\n${payloadJson}`,
    );
    fixture!.sql
      .prepare('UPDATE audit_log SET actor=?,payload_json=?,entry_hash=?')
      .run(actor, payloadJson, entryHash);
  }
  it('refuses a self-consistent audit under a different actor', async () => {
    fixture = makeCanonicalQuoteFixture();
    rewriteAudit(() => {}, 'other_actor');
    await expect(fixture.verify()).rejects.toThrow('invalid_publication');
  });
  for (const [table, field] of [
    ['clients', 'customer'],
    ['quotes', 'quote'],
  ] as const)
    it(`compares the exact ${field} identity despite a forged NOCASE column`, async () => {
      fixture = makeCanonicalQuoteFixture();
      const sql = fixture.sql;
      const original = String(
        sql.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table)
          ?.sql,
      );
      const replacement = original
        .replace(`TABLE ${table}`, `TABLE replacement_${table}`)
        .replace(/\bid TEXT\b/, 'id TEXT COLLATE NOCASE');
      sql.exec(replacement);
      sql.exec(
        `INSERT INTO replacement_${table} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE replacement_${table} RENAME TO ${table}; UPDATE ${table} SET id=upper(id)`,
      );
      rewriteAudit((payload) => {
        const creation = JSON.parse(String(payload.creationJson));
        creation[field].id = creation[field].id.toUpperCase();
        payload.creationJson = JSON.stringify(creation);
        payload.creationSha256 = digest(String(payload.creationJson));
      });
      await expect(fixture.verify()).rejects.toThrow('review_required');
    });
  for (const key of ['resourcesSha256', 'sourceCanonicalSha256'] as const)
    it(`refuses original ${key} mismatch`, async () => {
      fixture = makeCanonicalQuoteFixture();
      const input = fixture.input();
      await expect(
        verifyCanonicalQuotePublication({
          ...input,
          binding: { ...input.binding, [key]: '0'.repeat(64) },
        }),
      ).rejects.toThrow('invalid_publication');
    });
  it('does not accept publication of planning catalogue itself as creation proof', async () => {
    fixture = makeCanonicalQuoteFixture();
    const input = fixture.input();
    await expect(
      verifyCanonicalQuotePublication({
        ...input,
        publication: {
          ...input.publication,
          baseRevision: 3,
          result: {
            committed: true,
            revision: 4,
            snapshotId: input.publication.snapshotId,
          },
        },
      }),
    ).rejects.toThrow('invalid_publication');
  });
  it('refuses wrong tenant/device/member/publication state and closed input', async () => {
    fixture = makeCanonicalQuoteFixture();
    for (const patch of [
      { organizationId: 'other' },
      { installationId: '44444444-4444-4444-8444-444444444444' },
      { userId: 'other' },
      { state: 'pending', result: null, settledAt: null },
    ]) {
      const input = fixture.input();
      await expect(
        verifyCanonicalQuotePublication({
          ...input,
          publication: {
            ...input.publication,
            ...patch,
          } as typeof input.publication,
        }),
      ).rejects.toThrow();
    }
    const input = fixture.input();
    await expect(
      verifyCanonicalQuotePublication({
        ...input,
        extra: true,
      } as typeof input),
    ).rejects.toThrow('invalid_publication');
  });
  it('detaches input bytes and identities before the first digest await', async () => {
    fixture = makeCanonicalQuoteFixture();
    const input = fixture.input(),
      pending = verifyCanonicalQuotePublication(input);
    input.sqliteBytes.fill(0);
    (input.binding as { resourcesSha256: string }).resourcesSha256 = '0'.repeat(
      64,
    );
    const result = await pending;
    expect(result.receipt).toEqual(fixture.receipt);
  });
  it('does not invoke caller accessors or use shared/proxied bytes', async () => {
    fixture = makeCanonicalQuoteFixture();
    const input = fixture.input();
    let calls = 0;
    await expect(
      verifyCanonicalQuotePublication({
        ...input,
        get publication() {
          calls++;
          return input.publication;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    for (const bytes of [
      new Proxy(input.sqliteBytes, {}),
      new Uint8Array(new SharedArrayBuffer(input.sqliteBytes.length)),
    ])
      await expect(
        verifyCanonicalQuotePublication({ ...input, sqliteBytes: bytes }),
      ).rejects.toThrow();
  });
});
