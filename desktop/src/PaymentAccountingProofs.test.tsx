import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Payment } from './types';
import {
  PaymentAccountingProofs,
  accountingEntryFocusFilter,
  invoicePaymentAccountingState,
  paymentAccountingProof,
} from './PaymentAccountingProofs';

const linkedPayment: Payment = {
  id: 'payment-1',
  invoiceId: 'invoice-1',
  date: '2026-09-01',
  amountCents: 12_500,
  method: 'Virement',
  reference: 'BANQUE-42',
  journalEntryId: 'journal-42',
  journalEntryNumber: 'J-2026-000042',
  journalSourceEvent: 'invoice:invoice-1',
  journalEntryIsActive: true,
  journalReversalDepth: 0,
  journalEntrySemanticallyValid: true,
};

describe('preuve comptable des encaissements', () => {
  it('ne certifie un paiement que si le lien et le numéro du journal existent', () => {
    expect(paymentAccountingProof(linkedPayment)).toMatchObject({
      paymentId: 'payment-1',
      entryId: 'journal-42',
      entryNumber: 'J-2026-000042',
      label: 'Comptabilisé · J-2026-000042',
      accountingState: 'active',
      reversalDepth: 0,
    });
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        id: 'payment-unlinked',
        journalEntryId: null,
        journalEntryNumber: '',
      }),
    ).toBeNull();
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalSourceEvent: 'invoice:une-autre-facture',
      }),
    ).toBeNull();
  });

  it('signale une écriture extournée au lieu de présenter le paiement comme comptabilisé', () => {
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalEntryIsActive: false,
        journalReversalDepth: 1,
      }),
    ).toMatchObject({
      label: 'Écriture extournée · J-2026-000042',
      accountingState: 'reversed',
      reversalDepth: 1,
    });
  });

  it('échoue fermé si la parité ou la profondeur de la chaîne est absente ou incohérente', () => {
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalReversalDepth: undefined,
      }),
    ).toMatchObject({
      label: 'État comptable à contrôler · J-2026-000042',
      accountingState: 'unknown',
    });
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalEntryIsActive: false,
        journalReversalDepth: 2,
      }),
    ).toMatchObject({ accountingState: 'unknown' });
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalEntrySemanticallyValid: false,
      }),
    ).toMatchObject({ accountingState: 'unknown' });
    expect(
      paymentAccountingProof({
        ...linkedPayment,
        journalEntrySemanticallyValid: undefined,
      }),
    ).toMatchObject({ accountingState: 'unknown' });
  });

  it('rend visible toute la piste lorsque deux extournes ont rétabli l’effet net', () => {
    const proof = paymentAccountingProof({
      ...linkedPayment,
      journalReversalDepth: 2,
    });
    expect(proof).toMatchObject({
      label: 'Effet rétabli après 2 extournes · J-2026-000042',
      accountingState: 'restored',
      reversalDepth: 2,
    });
    expect(accountingEntryFocusFilter(proof!)).toEqual({});
  });

  it('conserve chaque preuve des paiements partiels et signale les liaisons manquantes', () => {
    const state = invoicePaymentAccountingState('invoice-1', [
      linkedPayment,
      {
        ...linkedPayment,
        id: 'payment-2',
        amountCents: 2_500,
        journalEntryId: 'journal-43',
        journalEntryNumber: 'J-2026-000043',
      },
      {
        ...linkedPayment,
        id: 'payment-unlinked',
        journalEntryId: null,
        journalEntryNumber: '',
      },
      { ...linkedPayment, id: 'other-invoice', invoiceId: 'invoice-2' },
    ]);

    expect(state.proofs.map((proof) => proof.entryNumber)).toEqual([
      'J-2026-000042',
      'J-2026-000043',
    ]);
    expect(state.unlinkedCount).toBe(1);
  });

  it('borne le journal au jour du paiement et échoue en période libre si la date héritée est invalide', () => {
    const proof = paymentAccountingProof(linkedPayment)!;
    expect(accountingEntryFocusFilter(proof)).toEqual({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-01',
    });
    expect(
      accountingEntryFocusFilter({ ...proof, entryDate: '2026-02-30' }),
    ).toEqual({});
    expect(
      accountingEntryFocusFilter({ ...proof, accountingState: 'reversed' }),
    ).toEqual({});
  });
});

describe('rendu de la preuve dans les factures', () => {
  it('rend un bouton explicite vers l’écriture exacte, sans masquer une anomalie héritée', () => {
    const html = renderToStaticMarkup(
      <PaymentAccountingProofs
        invoiceId="invoice-1"
        payments={[
          linkedPayment,
          {
            ...linkedPayment,
            id: 'payment-unlinked',
            journalEntryId: null,
            journalEntryNumber: '',
          },
        ]}
        onOpenJournal={() => undefined}
      />,
    );

    expect(html).toContain('Comptabilisé · J-2026-000042');
    expect(html).toContain(
      'aria-label="Ouvrir l’écriture comptable J-2026-000042 liée au paiement du',
    );
    expect(html).toContain('1 encaissement sans preuve comptable liée');
    expect(html.match(/Comptabilisé ·/g)).toHaveLength(1);
  });

  it('ne rend rien lorsqu’aucun encaissement réel ne concerne la facture', () => {
    expect(
      renderToStaticMarkup(
        <PaymentAccountingProofs
          invoiceId="invoice-absente"
          payments={[linkedPayment]}
          onOpenJournal={() => undefined}
        />,
      ),
    ).toBe('');
  });

  it('rend l’anomalie d’extourne sans icône ni libellé vert de comptabilisation', () => {
    const html = renderToStaticMarkup(
      <PaymentAccountingProofs
        invoiceId="invoice-1"
        payments={[{
          ...linkedPayment,
          journalEntryIsActive: false,
          journalReversalDepth: 1,
        }]}
        onOpenJournal={() => undefined}
      />,
    );

    expect(html).toContain('Écriture extournée · J-2026-000042');
    expect(html).toContain('class="button button--ghost button--small is-reversed"');
    expect(html).not.toContain('Comptabilisé ·');
  });

  it('ne présente jamais un lien hérité sans profondeur comme une preuve verte', () => {
    const html = renderToStaticMarkup(
      <PaymentAccountingProofs
        invoiceId="invoice-1"
        payments={[{ ...linkedPayment, journalReversalDepth: undefined }]}
        onOpenJournal={() => undefined}
      />,
    );

    expect(html).toContain('État comptable à contrôler · J-2026-000042');
    expect(html).toContain('is-unknown');
    expect(html).not.toContain('Comptabilisé ·');
  });
});
