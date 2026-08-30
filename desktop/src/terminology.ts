import type { AppSettings, NogaSectionCode } from './types';

export type ProjectTerminology = {
  singular: 'chantier' | 'dossier' | 'projet';
  plural: 'chantiers' | 'dossiers' | 'projets';
  singularTitle: 'Chantier' | 'Dossier' | 'Projet';
  pluralTitle: 'Chantiers' | 'Dossiers' | 'Projets';
  moduleLabel: 'Chantiers / projets';
  icon: 'hard-hat' | 'folder';
};

const dossierSections = new Set<NogaSectionCode>(['N', 'P', 'Q', 'R', 'T', 'U', 'V']);

export function projectTerminology(section: AppSettings['business']['nogaSection']): ProjectTerminology {
  if (section === 'F') {
    return { singular: 'chantier', plural: 'chantiers', singularTitle: 'Chantier', pluralTitle: 'Chantiers', moduleLabel: 'Chantiers / projets', icon: 'hard-hat' };
  }
  if (section && dossierSections.has(section)) {
    return { singular: 'dossier', plural: 'dossiers', singularTitle: 'Dossier', pluralTitle: 'Dossiers', moduleLabel: 'Chantiers / projets', icon: 'folder' };
  }
  return { singular: 'projet', plural: 'projets', singularTitle: 'Projet', pluralTitle: 'Projets', moduleLabel: 'Chantiers / projets', icon: 'folder' };
}
