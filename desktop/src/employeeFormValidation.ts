export type EmployeeFieldIssue = { field: string; message: string };

/** Explain the existing employee constraints before sending the whole form. */
export function employeeFormIssue(form: FormData, section: 'work' | 'all', newEmployee = false): EmployeeFieldIssue | null {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  const start = text('employmentStart'), end = text('employmentEnd');
  if (text('employmentContractKind') === 'fixed' && (!start || !end)) return {
    field: !start ? 'employmentStart' : 'employmentEnd',
    message: `Vous avez choisi un contrat à durée déterminée. Recopiez sa date de ${!start ? 'début' : 'fin'} sur le contrat de travail.`,
  };
  if (start && end && end < start) return { field: 'employmentEnd', message: 'La fin du contrat est avant son début. Vérifiez les deux dates sur le contrat de travail.' };
  if (section === 'work') return null;
  for (const [year, amount, document] of [
    ['lppAssessmentYear', 'lppAnnualSalary', 'le document de votre caisse de pension'],
    ['acOpeningYear', 'acOpeningBasis', 'le dernier décompte de salaire avant Zentra'],
    ['laaOpeningYear', 'laaOpeningBasis', 'le dernier décompte de salaire avant Zentra'],
  ]) {
    if (Boolean(text(year)) !== Boolean(text(amount))) return {
      field: text(year) ? amount : year,
      message: text(year)
        ? `Il manque le montant pour ${text(year)}. Recopiez-le depuis ${document}.${newEmployee ? ' Pour compléter plus tard, laissez l’année et le montant vides.' : ''}`
        : `Il manque l’année de ce montant. Recopiez-la depuis ${document}.${newEmployee ? ' Pour compléter plus tard, laissez l’année et le montant vides.' : ''}`,
    };
  }
  if (!text('lppExceptionCode') && text('lppExceptionEvidenceReference')) return { field: 'lppExceptionCode', message: 'Une preuve est renseignée : choisissez l’exception qu’elle confirme. Sans exception, retirez aussi sa référence.' };
  if (text('lppExceptionCode') && !text('lppExceptionEvidenceReference')) return { field: 'lppExceptionEvidenceReference', message: 'Indiquez le nom ou la référence du document qui confirme cette exception : contrat signé ou confirmation écrite de la caisse de pension.' };
  if (text('lppExceptionCode') === 'short_fixed_contract' && text('employmentContractKind') !== 'fixed') return { field: 'employmentContractKind', message: 'L’exception de pension choisie concerne un contrat court à durée déterminée. Vérifiez le type de contrat à l’étape Le travail, ou corrigez l’exception dans les réglages de paie.' };
  if (text('referenceAgeDate') && text('birthDate') && text('referenceAgeDate') <= text('birthDate')) return { field: 'referenceAgeDate', message: 'La date de l’âge de référence doit être après la naissance. Recopiez la date confirmée sur le document de la caisse AVS.' };
  return null;
}

/** Route only recognized native employee fields; unrelated errors keep their own message. */
export function employeeNativeFieldIssue(message: string): EmployeeFieldIssue | null {
  const value = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\biban\b/.test(value)) return { field: 'iban', message: 'Vérifiez l’IBAN sur les coordonnées bancaires du collaborateur. Recopiez le numéro complet, avec ses lettres et ses chiffres.' };
  if (/social_security_number|numero avs/.test(value)) return { field: 'avsNumber', message: 'Vérifiez le numéro AVS sur la carte d’assurance ou un décompte officiel du collaborateur. Recopiez ses 13 chiffres, sans en inventer.' };
  if (/birth_date|date de naissance/.test(value)) return { field: 'birthDate', message: 'Vérifiez la date de naissance du collaborateur et sélectionnez-la dans le calendrier.' };
  if (/employment_end_date|fin du contrat precede/.test(value)) return { field: 'employmentEnd', message: 'Vérifiez la date de fin du contrat. Elle ne peut pas précéder la date de début.' };
  return null;
}
