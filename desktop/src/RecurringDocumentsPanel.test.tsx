import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RecurringDocumentsPanel,
  createRecurringRequestId,
  createRecurringScheduleInput,
  recurringCatchUpState,
  recurringInvoiceStatusLabel,
  recurringOrderBlockingMessages,
  recurringScheduleRhythm,
  sortedRecurringOccurrences,
  validateRecurringScheduleInput,
  type RecurringDocumentOrder,
  type RecurringDocumentSchedule,
  type RecurringDocumentScheduleCreateInput,
  type RecurringDocumentScheduleUpdateInput,
} from './RecurringDocumentsPanel';

const eligibleOrder: RecurringDocumentOrder = {
  id: 'order-1',
  number: 'CMD-2026-0042',
  title: 'Forfait de maintenance',
  clientName: 'Atelier du Lac SA',
  orderDate: '2026-09-01',
  status: 'confirmed',
  eligible: true,
  blockingReasons: [],
};

const activeSchedule: RecurringDocumentSchedule = {
  id: 'schedule-1',
  sourceSalesOrderId: eligibleOrder.id,
  status: 'active',
  frequency: 'quarterly',
  startDate: '2026-09-30',
  endDate: '2027-09-30',
  paymentTermsDays: 30,
  nextOccurrenceOn: '2026-12-31',
  pendingCatchUpCount: 0,
  occurrences: [
    {
      id: 'occurrence-old',
      scheduleId: 'schedule-1',
      scheduledFor: '2026-06-30',
      invoiceId: 'invoice-0',
      requestId: 'request-old',
      payloadSha256: 'payload-old',
      sourceSnapshotSha256: 'snapshot-old',
      createdAt: '2026-06-30T08:00:00Z',
      invoiceStatus: 'paid',
      invoiceNumber: 'FAC-41',
    },
    {
      id: 'occurrence-new',
      scheduleId: 'schedule-1',
      scheduledFor: '2026-09-30',
      invoiceId: 'invoice-1',
      requestId: 'request-new',
      payloadSha256: 'payload-new',
      sourceSnapshotSha256: 'snapshot-new',
      createdAt: '2026-09-30T08:00:00Z',
      invoiceStatus: 'draft',
      invoiceNumber: 'BROUILLON-42',
    },
  ],
};

const noopCreate = async (_input: RecurringDocumentScheduleCreateInput) =>
  undefined;
const noopUpdate = async (_input: RecurringDocumentScheduleUpdateInput) =>
  undefined;

