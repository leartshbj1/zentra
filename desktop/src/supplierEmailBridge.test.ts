import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;
  },
  invoke: invokeMock,
}));

import { desktopApi } from './bridge';

const input = {
  id: '7ba86f19-c15d-4cb2-8151-30bd2f39f640',
  supplierId: 'supplier-1',
  projectId: null,
  date: '2026-09-02',
  dueDate: '2026-10-02',
  reference: 'INV-42',
  note: 'Import déterministe',
  items: [
    {
      description: 'Papeterie',
      quantityMilli: 1_000,
      unit: 'forfait',
      unitPriceCents: 10_000,
      discountBp: 0,
      vatBp: 810,
      category: 'Matériel',
      expenseAccountId: 'account-expense',
      projectId: null,
    },
  ],
};

describe('reprise sans doublon du brouillon fournisseur importé', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('renvoie le même id à Tauri après un échec de rafraîchissement post-commit', async () => {
    let refreshAttempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_supplier_invoice_draft') return {};
      if (command === 'get_app_state') {
        refreshAttempts += 1;
        if (refreshAttempts === 1)
          throw new Error('refresh failed after commit');
        return { onboarding_completed: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(desktopApi.saveSupplierInvoiceDraft(input)).rejects.toThrow(
      'refresh failed after commit',
    );
    await expect(
      desktopApi.saveSupplierInvoiceDraft(input),
    ).resolves.toBeDefined();

    const saveCalls = invokeMock.mock.calls.filter(
      ([command]) => command === 'save_supplier_invoice_draft',
    );
    expect(saveCalls).toHaveLength(2);
    expect(saveCalls[0]?.[1]).toMatchObject({ input: { id: input.id } });
    expect(saveCalls[1]?.[1]).toMatchObject({ input: { id: input.id } });
  });

  it('refuse avant Tauri une sauvegarde sans identifiant idempotent', async () => {
    await expect(
      desktopApi.saveSupplierInvoiceDraft({ ...input, id: '   ' }),
    ).rejects.toThrow('reprise sans doublon');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('transmet les deux empreintes avant de joindre la pièce MIME', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'add_supplier_email_attachment') return {};
      if (command === 'get_app_state') return { onboarding_completed: 0 };
      throw new Error(`unexpected command: ${command}`);
    });

    await desktopApi.addSupplierEmailAttachment(
      input.id,
      'C:\\factures\\message.eml',
      'a'.repeat(64),
      'b'.repeat(64),
    );

    expect(invokeMock).toHaveBeenCalledWith('add_supplier_email_attachment', {
      input: {
        supplier_invoice_id: input.id,
        source_path: 'C:\\factures\\message.eml',
        source_sha256: 'a'.repeat(64),
        attachment_sha256: 'b'.repeat(64),
      },
    });
  });

  it('enregistre le brouillon et sa pièce avant un seul rafraîchissement', async () => {
    const commands: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      commands.push(command);
      if (
        command === 'save_supplier_email_invoice_draft' ||
        command === 'add_supplier_email_attachment'
      )
        return {};
      if (command === 'get_app_state') return { onboarding_completed: 0 };
      throw new Error(`unexpected command: ${command}`);
    });

    await desktopApi.saveSupplierInvoiceDraftFromEmail(input, {
      sourcePath: 'C:\\factures\\message.eml',
      sourceSha256: 'a'.repeat(64),
      attachmentSha256: 'b'.repeat(64),
    });

    expect(commands).toEqual([
      'save_supplier_email_invoice_draft',
      'add_supplier_email_attachment',
      'get_app_state',
    ]);
  });
});
