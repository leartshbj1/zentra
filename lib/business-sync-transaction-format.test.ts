import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import contract from '../desktop/src-tauri/src/business_sync_tables.json';
import { businessSyncContractHash } from './business-sync-bootstrap';
import { sha256Hex } from './account-security';
import {
  transactionChanges,
  transactionManifest,
  type TransactionChange,
  type TransactionManifest,
} from './business-sync-transaction-format';

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
it.skipIf(!process.env.ZENTRA_TRANSACTION_QA)(
  'decodes the exact transaction created on a second native profile after importing real server history',
  async () => {
    const folder = process.env.ZENTRA_TRANSACTION_QA!;
    const raw = readFileSync(join(folder, 'manifest.json'), 'utf8');
    const manifest = await transactionManifest(raw);
    expect(JSON.stringify(manifest)).toBe(raw);
    const changes: TransactionChange[] = [];
    for (const [i, part] of manifest.chunks.entries()) {
      const bytes = Uint8Array.from(
        readFileSync(join(folder, `${String(i).padStart(4, '0')}.json`)),
      );
      expect(bytes.length).toBe(part.size_bytes);
      expect(await sha256Hex(bytes)).toBe(part.sha256);
      const decoded = transactionChanges(bytes, manifest, i);
      expect(encode({ version: 1, changes: decoded })).toEqual(bytes);
      changes.push(...decoded);
    }
    expect(changes.length).toBe(manifest.change_count);
    expect(changes.map((c) => c.table).sort()).toEqual([
      'audit_log',
      'clients',
    ]);
    expect(changes.find((c) => c.table === 'clients')!.after_json).toContain(
      'Créé sur le second profil',
    );
    expect(manifest.base_revision).toBe(1);
  },
);

it.each([
  'attachments',
  'company_brand_assets',
  'payroll_document_imports',
  'settings',
  'vat_return_exports',
  'closing_package_exports',
] as const)(
  'binds %s document proofs to their original images, including deletion',
  async (table) => {
    const bytes = encode({ document: 'Document fictif' }),
      sha256 = await sha256Hex(bytes),
      size_bytes = bytes.length;
    const data: Record<string, unknown> = Object.fromEntries(
      contract.tables[table].columns.map((column) => [column, null]),
    );
    for (const key of contract.tables[table].key) data[key] = 'record';
    let root: 'attachments' | 'exports' = 'attachments',
      path = 'plan.txt';
    if (table === 'attachments')
      Object.assign(data, { stored_name: path, sha256, size_bytes });
    if (table === 'company_brand_assets') {
      path = 'branding/logo.png';
      Object.assign(data, {
        file_name: 'logo.png',
        sha256,
        byte_size: size_bytes,
      });
    }
    if (table === 'payroll_document_imports') {
      path = 'payroll-imports/salaire.pdf';
      Object.assign(data, {
        stored_path:
          'C:\\old-profile\\attachments\\payroll-imports\\salaire.pdf',
        file_sha256: sha256,
        file_size: size_bytes,
      });
    }
    if (table === 'settings') {
      path = `branding/logo-${sha256}.png`;
      Object.assign(data, {
        id: 1,
        onboarding_completed: 1,
        logo_path: `C:\\old-profile\\attachments\\${path.replaceAll('/', '\\')}`,
      });
    }
    if (table === 'vat_return_exports' || table === 'closing_package_exports') {
      root = 'exports';
      path = 'cloture.xml';
      Object.assign(data, { file_name: path });
      if (table === 'vat_return_exports') data.xml_sha256 = sha256;
      else data.manifest_sha256 = 'b'.repeat(64);
    }
    const row = JSON.stringify(data),
      proof = { root, path, sha256, size_bytes };
    const insert: TransactionChange = {
      sequence: '1',
      table,
      key_json: JSON.stringify(contract.tables[table].key.map((k) => data[k])),
      operation: 'insert',
      before_json: null,
      after_json: row,
      source_rowid: '1',
      files_before: [],
      files_after: [proof],
    };
    const deletion: TransactionChange = {
      ...insert,
      sequence: '2',
      operation: 'delete',
      before_json: row,
      after_json: null,
      files_before: [proof],
      files_after: [],
    };
    const chunk = encode({ version: 1, changes: [insert, deletion] });
    const manifest: TransactionManifest = {
      format: 'zentra-business-transaction',
      version: 1,
      schema_version: 60,
      contract_sha256: await businessSyncContractHash(),
      organization_id: 'org',
      installation_id: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      capture_generation: crypto.randomUUID(),
      bootstrap_transfer_id: crypto.randomUUID(),
      transaction_id: crypto.randomUUID(),
      base_revision: 1,
      first_sequence: '1',
      last_sequence: '2',
      change_count: 2,
      size_bytes: chunk.length,
      chunks: [
        {
          sha256: await sha256Hex(chunk),
          size_bytes: chunk.length,
          change_count: 2,
        },
      ],
      files: [{ sha256, size_bytes }],
    };
    expect(
      transactionChanges(
        chunk,
        await transactionManifest(JSON.stringify(manifest)),
        0,
      ),
    ).toEqual([insert, deletion]);
    for (const badProof of [
      { ...proof, path: 'another.txt' },
      { ...proof, root: root === 'exports' ? 'attachments' : 'exports' },
      { ...proof, sha256: 'c'.repeat(64) },
      { ...proof, size_bytes: size_bytes + 1 },
    ]) {
      expect(() =>
        transactionChanges(
          encode({
            version: 1,
            changes: [{ ...insert, files_after: [badProof] }, deletion],
          }),
          manifest,
          0,
        ),
      ).toThrow();
    }
    expect(() =>
      transactionChanges(
        encode({
          version: 1,
          changes: [insert, { ...deletion, files_before: [] }],
        }),
        manifest,
        0,
      ),
    ).toThrow();
  },
);
