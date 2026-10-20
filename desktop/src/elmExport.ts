// Structure Swissdec ELM (déclaration de salaires) préparée à partir des
// fiches de l'année : société, personnes, périodes et revenus AVS/AC. C'est une
// structure de préparation, non certifiée Swissdec et non transmise.
import type { Employee, Payslip, Workspace } from './types';
import { payslipTotals } from './utils';

const NAMESPACE = 'http://www.swissdec.ch/schema/sd/20200220/SalaryDeclaration';

export function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const amount = (cents: number) => (cents / 100).toFixed(2);

/** « Marc Rochat » → prénom « Marc », nom « Rochat » (dernier mot). */
export function splitName(name: string): { firstname: string; lastname: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstname: '', lastname: parts[0] ?? '' };
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts[parts.length - 1] };
}

export type ElmPerson = { employee: Employee; from: string; until: string; grossCents: number; slips: number };

/** Revenus de l'année par personne (fiches validées, comptabilisées ou payées). */
export function elmPersons(employees: readonly Employee[], payslips: readonly Payslip[], year: number): ElmPerson[] {
  const persons: ElmPerson[] = [];
  for (const employee of employees) {
    const slips = payslips.filter((slip) => slip.employeeId === employee.id && slip.period.startsWith(`${year}-`) && ['validated', 'posted', 'paid'].includes(slip.status));
    if (!slips.length) continue;
    const periods = slips.map((slip) => slip.period).sort();
    const first = periods[0], last = periods[periods.length - 1];
    const lastDay = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).getUTCDate();
    persons.push({ employee, from: `${first}-01`, until: `${last}-${String(lastDay).padStart(2, '0')}`, grossCents: slips.reduce((sum, slip) => sum + payslipTotals(slip).earnings, 0), slips: slips.length });
  }
  return persons;
}

export function elmIssues(persons: readonly ElmPerson[], workspace: Pick<Workspace, 'settings'>): string[] {
  const issues: string[] = [];
  const org = workspace.settings?.organization;
  if (!org?.uidNumber) issues.push('Numéro IDE de l’entreprise manquant');
  for (const person of persons) {
    if (!/^756\.?\d{4}\.?\d{4}\.?\d{2}$/.test(person.employee.avsNumber ?? '')) issues.push(`Numéro AVS manquant ou invalide : ${person.employee.name}`);
    if (!person.employee.birthDate) issues.push(`Date de naissance manquante : ${person.employee.name}`);
  }
  return issues;
}

export function elmXml(workspace: Pick<Workspace, 'settings'>, persons: readonly ElmPerson[], year: number, createdOn: string): string {
  const org = workspace.settings?.organization;
  const uid = (org?.uidNumber ?? '').replace(/\D/g, '');
  const tag = (name: string, value: string) => (value ? `<${name}>${xmlText(value)}</${name}>` : '');
  const staff = persons.map((person) => {
    const { firstname, lastname } = splitName(person.employee.name);
    return [
      '      <Person>',
      '        <Particulars>',
      `          <Social-InsuranceIdentification>${tag('SV-AS-Number', (person.employee.avsNumber ?? '').replace(/\D/g, '').replace(/^(\d{3})(\d{4})(\d{4})(\d{2})$/, '$1.$2.$3.$4'))}</Social-InsuranceIdentification>`,
      `          ${tag('Lastname', lastname)}${tag('Firstname', firstname)}${tag('DateOfBirth', person.employee.birthDate ?? '')}`,
      '        </Particulars>',
      `        <Work>${tag('EntryDate', person.employee.employmentStart || person.from)}${tag('LeavingDate', person.employee.employmentEnd ?? '')}</Work>`,
      '        <AHV-AVS-Salaries>',
      `          <AHV-AVS-Salary><AccountingTime><from>${person.from}</from><until>${person.until}</until></AccountingTime><AHV-AVS-Income>${amount(person.grossCents)}</AHV-AVS-Income><ALV-AC-Income>${amount(person.grossCents)}</ALV-AC-Income></AHV-AVS-Salary>`,
      '        </AHV-AVS-Salaries>',
      '      </Person>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Structure de préparation Swissdec ELM générée par Zentra : non certifiée, non transmise. Revenus AVS/AC = salaire brut des fiches de l\'année, à contrôler. -->',
    `<SalaryDeclaration xmlns="${NAMESPACE}" schemaVersion="5.0">`,
    '  <Company>',
    '    <CompanyDescription>',
    `      <Name>${tag('HR-RC-Name', org?.legalName ?? '')}</Name>`,
    `      <Address>${tag('Street', [org?.address.street, org?.address.buildingNumber].filter(Boolean).join(' '))}${tag('ZIP-Code', org?.address.postalCode ?? '')}${tag('City', org?.address.city ?? '')}</Address>`,
    uid.length === 9 ? `      <UID-BFS><UID-Organisation-Id-Categorie>CHE</UID-Organisation-Id-Categorie><UID-Organisation-Id>${uid}</UID-Organisation-Id></UID-BFS>` : '',
    '    </CompanyDescription>',
    '    <Staff>',
    ...staff,
    '    </Staff>',
    '  </Company>',
    `  <GeneralSalaryDeclarationDescription><CreationDate>${createdOn}</CreationDate><AccountingPeriod>${year}</AccountingPeriod></GeneralSalaryDeclarationDescription>`,
    '</SalaryDeclaration>',
    '',
  ].filter((line) => line !== '').join('\n');
}
