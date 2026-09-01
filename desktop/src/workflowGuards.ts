export type CreationView = 'projects' | 'catalog' | 'quotes' | 'invoices' | 'time' | 'team' | 'expenses';

export type WorkspacePrerequisites = {
  clients: number;
  projects: number;
  trackableProjects: number;
  activeEmployees: number;
  activeSuppliers: number;
  costCategories: number;
};

export function creationBlockReason(view: CreationView, prerequisites: WorkspacePrerequisites): string {
  if (view === 'projects' && prerequisites.clients === 0) return 'Ajoutez d’abord un client.';
  if ((view === 'quotes' || view === 'invoices') && prerequisites.clients === 0) return 'Ajoutez d’abord un client.';
  if (view === 'time') {
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
