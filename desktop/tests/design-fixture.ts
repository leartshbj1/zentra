import { desktopApi } from '../src/bridge';
import type { Workspace } from '../src/types';
import { documentTotals } from '../src/utils';

// Synthetic documents, confined to the UI harness and never included in a release.
export function installDesignFixture(workspace: Workspace) {
  workspace.settings!.organization.legalName = 'Atelier du Léman';
  workspace.settings!.organization.address.street = 'Rue du Lac';
  workspace.clients[0].company = 'Résidence Bellevue';
  workspace.clients[0].name = 'Camille Martin';
  workspace.clients[0].address = 'Chemin des Vignes 12\n1009 Pully';
  workspace.clients[0].email = 'camille@example.invalid';
  workspace.projects[0].name = 'Rénovation · Résidence Bellevue';
  const labels = ['Rénovation de l’espace de vie', 'Aménagement des bureaux', 'Entretien annuel'];
  for (const [index, quote] of workspace.quotes.entries()) {
    quote.title = labels[index];
    quote.projectId = workspace.projects[0].id;
    quote.lines = [
      { ...quote.lines[0], id: `design-${index}-1`, description: 'Préparation des surfaces et protection du mobilier', quantity: 12, unit: 'h', unitPriceCents: 9500 },
      { ...quote.lines[0], id: `design-${index}-2`, description: 'Fourniture et pose du revêtement mural, finitions comprises', quantity: 28, unit: 'm²', unitPriceCents: 7800 },
      { ...quote.lines[0], id: `design-${index}-3`, description: 'Nettoyage de fin d’intervention', quantity: 1, unit: 'forfait', unitPriceCents: 25000 },
    ];
    quote.notes = 'Merci pour votre confiance. Nous restons à votre disposition pour organiser les travaux.';
    workspace.invoices[index].lines = structuredClone(quote.lines);
    workspace.invoices[index].title = labels[index];
    workspace.invoices[index].notes = quote.notes;
  }
  desktopApi.exportSalesDocumentPdf = async (entity, id) => {
    if (sessionStorage.getItem('design-export-fail') === '1') throw new Error('Le fichier est déjà ouvert. Fermez-le puis réessayez.');
    sessionStorage.setItem('design-export', JSON.stringify({ entity, id }));
    return { path: 'document-test.pdf', pages: 2, finalDocument: false } as never;
  };
  if (new URLSearchParams(location.search).has('designQr')) {
    const invoice = workspace.invoices[1];
    invoice.status = 'issued'; invoice.number = 'F-DEMO-2026-0042';
    invoice.lines = Array.from({ length: 24 }, (_, i) => ({ ...invoice.lines[i % 3], id: `long-${i}`, description: `Poste ${i + 1} · ${invoice.lines[i % 3].description}` }));
    invoice.qrBill = {
      invoiceId: invoice.id, payload: 'SYNTHETIC_UI_QR_DO_NOT_PAY', lines: [], referenceType: 'NON', isQrIban: false,
      characterCount: 26, byteCount: 26, frozen: true, frozenAt: '2026-09-05T10:00:00Z', createdAt: '', updatedAt: '',
      input: { iban: 'CH9300762011623852957', currency: 'EUR', amountCents: documentTotals(invoice.lines).totalCents, referenceType: 'NON', reference: '', unstructuredMessage: 'TEST VISUEL — NE PAS PAYER', billInformation: '', alternativeProcedures: [],
        creditor: { name: 'Atelier de démonstration', street: 'Rue du Lac', buildingNumber: '1', postalCode: '1000', city: 'Lausanne', country: 'CH' },
        debtor: { name: 'Client de démonstration', street: 'Chemin des Vignes', buildingNumber: '12', postalCode: '1009', city: 'Pully', country: 'CH' } },
    };
  }
}
