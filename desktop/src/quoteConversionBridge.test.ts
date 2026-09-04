import { describe, expect, it } from 'vitest';
import { convertQuoteMutation } from './bridge';

const quote = { id: 'quote-42', title: 'Mandat accepté' };

describe('contrat frontend de conversion devis vers facture', () => {
  it('demande une facture complète quand aucun acompte n’est activé', () => {
    expect(convertQuoteMutation(quote)).toEqual({
      command: 'convert_quote_to_invoice',
      args: {
        input: {
          quote_id: 'quote-42',
          title: 'Mandat accepté',
          deposit_percentage_bp: null,
        },
      },
    });
  });

  it('transmet exactement le pourcentage d’acompte en points de base', () => {
    expect(convertQuoteMutation(quote, 3_333).args.input.deposit_percentage_bp).toBe(
      3_333,
    );
  });

  it('bloque une valeur invalide avant tout appel Tauri', () => {
    expect(() => convertQuoteMutation(quote, 0)).toThrow(/0,01 et 100/);
    expect(() => convertQuoteMutation(quote, 10_001)).toThrow(/0,01 et 100/);
  });
});
