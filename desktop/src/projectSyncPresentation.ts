import type { ProjectSyncStatus } from './projectSync';

export function projectSyncPresentation(sync: ProjectSyncStatus, pending: number) {
  if (sync.mode === 'preparing') return {
    title: 'Partage du dossier à reprendre',
    description: sync.error || 'Vos documents restent sur cet appareil. Retrouvez le partage du dossier dans les réglages.',
    canSynchronize: false,
  };
  if (sync.mode === 'business') return {
    title: pending ? `${pending} modification${pending > 1 ? 's' : ''} en attente` : 'Documents du dossier partagé',
    description: sync.error || (pending
      ? 'Les modifications en attente et leurs fichiers sont conservés sur cet appareil.'
      : 'Ces documents sont confirmés dans le dossier partagé et restent disponibles hors ligne.'),
    canSynchronize: false,
  };
  return {
    title: sync.syncing ? 'Synchronisation…' : sync.error ? 'Synchronisation à reprendre' : pending ? `${pending} fichier${pending > 1 ? 's' : ''} à synchroniser`
      : sync.connected ? 'Fichiers synchronisés' : 'Fichiers sur cet appareil',
    description: sync.error || (sync.connected
      ? 'Les plans et photos de ce dossier restent accessibles hors ligne. Les changements sont partagés avec votre entreprise.'
      : 'Connectez ce poste à votre compte pour partager les documents de vos projets entre vos appareils et votre équipe.'),
    canSynchronize: Boolean(sync.connected || sync.organizationId),
  };
}