describe('contrat de planification récurrente', () => {
  it('génère un UUID v4 accepté par le backend', () => {
    expect(createRecurringRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('prépare exactement le payload de création attendu par le backend', () => {
    expect(
      createRecurringScheduleInput(
        'order-1',
        '2026-09-30',
        '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
      ),
    ).toEqual({
      requestId: '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
      sourceSalesOrderId: 'order-1',
      frequency: 'monthly',
      startDate: '2026-09-30',
      endDate: null,
      paymentTermsDays: 30,
    });
  });

  it('refuse les dates inversées et les délais excessifs', () => {
    const errors = validateRecurringScheduleInput({
      requestId: '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
      sourceSalesOrderId: 'order-1',
      frequency: 'monthly',
      startDate: '2026-09-30',
      endDate: '2026-09-29',
      paymentTermsDays: 366,
    });
    expect(errors).toEqual({
      endDate: 'La date de fin doit suivre la date de début.',
      paymentTermsDays: 'Le délai doit être compris entre 0 et 365 jours.',
    });
  });

  it('accepte la fréquence yearly et une date de départ en fin de mois', () => {
    expect(
      validateRecurringScheduleInput({
        requestId: '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
        sourceSalesOrderId: 'order-1',
        frequency: 'yearly',
        startDate: '2028-02-29',
        endDate: null,
        paymentTermsDays: 0,
      }),
    ).toEqual({});
  });

  it('refuse une date civile inexistante', () => {
    expect(
      validateRecurringScheduleInput({
        requestId: '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
        sourceSalesOrderId: 'order-1',
        frequency: 'monthly',
        startDate: '2026-02-30',
        endDate: null,
        paymentTermsDays: 30,
      }),
    ).toEqual({ startDate: 'Indiquez une date de début valide.' });
  });

  it('refuse une première échéance antérieure à la commande', () => {
    expect(
      validateRecurringScheduleInput(
        {
          requestId: '35f9c59c-51e6-4d98-b1fd-28db8ac15954',
          sourceSalesOrderId: 'order-1',
          frequency: 'monthly',
          startDate: '2026-08-31',
          endDate: null,
          paymentTermsDays: 30,
        },
        '2026-09-01',
      ),
    ).toEqual({
      startDate:
        'La première échéance ne peut pas précéder la date de la commande.',
    });
  });

  it('traduit les statuts réels des factures générées', () => {
    expect(recurringInvoiceStatusLabel('issued')).toBe('Facture émise');
    expect(recurringInvoiceStatusLabel('partially_paid')).toBe(
      'Facture partiellement payée',
    );
  });
});

describe('garde-fous du panneau', () => {
  it('explique pourquoi une commande ne peut pas être planifiée', () => {
    expect(
      recurringOrderBlockingMessages({
        ...eligibleOrder,
        status: 'draft',
        eligible: false,
        blockingReasons: [
          'Une ligne avec stock ou livraison doit être retirée.',
        ],
      }),
    ).toEqual([
      'Confirmez d’abord la commande pour figer son contenu.',
      'Une ligne avec stock ou livraison doit être retirée.',
    ]);
  });

  it('signale une revue sans rendre le lot suivant impossible', () => {
    expect(recurringCatchUpState(13, 12)).toEqual({
      pending: 13,
      limit: 12,
      requiresReview: true,
    });
    expect(recurringCatchUpState(12, 12).requiresReview).toBe(false);
  });

  it('déduit la fin de mois de la date de départ et trie l’historique', () => {
    expect(recurringScheduleRhythm(activeSchedule)).toBe(
      'Trimestrielle, en fin de mois',
    );
    expect(
      recurringScheduleRhythm({
        frequency: 'yearly',
        startDate: '2026-09-15',
      }),
    ).toBe('Annuelle, le 15');
    expect(
      sortedRecurringOccurrences(activeSchedule.occurrences).map(
        (item) => item.id,
      ),
    ).toEqual(['occurrence-new', 'occurrence-old']);
  });
});

describe('rendu accessible de RecurringDocumentsPanel', () => {
  it('présente une vue vide éligible sans promettre une émission automatique', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={null}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('Aucune planification pour cette commande');
    expect(html).toContain('Planifier cette commande');
    expect(html).toContain('facture brouillon à contrôler');
    expect(html).toContain('Aucune facture n’est émise');
    expect(html).toContain('tant que Zentra reste ouvert');
    expect(html).toContain('aria-labelledby=');
  });

  it('rend les raisons de blocage dans une alerte lisible', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={{
          ...eligibleOrder,
          eligible: false,
          blockingReasons: [
            'La commande contient une livraison ou un article suivi en stock.',
          ],
        }}
        schedule={null}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Planification indisponible');
    expect(html).toContain('article suivi en stock');
    expect(html).not.toContain('Planifier cette commande');
  });

  it('expose les choix backend et explique l’ancrage du formulaire compact', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={null}
        today="2026-09-01"
        defaultCreateOpen
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('<legend>Fréquence</legend>');
    expect(html).toContain('Mensuelle');
    expect(html).toContain('Trimestrielle');
    expect(html).toContain('Annuelle');
    expect(html).toContain('Première échéance');
    expect(html).toContain('Délai de paiement');
    expect(html).toContain('dernier jour du mois');
    expect(html).toContain('limite de rattrapage');
    expect(html).not.toContain('Jour du mois');
  });

  it('montre prochaine échéance, pause et occurrences sans action d’émission', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={activeSchedule}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
        onOpenDraftInvoice={() => undefined}
      />,
    );
    expect(html).toContain('Planification active');
    expect(html).toContain('dateTime="2026-12-31"');
    expect(html).toContain('Mettre en pause');
    expect(html).toContain('Terminer définitivement');
    expect(html).toContain('Historique des occurrences');
    expect(html).toContain('BROUILLON-42');
    expect(html).toContain('Facture brouillon à contrôler');
    expect(html).toContain('aria-label="Ouvrir la facture BROUILLON-42"');
    expect(html).not.toContain('Émettre la facture');
  });

  it('permet explicitement le lot suivant quand une revue est requise', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={{
          ...activeSchedule,
          status: 'review_required',
          pendingCatchUpCount: 13,
          reviewReason:
            'La limite de rattrapage est de 12 échéances par lot.',
        }}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('Revue requise');
    expect(html).toContain('13 échéances en attente');
    expect(html).toContain('La limite de rattrapage est de 12');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');
    const resumeButton = html.match(
      /<button[^>]*>[\s\S]*?Reprendre et préparer au plus[\s\S]*?12 brouillons<\/button>/,
    )?.[0];
    expect(resumeButton).toBeDefined();
    expect(resumeButton).not.toContain('disabled');
  });

  it('affiche une planification terminée sans action de reprise', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={{
          ...activeSchedule,
          status: 'completed',
          nextOccurrenceOn: null,
        }}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('Terminée');
    expect(html).toContain('historique reste consultable');
    expect(html).not.toContain('Mettre en pause');
    expect(html).not.toContain('Reprendre la planification');
    expect(html).not.toContain('Terminer définitivement');
  });

  it('interdit les actions si le planning appartient à une autre commande', () => {
    const html = renderToStaticMarkup(
      <RecurringDocumentsPanel
        order={eligibleOrder}
        schedule={{
          ...activeSchedule,
          sourceSalesOrderId: 'order-other',
        }}
        onCreate={noopCreate}
        onUpdate={noopUpdate}
      />,
    );
    expect(html).toContain('ne correspond pas à la commande affichée');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Mettre en pause/,
    );
  });
});
