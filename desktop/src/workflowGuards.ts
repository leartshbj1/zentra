export type CreationView = 'projects' | 'catalog' | 'quotes' | 'invoices' | 'time' | 'team' | 'expenses';

export type WorkspacePrerequisites = {
  clients: number;
  projects: number;
  trackableProjects: number;
  activeEmployees: number;
  activeSuppliers: number;
  costCategories: number;
  billingSetupDeferred?: boolean;
  workSetupDeferred?: boolean;
};

export function creationBlockReason(view: CreationView, prerequisites: WorkspacePrerequisites): string {
  if (view === 'projects' && prerequisites.clients === 0) return 'Ajoutez d’abord un client.';
  if (view === 'quotes' || view === 'invoices') {
    if (prerequisites.billingSetupDeferred)
      return 'Confirmez d’abord les réglages de facturation dans Paramètres.';
  }
  if (view === 'time') {
    if (prerequisites.workSetupDeferred)
      return 'Confirmez d’abord les règles de temps et de coûts dans Paramètres.';
    if (prerequisites.trackableProjects === 0 && prerequisites.activeEmployees === 0) return 'Ajoutez d’abord un projet non clôturé et un collaborateur actif.';
    if (prerequisites.trackableProjects === 0) return 'Ajoutez ou rouvrez d’abord un projet non clôturé.';
    if (prerequisites.activeEmployees === 0) return 'Ajoutez d’abord un collaborateur actif.';
  }
  if (view === 'expenses') {
    if (prerequisites.activeSuppliers === 0) return 'Ajoutez d’abord un fournisseur actif.';
    if (prerequisites.costCategories === 0) return 'Ajoutez d’abord une catégorie de coûts dans Paramètres.';
  }
  return '';
}

export function timerBlockReason(prerequisites: WorkspacePrerequisites, timerActive: boolean): string {
  if (timerActive) return 'Un pointage est déjà en cours.';
  return creationBlockReason('time', prerequisites);
}

export type CreationHelpTarget = 'client' | 'projects' | 'employee' | 'supplier' | 'billing' | 'work';

/** Follow the same order as the guards: resolve one prerequisite at a time. */
export function creationHelp(view: CreationView, prerequisites: WorkspacePrerequisites): { target: CreationHelpTarget; label: string } | null {
  if (!creationBlockReason(view, prerequisites)) return null;
  if (view === 'projects') return { target: 'client', label: 'Ajouter le client' };
  if (view === 'quotes' || view === 'invoices') return { target: 'billing', label: 'Compléter la facturation' };
  if (view === 'time') {
    if (prerequisites.workSetupDeferred) return { target: 'work', label: 'Compléter les règles de temps' };
    if (!prerequisites.trackableProjects) return { target: 'projects', label: 'Ouvrir les projets' };
    return { target: 'employee', label: 'Ajouter le collaborateur' };
  }
  if (view === 'expenses') {
    if (!prerequisites.activeSuppliers) return { target: 'supplier', label: 'Ajouter le fournisseur' };
    return { target: 'work', label: 'Compléter les catégories de coûts' };
  }
  return null;
}
