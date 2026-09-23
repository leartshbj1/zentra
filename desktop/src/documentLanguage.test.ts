import { afterEach, expect, it } from 'vitest';
import { setAppLanguage, t, type AppLanguage } from './language';
import { documentNumberEntry } from './documentNumberEntry';
import { documentLineIssue } from './documentUi';

afterEach(() => { setAppLanguage('fr'); });

it.each<AppLanguage>(['fr', 'de', 'it', 'en'])('keeps exact amounts and validation rules when the interface is %s', language => {
  setAppLanguage(language);
  expect(documentNumberEntry("1’234,56", 'price')).toEqual({value: 123456, error: ''});
  expect(documentNumberEntry('12.345', 'price').value).toBeNull();
  expect(documentNumberEntry('0', 'quantity').error).toBe(t('La quantité doit être supérieure à zéro.'));
  expect(documentNumberEntry('100.01', 'discount').value).toBeNull();
  const issue = documentLineIssue([{id: 'line', catalogItemId: null, description: 'Texte client non traduit', quantity: 1, unit: '', unitPriceCents: 100, discountBp: 0, vatRateBp: 810}]);
  expect(issue?.field).toBe('Unité');
  expect(issue?.message).toBe(t('Ligne {number} : {message}', {number: 1, message: t('indiquez une unité, par exemple h, pièce ou forfait.')}));
  if(language !== 'fr') {
    expect(documentNumberEntry('0', 'quantity').error).not.toBe('La quantité doit être supérieure à zéro.');
    expect(issue?.message).not.toContain('indiquez une unité');
  }
});
