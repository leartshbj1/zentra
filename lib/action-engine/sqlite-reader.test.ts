import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Node permits compilation in tests. This mock supplies the real pinned WASM
// bytes as a compiled module; it does not replace SQLite, SQL or database rows.
// The separate workerd spike proves the production static-module path.
const compiled = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return new WebAssembly.Module(
    readFileSync(require.resolve('sql.js/dist/sql-wasm-browser.wasm')),
  );
});
vi.mock('sql.js/dist/sql-wasm-browser.wasm?module', () => ({
  default: compiled,
}));

import {
  READONLY_SQLITE_MAX_BYTES,
  withReadonlySqlite,
  type ReadonlySqlite,
  type ReadonlySqliteValue,
} from './sqlite-reader';

const directories: string[] = [];
function fixture(configure?: (db: DatabaseSync) => void): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'zentra-canonical-reader-'));
  directories.push(directory);
  const path = join(directory, 'database.sqlite3');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'PRAGMA user_version=62; CREATE TABLE clients(id TEXT PRIMARY KEY,name TEXT,email TEXT,amount INTEGER,quantity REAL);',
    );
    db.prepare('INSERT INTO clients VALUES(?,?,?,?,?)').run(
      'client-1',
      'Zürich · café · 東京 · 🧾',
      'owner@example.test',
      55000,
      0.125,
    );
    configure?.(db);
  } finally {
    db.close();
  }
  return new Uint8Array(readFileSync(path));
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private canonical SQLite reader', () => {
  it('reads a real Node SQLite schema62 file with the actual WASM engine', async () => {
    const result = await withReadonlySqlite(fixture(), (db) => ({
      columns: db.columns('clients'),
      rows: db.query(
        'SELECT id,name,email,amount,quantity FROM clients WHERE id=? LIMIT 2',
        ['client-1'],
        2,
      ),
    }));
    expect(result.columns).toEqual([
      'id',
      'name',
      'email',
      'amount',
      'quantity',
    ]);
    expect(result.rows).toEqual([
      {
        id: 'client-1',
        name: 'Zürich · café · 東京 · 🧾',
        email: 'owner@example.test',
        amount: 55000,
        quantity: 0.125,
      },
    ]);
    expect(Object.isFrozen(result.columns)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
    expect(Object.isFrozen(result.rows[0])).toBe(true);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(null);
  });

  it('captures input bytes before initialization awaits and ignores an overridden iterator', async () => {
    const bytes = fixture();
    Object.defineProperty(bytes, Symbol.iterator, {
      get: () => {
        throw new Error('iterator must not run');
      },
    });
    const pending = withReadonlySqlite(bytes, (db) =>
      db.query('SELECT name FROM clients WHERE id=?', ['client-1'], 1),
    );
    bytes.fill(0);
    expect((await pending)[0].name).toBe('Zürich · café · 東京 · 🧾');
  });

  it.each([61, 63])(
    'refuses database schema%s rather than guessing compatibility',
    async (version) => {
      await expect(
        withReadonlySqlite(
          fixture((db) => db.exec(`PRAGMA user_version=${version}`)),
          () => null,
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    },
  );

  it('rejects malformed, oversized, detached, shared and proxied byte sources', async () => {
    const valid = fixture();
    const badHeader = valid.slice();
    badHeader[0] = 0;
    const corrupt = valid.slice(0, 100);
    const detached = fixture();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const inputs = [
      badHeader,
      corrupt,
      new Uint8Array(READONLY_SQLITE_MAX_BYTES + 1),
      detached,
      new Uint8Array(new SharedArrayBuffer(1024)),
      new Proxy(valid, {}),
    ];
    for (const bytes of inputs)
      await expect(withReadonlySqlite(bytes, () => null)).rejects.toMatchObject(
        { code: 'invalid_sqlite' },
      );
  });

  it.each([
    'UPDATE clients SET name=1',
    'SELECT id FROM clients; DELETE FROM clients',
    'SELECT id FROM clients -- comment',
    'SELECT load_extension FROM clients',
    'SELECT randomblob(1000000) FROM clients',
    'WITH c AS (SELECT id FROM clients) SELECT id FROM c',
    'SELECT id FROM clients UNION SELECT id FROM clients',
    'SELECT id FROM sqlite_schema',
    'SELECT id FROM other_company',
  ])(
    'does not expose a generic SQL writer/function engine: %s',
    async (sql) => {
      await expect(
        withReadonlySqlite(fixture(), (db) => db.query(sql, [], 1)),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    },
  );

  it('admits the fixed audit predicate, binary order and multiple exact bindings used by the verifier', async () => {
    const bytes = fixture((db) => {
      db.exec(
        'CREATE TABLE audit_log(id TEXT,entity_type TEXT,entity_id TEXT,action TEXT);',
      );
      db.prepare('INSERT INTO audit_log VALUES(?,?,?,?)').run(
        'audit-1',
        'action_engine_quote',
        'quote-1',
        'create',
      );
    });
    expect(
      await withReadonlySqlite(bytes, (db) =>
        db.query(
          "SELECT id,action FROM audit_log WHERE entity_type='action_engine_quote' AND entity_id=? AND action='create' ORDER BY id COLLATE BINARY LIMIT 2",
          ['quote-1'],
          2,
        ),
      ),
    ).toEqual([{ id: 'audit-1', action: 'create' }]);
  });

  it('refuses a view in a proof table but ignores unrelated native views', async () => {
    const good = fixture((db) =>
      db.exec('CREATE VIEW vat_source_fiscal_dates AS SELECT id FROM clients;'),
    );
    expect(
      (
        await withReadonlySqlite(good, (db) =>
          db.query('SELECT id FROM clients', [], 1),
        )
      ).length,
    ).toBe(1);
    const view = fixture((db) =>
      db.exec(
        'ALTER TABLE clients RENAME TO actual_clients; CREATE VIEW clients AS SELECT * FROM actual_clients;',
      ),
    );
    await expect(
      withReadonlySqlite(view, (db) =>
        db.query('SELECT id FROM clients', [], 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('refuses virtual and generated proof tables before reading their values', async () => {
    const virtual = fixture((db) =>
      db.exec(
        'DROP TABLE clients; CREATE VIRTUAL TABLE clients USING fts5(name);',
      ),
    );
    const generated = fixture((db) =>
      db.exec(
        "DROP TABLE clients; CREATE TABLE clients(id TEXT,name TEXT GENERATED ALWAYS AS ('invented') VIRTUAL); INSERT INTO clients(id) VALUES('client-1');",
      ),
    );
    for (const bytes of [virtual, generated])
      await expect(
        withReadonlySqlite(bytes, (db) =>
          db.query('SELECT name FROM clients', [], 1),
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('does not execute a malicious stored expression index while reading ordinary rows', async () => {
    const bytes = fixture((db) => {
      db.function(
        'untrusted_function',
        { deterministic: true },
        (_value) => 'executed',
      );
      db.exec(
        'CREATE INDEX malicious_expression ON clients(untrusted_function(name));',
      );
    });
    // trusted_schema=OFF rejects this schema outright, or NOT INDEXED excludes
    // the expression. Either path must never return the expression as evidence.
    const result = await withReadonlySqlite(bytes, (db) =>
      db.query('SELECT id FROM clients', [], 1),
    ).catch((error) => error);
    if (result instanceof Error)
      expect(result).toMatchObject({ code: 'invalid_sqlite' });
    else expect(result).toEqual([{ id: 'client-1' }]);
  });

  it.each([BigInt('9007199254740993'), BigInt('-9007199254740993')])(
    'refuses unsafe exact SQLite INTEGER %s without rounded evidence',
    async (amount) => {
      const bytes = fixture((db) =>
        db.prepare('UPDATE clients SET amount=?').run(amount),
      );
      await expect(
        withReadonlySqlite(bytes, (db) =>
          db.query('SELECT amount FROM clients', [], 1),
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    },
  );

  it('preserves safe boundary integers, REAL quantities, text and null without coercion', async () => {
    const bytes = fixture((db) =>
      db
        .prepare('UPDATE clients SET amount=?,email=NULL,name=?')
        .run(Number.MAX_SAFE_INTEGER, '001.20'),
    );
    expect(
      await withReadonlySqlite(bytes, (db) =>
        db.query('SELECT amount,quantity,name,email FROM clients', [], 1),
      ),
    ).toEqual([
      {
        amount: Number.MAX_SAFE_INTEGER,
        quantity: 0.125,
        name: '001.20',
        email: null,
      },
    ]);
  });

  it.each(['REAL', 'TEXT'])(
    'refuses cents and basis points stored as %s despite forged column declarations',
    async (storage) => {
      const bytes = fixture((db) => {
        db.exec(
          `ALTER TABLE clients ADD COLUMN unit_price_cents ${storage}; ALTER TABLE clients ADD COLUMN tax_rate_bp ${storage};`,
        );
        db.prepare('UPDATE clients SET unit_price_cents=?,tax_rate_bp=?').run(
          storage === 'TEXT' ? '55000' : 55000,
          storage === 'TEXT' ? '810' : 810,
        );
      });
      await expect(
        withReadonlySqlite(bytes, (db) =>
          db.query('SELECT unit_price_cents,tax_rate_bp FROM clients', [], 1),
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    },
  );

  it('corroborates an INTEGER declared column against actual REAL storage without rewriting the schema', async () => {
    // SQLite INTEGER affinity admits a fractional REAL value. Native i64
    // conversion refuses it, so the reader must enforce storage class itself.
    const bytes = fixture((db) =>
      db.prepare('UPDATE clients SET amount=?').run(55000.5),
    );
    await expect(
      withReadonlySqlite(bytes, (db) =>
        db.query('SELECT amount FROM clients', [], 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('rejects malformed SQLite TEXT bytes instead of accepting the decoder replacement character', async () => {
    const bytes = fixture((db) =>
      db.exec("UPDATE clients SET name=CAST(X'80' AS TEXT)"),
    );
    await expect(
      withReadonlySqlite(bytes, (db) =>
        db.query('SELECT name FROM clients', [], 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    // The legitimate replacement character remains a valid distinct UTF-8 value.
    const valid = fixture((db) =>
      db.prepare('UPDATE clients SET name=?').run('\uFFFD'),
    );
    expect(
      await withReadonlySqlite(valid, (db) =>
        db.query('SELECT name FROM clients', [], 1),
      ),
    ).toEqual([{ name: '\uFFFD' }]);
  });

  it('refuses BLOB evidence, overlong text and SQL duplicate-column aliases', async () => {
    const blob = fixture((db) =>
      db.prepare('UPDATE clients SET name=?').run(new Uint8Array([1, 2])),
    );
    const longText = fixture((db) =>
      db.prepare('UPDATE clients SET name=?').run('x'.repeat(65537)),
    );
    for (const bytes of [blob, longText])
      await expect(
        withReadonlySqlite(bytes, (db) =>
          db.query('SELECT name FROM clients', [], 1),
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    await expect(
      withReadonlySqlite(fixture(), (db) =>
        db.query('SELECT id,id FROM clients', [], 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('bounds results, statements and binding shape without invoking accessors', async () => {
    const bytes = fixture((db) =>
      db
        .prepare('INSERT INTO clients VALUES(?,?,?,?,?)')
        .run('client-2', 'Second', null, 1, 1),
    );
    await expect(
      withReadonlySqlite(bytes, (db) =>
        db.query('SELECT id FROM clients', [], 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    await expect(
      withReadonlySqlite(bytes, (db) =>
        db.query('SELECT id FROM clients', [], 65),
      ),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    let getterCalls = 0;
    const accessor: ReadonlySqliteValue[] = [];
    accessor.length = 1;
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        getterCalls++;
        return 'client-1';
      },
    });
    const sparse: ReadonlySqliteValue[] = [];
    sparse.length = 1;
    const extra = Object.assign(['client-1'], { hidden: true });
    for (const bindings of [accessor, sparse, extra])
      await expect(
        withReadonlySqlite(bytes, (db) =>
          db.query('SELECT id FROM clients WHERE id=?', bindings, 1),
        ),
      ).rejects.toMatchObject({ code: 'invalid_sqlite' });
    expect(getterCalls).toBe(0);
    await expect(
      withReadonlySqlite(bytes, (db) => {
        for (let i = 0; i < 33; i++)
          db.query('SELECT id FROM clients WHERE id=?', ['client-1'], 1);
      }),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('cannot retain a live database capability or run asynchronous callbacks', async () => {
    let escaped: ReadonlySqlite | undefined;
    await withReadonlySqlite(fixture(), (db) => {
      escaped = db;
      return null;
    });
    expect(() => escaped!.query('SELECT id FROM clients', [], 1)).toThrowError(
      'invalid_sqlite',
    );
    await expect(
      withReadonlySqlite(fixture(), async () => null),
    ).rejects.toMatchObject({ code: 'invalid_sqlite' });
  });

  it('preserves a caller business-review error and still closes the database', async () => {
    const review = new Error('review_required');
    let escaped: ReadonlySqlite | undefined;
    await expect(
      withReadonlySqlite(fixture(), (db) => {
        escaped = db;
        throw review;
      }),
    ).rejects.toBe(review);
    expect(() => escaped!.columns('clients')).toThrowError('invalid_sqlite');
    expect(
      (
        await withReadonlySqlite(fixture(), (db) =>
          db.query('SELECT id FROM clients', [], 1),
        )
      ).length,
    ).toBe(1);
  });
});
