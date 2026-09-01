import type { Employee, PayrollAiIdentityEvidence } from './types';
import { isValidIban, isValidIsoCalendarDate, isValidSwissAvsNumber } from './payrollImportQuality';

export type PayrollEmployeeMatch = {
  employeeId: string | null;
  conflict: boolean;
  reason: string;
};

const digits = (value: string) => value.replace(/\D/g, '');
const compact = (value: string) => value.trim().toLocaleLowerCase('fr-CH').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const iban = (value: string) => value.replace(/\s/g, '').toUpperCase();

export function findStrongEmployeeMatch(evidence: PayrollAiIdentityEvidence, employees: Employee[]): PayrollEmployeeMatch {
  if (evidence.passes < 2) return { employeeId: null, conflict: false, reason: 'Une seule lecture exploitable : rattachement manuel requis.' };
  if (evidence.conflicts.length) return { employeeId: null, conflict: true, reason: `Identité contradictoire entre les deux lectures (${evidence.conflicts.join(', ')}).` };

  const avsValue = digits(evidence.avsNumber);
  const employeeNumber = compact(evidence.employeeNumber);
  const avsIsValid = Boolean(avsValue) && isValidSwissAvsNumber(evidence.avsNumber);
  const avsMatches = avsIsValid
    ? employees.filter((employee) => digits(employee.avsNumber) === avsValue)
    : [];
  const numberMatches = employeeNumber
    ? employees.filter((employee) => compact(employee.employeeNumber) === employeeNumber)
    : [];

  if (avsMatches.length > 1) return { employeeId: null, conflict: true, reason: 'Le même numéro AVS existe sur plusieurs collaborateurs; corrigez les profils avant le rattachement.' };
  if (avsMatches.length === 1) {
    const candidate = avsMatches[0];
    if (employeeNumber && compact(candidate.employeeNumber) !== employeeNumber) return { employeeId: null, conflict: true, reason: 'Le numéro AVS correspond, mais le numéro employé du document ne correspond pas au même profil.' };
    if (numberMatches.length > 1) return { employeeId: null, conflict: true, reason: 'Le numéro employé n’est pas unique.' };
    if (numberMatches.length === 1 && numberMatches[0].id !== candidate.id) return { employeeId: null, conflict: true, reason: 'Le numéro AVS et le numéro employé désignent deux collaborateurs différents.' };
    if (evidence.birthDate) {
      if (!isValidIsoCalendarDate(evidence.birthDate)) return { employeeId: null, conflict: true, reason: 'La date de naissance confirmée par l’IA n’est pas une date civile valide.' };
      if (!candidate.birthDate) return { employeeId: null, conflict: false, reason: 'Le profil AVS correspondant ne contient pas la date de naissance lue; confirmez le rattachement manuellement.' };
      if (candidate.birthDate !== evidence.birthDate) return { employeeId: null, conflict: true, reason: 'Le numéro AVS correspond, mais la date de naissance diffère.' };
    }
    if (evidence.iban) {
      if (!isValidIban(evidence.iban)) return { employeeId: null, conflict: true, reason: 'L’IBAN confirmé par l’IA n’est pas valide.' };
      if (!candidate.iban) return { employeeId: null, conflict: false, reason: 'Le profil AVS correspondant ne contient pas l’IBAN lu; confirmez le rattachement manuellement.' };
      if (iban(evidence.iban) !== iban(candidate.iban)) return { employeeId: null, conflict: true, reason: 'Le numéro AVS correspond, mais l’IBAN diffère; contrôlez manuellement.' };
    }
    return { employeeId: candidate.id, conflict: false, reason: 'Rattachement automatique par numéro AVS valide, unique et cohérent avec les autres identifiants lus.' };
  }

  if (avsValue) return { employeeId: null, conflict: true, reason: avsIsValid ? 'Le numéro AVS valide du document ne correspond à aucun collaborateur existant.' : 'Le numéro AVS lu ne passe pas le contrôle suisse; rattachement manuel requis.' };

  if (!employeeNumber) return { employeeId: null, conflict: false, reason: 'Aucun identifiant fort concordant; choisissez le collaborateur.' };
  if (numberMatches.length !== 1) return { employeeId: null, conflict: numberMatches.length > 1, reason: numberMatches.length > 1 ? 'Le numéro employé n’est pas unique.' : 'Le numéro employé ne correspond à aucun collaborateur.' };

  const candidate = numberMatches[0];
  const birthSupplied = Boolean(evidence.birthDate) && isValidIsoCalendarDate(evidence.birthDate);
  const ibanSupplied = Boolean(evidence.iban) && isValidIban(evidence.iban);
  const birthMatches = birthSupplied && evidence.birthDate === candidate.birthDate;
  const ibanMatches = ibanSupplied && iban(evidence.iban) === iban(candidate.iban);
  if (birthSupplied && candidate.birthDate && !birthMatches) return { employeeId: null, conflict: true, reason: 'Le numéro employé correspond, mais la date de naissance diffère.' };
  if (ibanSupplied && candidate.iban && !ibanMatches) return { employeeId: null, conflict: true, reason: 'Le numéro employé correspond, mais l’IBAN diffère; contrôlez manuellement.' };
  if (!birthMatches && !ibanMatches) return { employeeId: null, conflict: false, reason: 'Le numéro employé doit être confirmé par la naissance ou un IBAN valide concordant.' };
  return { employeeId: candidate.id, conflict: false, reason: `Rattachement automatique par numéro employé et ${birthMatches ? 'date de naissance' : 'IBAN'} concordants.` };
}
