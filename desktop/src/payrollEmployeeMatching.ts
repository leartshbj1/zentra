import type { Employee, PayrollAiIdentityEvidence, PayrollImportEmployeeDraft } from './types';
import { isValidIban, isValidIsoCalendarDate, isValidSwissAvsNumber } from './payrollImportQuality';

export type PayrollEmployeeMatch = {
  employeeId: string | null;
  conflict: boolean;
  reason: string;
};

export type PayrollEmployeeDuplicateRisk = {
  employeeIds: string[];
  reason: string;
  signal: 'avs' | 'employee_number' | 'name_birth_date' | 'name_iban' | null;
};

const digits = (value: string) => value.replace(/\D/g, '');
const compactAsciiIdentifier = (value: string) => value
  .trim()
  .toLocaleLowerCase('fr-CH')
  .replace(/[^a-z0-9]/g, '');
const compactPersonName = (value: string) => value
  .trim()
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .toLocaleLowerCase('fr-CH')
  .replace(/[^\p{L}\p{N}]/gu, '');
const iban = (value: string) => value.replace(/\s/g, '').toUpperCase();

export function findStrongEmployeeMatch(evidence: PayrollAiIdentityEvidence, employees: Employee[]): PayrollEmployeeMatch {
  if (evidence.passes < 2) return { employeeId: null, conflict: false, reason: 'Une seule lecture exploitable : rattachement manuel requis.' };
  if (evidence.conflicts.length) return { employeeId: null, conflict: true, reason: `Identité contradictoire entre les deux lectures (${evidence.conflicts.join(', ')}).` };

  const avsValue = digits(evidence.avsNumber);
  const employeeNumber = compactAsciiIdentifier(evidence.employeeNumber);
  const avsIsValid = Boolean(avsValue) && isValidSwissAvsNumber(evidence.avsNumber);
  const avsMatches = avsIsValid
    ? employees.filter((employee) => digits(employee.avsNumber) === avsValue)
    : [];
  const numberMatches = employeeNumber
    ? employees.filter((employee) => compactAsciiIdentifier(employee.employeeNumber) === employeeNumber)
    : [];

  if (avsMatches.length > 1) return { employeeId: null, conflict: true, reason: 'Le même numéro AVS existe sur plusieurs collaborateurs; corrigez les profils avant le rattachement.' };
  if (avsMatches.length === 1) {
    const candidate = avsMatches[0];
    if (employeeNumber && compactAsciiIdentifier(candidate.employeeNumber) !== employeeNumber) return { employeeId: null, conflict: true, reason: 'Le numéro AVS correspond, mais le numéro employé du document ne correspond pas au même profil.' };
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

/**
 * Empêche la création accidentelle d'un second profil lorsque le document ne
 * contient pas d'AVS ou de numéro employé. Un nom seul ne suffit jamais : il
 * doit être accompagné de la même naissance ou d'un IBAN valide concordant.
 * La fonction ne rattache rien automatiquement; elle force un choix humain.
 */
export function findPotentialPayrollEmployeeDuplicate(
  imported: PayrollImportEmployeeDraft,
  employees: Employee[],
): PayrollEmployeeDuplicateRisk {
  const importedAvs = digits(imported.avsNumber);
  const importedNumber = compactAsciiIdentifier(imported.employeeNumber);
  const importedName = compactPersonName(imported.name);
  const importedBirth = isValidIsoCalendarDate(imported.birthDate) ? imported.birthDate : '';
  const importedIban = isValidIban(imported.iban) ? iban(imported.iban) : '';

  const match = (
    signal: Exclude<PayrollEmployeeDuplicateRisk['signal'], null>,
    predicate: (employee: Employee) => boolean,
    reason: (names: string) => string,
  ): PayrollEmployeeDuplicateRisk | null => {
    const candidates = employees.filter(predicate);
    if (!candidates.length) return null;
    const names = candidates.slice(0, 3).map((employee) => employee.name).join(', ');
    return {
      employeeIds: candidates.map((employee) => employee.id),
      signal,
      reason: reason(names),
    };
  };

  if (importedAvs) {
    const risk = match(
      'avs',
      (employee) => digits(employee.avsNumber) === importedAvs,
      (names) => `${names} possède déjà ce numéro AVS.`,
    );
    if (risk) return risk;
  }
  if (importedNumber) {
    const risk = match(
      'employee_number',
      (employee) => compactAsciiIdentifier(employee.employeeNumber) === importedNumber,
      (names) => `${names} possède déjà ce numéro employé.`,
    );
    if (risk) return risk;
  }
  if (importedName && importedBirth) {
    const risk = match(
      'name_birth_date',
      (employee) => compactPersonName(employee.name) === importedName && employee.birthDate === importedBirth,
      (names) => `${names} possède déjà le même nom et la même date de naissance.`,
    );
    if (risk) return risk;
  }
  if (importedName && importedIban) {
    const risk = match(
      'name_iban',
      (employee) => compactPersonName(employee.name) === importedName && iban(employee.iban) === importedIban,
      (names) => `${names} possède déjà le même nom et le même IBAN.`,
    );
    if (risk) return risk;
  }
  return { employeeIds: [], reason: '', signal: null };
}
