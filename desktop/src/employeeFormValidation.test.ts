import { describe, expect, it } from 'vitest';
import { employeeFormIssue, employeeNativeFieldIssue } from './employeeFormValidation';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
describe('corrections de la fiche collaborateur', () => {
  it('demande les dates manquantes pendant le travail, puis contrôle leur ordre', () => {
    const data = form({ employmentContractKind: 'fixed' });
    expect(employeeFormIssue(data, 'work')?.field).toBe('employmentStart');
    data.set('employmentStart', '2026-09-01');
    expect(employeeFormIssue(data, 'work')?.field).toBe('employmentEnd');
    data.set('employmentEnd', '2026-08-31');
    expect(employeeFormIssue(data, 'work')?.field).toBe('employmentEnd');
    data.set('employmentEnd', '2026-09-01');
    expect(employeeFormIssue(data, 'work')).toBeNull();
    expect(employeeFormIssue(form({}), 'all')).toBeNull();
  });
  it.each([
    ['lppAssessmentYear', 'lppAnnualSalary'], ['acOpeningYear', 'acOpeningBasis'], ['laaOpeningYear', 'laaOpeningBasis'],
  ])('retrouve la valeur manquante dans %s, sans remplacer une inconnue par zéro', (year, amount) => {
    const data = form({ [year]: '2026' });
    expect(employeeFormIssue(data, 'work')).toBeNull();
    expect(employeeFormIssue(data, 'all')?.field).toBe(amount);
    expect([...data.entries()]).toEqual([[year, '2026']]);
    expect(employeeFormIssue(data, 'all', true)?.message).toContain('compléter plus tard');
    expect(employeeFormIssue(data, 'all', false)?.message).not.toContain('vides');
    data.set(amount, '0');
    expect(employeeFormIssue(data, 'all')).toBeNull();
    data.set(year, '');
    expect(employeeFormIssue(data, 'all')?.field).toBe(year);
    data.set(amount, '');
    expect(employeeFormIssue(data, 'all')).toBeNull();
  });
  it('renvoie une exception incompatible vers le type de contrat et respecte les dates confirmées', () => {
    const data = form({ lppExceptionCode: 'short_fixed_contract', employmentContractKind: 'indefinite' });
    expect(employeeFormIssue(data, 'all')?.field).toBe('lppExceptionEvidenceReference');
    data.set('lppExceptionEvidenceReference', 'Contrat signé');
    expect(employeeFormIssue(data, 'all')?.field).toBe('employmentContractKind');
    data.set('employmentContractKind', 'fixed'); data.set('employmentStart', '2026-09-01'); data.set('employmentEnd', '2026-09-30');
    expect(employeeFormIssue(data, 'all')).toBeNull();
    data.set('birthDate', '1990-01-01'); data.set('referenceAgeDate', '1989-12-31');
    expect(employeeFormIssue(data, 'all')?.field).toBe('referenceAgeDate');
  });
  it('distingue les champs natifs identifiables des erreurs de stockage', () => {
    expect(employeeNativeFieldIssue('IBAN invalide')?.field).toBe('iban');
    expect(employeeNativeFieldIssue('social_security_number doit contenir 13 chiffres')?.field).toBe('avsNumber');
    expect(employeeNativeFieldIssue('La fin du contrat précède son début.')?.field).toBe('employmentEnd');
    expect(employeeNativeFieldIssue('SQLITE_BUSY: database locked')).toBeNull();
    expect(employeeNativeFieldIssue('Enregistrement momentanément indisponible. Réessayez.')).toBeNull();
  });
});
