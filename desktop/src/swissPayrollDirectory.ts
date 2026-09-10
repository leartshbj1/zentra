import directory from './swissPayrollDirectory.json';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';

export type PayrollOrganisationKind =
  | 'avs'
  | 'family'
  | 'accident'
  | 'daily'
  | 'pension';
export type PayrollOrganisation = {
  id: string;
  number: string;
  name: string;
  kind: string;
  group: string;
  source: string;
  canton?: string;
  cantons?: string[];
  aliases?: string[];
};
export const PAYROLL_DIRECTORY_CHECKED_ON = directory.checkedOn;
export const PAYROLL_ORGANISATIONS: PayrollOrganisation[] = directory.entries;
export const PAYROLL_ORGANISATION_HELP: Record<
  PayrollOrganisationKind,
  { label: string; hint: string; source: string; scope: string }
> = {
  avs: {
    label: 'Caisse AVS',
    hint: 'Le nom figure sur votre courrier d’affiliation AVS.',
    source: 'https://www.ahv-iv.ch/fr/Contacts',
    scope:
      'Caisses cantonales, professionnelles et fédérales du répertoire AVS/AI.',
  },
  family: {
    label: 'Caisse d’allocations familiales',
    hint: 'Vérifiez votre affiliation CAF : ce n’est pas toujours le même nom que la caisse AVS.',
    source: 'https://www.bsv.admin.ch/fr/allocations-familiales-organisation',
    scope: 'Répertoire OFAS des caisses admises, état au 1er janvier 2026.',
  },
  accident: {
    label: 'Assurance accidents',
    hint: 'Recopiez l’assureur du contrat accidents de l’entreprise, par exemple Suva.',
    source:
      'https://www.bag.admin.ch/fr/lassurance-accidents-assureurs-et-surveillance',
    scope: 'Suva et assureurs LAA du registre OFSP du 1er juillet 2026.',
  },
  daily: {
    label: 'Assurance salaire en cas de maladie',
    hint: 'Il s’agit du contrat collectif perte de gain (IJM), pas de la caisse-maladie personnelle du salarié.',
    source: 'https://www.swissdec.ch/fr/data-receiver',
    scope:
      'Assureurs IJM publiés par Swissdec. Liste partielle, saisie libre possible.',
  },
  pension: {
    label: 'Caisse de pension',
    hint: 'Le nom exact de la fondation figure sur le certificat de prévoyance du salarié.',
    source: 'https://www.swissdec.ch/fr/data-receiver',
    scope:
      'Fondations de prévoyance publiées par Swissdec. Liste partielle, saisie libre possible.',
  },
};
export function normaliseOrganisationSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-CH')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export function findPayrollOrganisations(
  kind: PayrollOrganisationKind,
  query: string,
  canton = '',
) {
  const words = normaliseOrganisationSearch(query).split(' ').filter(Boolean);
  const searchText = (entry: PayrollOrganisation) =>
    normaliseOrganisationSearch(
      `${entry.name} ${(entry.aliases ?? []).join(' ')} ${entry.number} ${entry.canton ?? ''} ${(entry.cantons ?? []).join(' ')} ${SWISS_FAMILY_ALLOWANCES_2026.filter(
        (item) =>
          entry.canton === item.canton || entry.cantons?.includes(item.canton),
      )
        .map((item) => item.name)
        .join(' ')}`,
    );
  return PAYROLL_ORGANISATIONS.filter(
    (entry) =>
      entry.kind === kind &&
      words.every((word) => searchText(entry).includes(word)),
  ).sort(
    (a, b) =>
      Number(Boolean(b.canton === canton || b.cantons?.includes(canton))) -
        Number(Boolean(a.canton === canton || a.cantons?.includes(canton))) ||
      a.name.localeCompare(b.name, 'fr-CH'),
  );
}
