import type { AppSettings } from './types';

export type ProjectTerminology = {
  singular: 'chantier' | 'dossier' | 'projet';
  plural: 'chantiers' | 'dossiers' | 'projets';
  singularTitle: 'Chantier' | 'Dossier' | 'Projet';
  pluralTitle: 'Chantiers' | 'Dossiers' | 'Projets';
  moduleLabel: 'Projets';
  icon: 'hard-hat' | 'folder';
};

export function projectTerminology(_section?: AppSettings['business']['nogaSection']): ProjectTerminology {
  return { singular: 'projet', plural: 'projets', singularTitle: 'Projet', pluralTitle: 'Projets', moduleLabel: 'Projets', icon: 'folder' };
}
