import { describe, it, expect } from 'vitest';
import { employeeDocumentDraft } from './employeeDocumentDraft';

describe('préremplissage depuis une fiche de salaire', () => {
  const text = `Bulletin de salaire Décembre 2024\nAlex Exemple\nMonsieur\nAlex Exemple\nRue du Lac 8\n2000 Neuchâtel\nNuméro d’assurance sociale : 756.0000.000.000\nPériode de salaire : 01.12.2024 — 31.12.2024\n1000 Salaire mensuel 5'000\n1005 Salaire horaire 25 30 600\nAllocations familiales 300\nTotal 5900\nPaiement : 4703\nwww.entreprise-exemple.ch contact@entreprise-exemple.ch`;
  it('conserve l’identité et le salaire de base sans inventer un contrat ou des coordonnées', () => {
    const draft = employeeDocumentDraft(JSON.stringify({ name: 'Alex', addressLine1: 'Rue du Lac 8', postalCode: '2000', city: 'Neuchâtel', avsNumber: '756.0000.000.000', birthDate: '01.12.2024', employmentStart: '01.12.2024', email: 'contact@entreprise-exemple.ch', iban: 'CH93 0076 2011 6238 5295 7', role: 'Exemple' }), text);
    expect(draft.fields).toEqual({ name: 'Alex Exemple', addressLine1: 'Rue du Lac 8', postalCode: '2000', city: 'Neuchâtel', salaryMode: 'monthly', grossSalary: '5000.00' });
    expect(draft.warnings.join(' ')).toContain('AVS');
  });
  it('ne prend ni le brut total ni le paiement net pour le salaire contractuel', () => {
    expect(employeeDocumentDraft('{"grossSalary":"5900","salaryMode":"monthly"}', 'Brut total 5900\nNet à payer 4703').fields).toEqual({});
  });
  it('conserve les centimes et refuse de choisir entre plusieurs bases mensuelles', () => {
    expect(employeeDocumentDraft('{}', 'Salaire mensuel CHF 5’876.35').fields.grossSalary).toBe('5876.35');
    expect(employeeDocumentDraft('{}', 'Salaire mensuel 5000\nSalaire mensuel 5200').fields.grossSalary).toBeUndefined();
  });
  it('ne remplit les dates que lorsqu’elles sont explicitement identifiées et valides', () => {
    const raw = JSON.stringify({ birthDate: '28.02.1990', employmentStart: '01.03.2020', employeeNumber: 'E-042', role: 'Électricienne' });
    expect(employeeDocumentDraft(raw, 'Date de naissance : 28.02.1990\nEntrée : 01.03.2020\nMatricule : E-042\nFonction : Électricienne').fields).toEqual({ birthDate: '1990-02-28', employmentStart: '2020-03-01', employeeNumber: 'E-042', role: 'Électricienne' });
    expect(employeeDocumentDraft('{"birthDate":"31.02.1990"}', 'Naissance : 31.02.1990').fields.birthDate).toBeUndefined();
  });
  it('accepte les délimiteurs de Qwen mais refuse une réponse tronquée', () => {
    expect(employeeDocumentDraft('<think>\n</think>\n```json\n{"name":"Alex Exemple"}\n```', text).fields.name).toBe('Alex Exemple');
    expect(() => employeeDocumentDraft('{"name":"Alex', text)).toThrow();
  });
  it('lit les champs explicitement étiquetés sans génération et omet les dates ambiguës', () => {
    expect(employeeDocumentDraft('{}', 'Naissance : 28.02.1990\nEntrée : 01.03.2020\nFonction : Électricienne\nMatricule : E-042').fields).toEqual({birthDate:'1990-02-28',employmentStart:'2020-03-01',role:'Électricienne',employeeNumber:'E-042'});
    expect(employeeDocumentDraft('{}','Naissance : 28.02.1990\nNaissance : 01.03.1991').fields.birthDate).toBeUndefined();
  });
});
