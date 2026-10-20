// Factures fournisseurs reçues par mail avec une QR-facture : Autopilote lit
// le code QR de la pièce jointe sur cet appareil et prépare la facture.
// La création du brouillon attend toujours le clic.

import { useEffect, useRef, useState } from 'react';
import { withDiagnosticIntent } from './diagnosticIntent';
import { applyQrBill, matchQrBillSupplier } from './qrBillPurchase';
import { readQrBillBytes } from './qrBillReader';
import { inboxRequest, pendingMailInvoices, type InboxDraft, type MailInvoice, type SupplierInboxState } from './supplierInbox';
import { purchaseFields, purchaseLineValue } from './supplierInvoicePreparation';
import type { QrBill } from './swissQrBill';
import type { Supplier, Workspace } from './types';

const READABLE = /^(application\/pdf|image\/(png|jpeg|webp))$/;

export type QrMailProposal = Readonly<{
  item: MailInvoice;
  bill: QrBill;
  supplier: Supplier | null;
  /** Brouillon prêt à importer ; null si le fournisseur ou le montant net restent à vérifier. */
  draft: InboxDraft | null;
  dueDate: string;
}>;

export function qrMailProposal(item: MailInvoice, bill: QrBill, workspace: Workspace, ratesBp: readonly number[], today: string): QrMailProposal | null {
  if (bill.currency !== 'CHF') return null;
  const supplier = matchQrBillSupplier(bill, workspace);
  const { fields, complete } = applyQrBill(bill, purchaseFields(workspace, undefined, today), workspace, supplier, today, ratesBp);
  const lines = fields.lines.map(purchaseLineValue);
  const ready = Boolean(supplier) && complete && lines.every((line) => line !== null);
  const draft: InboxDraft | null = ready ? {
    supplier_id: supplier!.id,
    date: fields.date,
    due_date: fields.dueDate,
    reference: fields.reference,
    items: lines.map((line) => ({
      description: line!.description,
      quantity_milli: line!.quantityMilli,
      unit_price_cents: line!.unitPriceCents,
      vat_bp: line!.vatBp,
      category: line!.category,
      expense_account_id: null,
    })),
  } : null;
  return { item, bill, supplier, draft, dueDate: fields.dueDate };
}

/**
 * Lit au plus trois pièces jointes par passage, une seule fois par
 * justificatif (empreinte), pour les factures reçues encore à traiter.
 */
export function useQrMailBills(state: SupplierInboxState | null, enabled: boolean): ReadonlyMap<string, QrBill> {
  const [bills, setBills] = useState<ReadonlyMap<string, QrBill>>(new Map());
  const seen = useRef(new Set<string>());
  const running = useRef(false);
  const organization = useRef(state?.organizationId);
  organization.current = state?.organizationId;
  useEffect(() => {
    if (!enabled || !state || running.current) return;
    const queue = pendingMailInvoices(state)
      .filter((item) => !item.otherDevice && READABLE.test(item.mediaType) && !seen.current.has(item.sha256))
      .slice(0, 3);
    if (queue.length === 0) return;
    running.current = true;
    const organizationId = state.organizationId;
    void (async () => {
      for (const item of queue) {
        seen.current.add(item.sha256);
        try {
          const document = await inboxRequest<{ base64: string }>(withDiagnosticIntent({ action: 'document', id: item.id }, 'supplier_inbox_request', 'document'));
          const bytes = Uint8Array.from(atob(document.base64), (character) => character.charCodeAt(0));
          const read = await readQrBillBytes(bytes, item.fileName || 'facture.pdf');
          if (read.ok && organization.current === organizationId) setBills((current) => new Map(current).set(item.id, read.bill));
        } catch {
          // Pièce jointe indisponible : la facture reste dans la réception habituelle.
        }
      }
    })().finally(() => { running.current = false; });
  }, [state, enabled]);
  useEffect(() => { setBills(new Map()); seen.current.clear(); }, [state?.organizationId]);
  return bills;
}
