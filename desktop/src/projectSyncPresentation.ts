import type { ProjectSyncStatus } from './projectSync';
import { t } from './language';

export function projectFileSyncIssue(message: string) {
  if (/copie locale|justificatif local|empreinte différente|erreur de fichier local/i.test(message)) return {
    title: t('Copie locale à réparer'),
    explanation: t('Ajoutez à nouveau le fichier original dans ce projet. Si son contenu est identique, Zentra répare la copie en gardant le même document. Un fichier différent sera ajouté séparément.'),
    repair: true,
  };
  if (/hors ligne|connexion|service indisponible|réseau/i.test(message)) return {
    title: t('Envoi à reprendre'), explanation: t('La connexion a été interrompue. Zentra réessaiera automatiquement au retour du réseau. Vous pouvez aussi utiliser Synchroniser.'), repair: false,
  };
  return { title: t('Synchronisation à reprendre'), explanation: t(message.replace(/^(Champ invalide|Enregistrement introuvable)\s*:\s*/i, '')), repair: false };
}

export function projectSyncPresentation(sync: ProjectSyncStatus, pending: number) {
  if (sync.mode === 'preparing') return {
    title: t('Partage du dossier à reprendre'),
    description: t(sync.error || 'Vos documents restent sur cet appareil. Retrouvez le partage du dossier dans les réglages.'),
    canSynchronize: false,
  };
  if (sync.mode === 'business') return {
    title: pending ? t(pending === 1 ? '{count} modification en attente' : '{count} modifications en attente', { count: pending }) : t('Documents du dossier partagé'),
    description: t(sync.error || (pending
      ? 'Les modifications en attente et leurs fichiers sont conservés sur cet appareil.'
      : 'Ces documents sont confirmés dans le dossier partagé et restent disponibles hors ligne.')),
    canSynchronize: false,
  };
  return {
    title: sync.syncing ? t('Synchronisation…') : sync.error ? t('Synchronisation à reprendre') : pending ? t(pending === 1 ? '{count} fichier à synchroniser' : '{count} fichiers à synchroniser', { count: pending })
      : t(sync.connected ? 'Fichiers synchronisés' : 'Fichiers sur cet appareil'),
    description: t(sync.error || (sync.connected
      ? 'Les plans et photos de ce dossier restent accessibles hors ligne. Les changements sont partagés avec votre entreprise.'
      : 'Connectez ce poste à votre compte pour partager les documents de vos projets entre vos appareils et votre équipe.')),
    canSynchronize: Boolean(sync.connected || sync.organizationId),
  };
}
