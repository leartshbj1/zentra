import type { CompanySyncState } from './companySync';

export type CompanySyncHealth = CompanySyncState & { error?: string; receiving?: boolean; checkedAt?: number; checkingSince?: number; settingsDraft?: boolean };

export function validCompanySyncTime(value: string | number | undefined, now = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 5_000 ? timestamp : undefined;
}

export function companySyncPresentation(status: CompanySyncHealth, organizationId: string, online: boolean, now = Date.now()) {
  if (!online) return { kind: 'offline', label: 'Hors ligne', detail: 'Vos modifications restent sur cet appareil et seront envoyées au retour du réseau.' };
  // An old company's status must never imply that the newly selected space is synchronized.
  if (!status.enabled || status.organizationId !== organizationId) return { kind: 'checking', label: 'Connexion…', detail: 'Connexion à cet espace en cours.' };
  if (status.conflict) return { kind: 'attention', label: 'À vérifier', detail: 'Un document nécessite votre choix. Ouvrir Compte et accès.' };
  if (status.error) return { kind: 'attention', label: 'Connexion à vérifier', detail: 'La synchronisation réessaie automatiquement. Ouvrir Compte et accès pour vérifier la connexion.' };
  const verifiedAt = validCompanySyncTime(status.checkedAt, now);
  const checkingSince = validCompanySyncTime(status.checkingSince, now);
  const waitingSince = verifiedAt ?? checkingSince;
  if (!status.receiving && !status.ready && waitingSince !== undefined && now - waitingSince > 90_000) return {
    kind: 'delayed', label: 'Synchronisation retardée',
    detail: 'Le serveur n’a pas confirmé de vérification récente. Vos données restent sur cet appareil ; la synchronisation réessaie automatiquement.',
  };
  if (status.pending) return { kind: 'sending', label: 'Envoi en cours', detail: 'Vos modifications sont envoyées à votre équipe en arrière-plan.' };
  if (status.receiving) return { kind: 'receiving', label: 'Réception en cours', detail: 'Les nouveautés arrivent en arrière-plan. Votre saisie reste ouverte.' };
  if (status.ready) return { kind: 'waiting', label: 'Nouveautés en attente', detail: status.settingsDraft
    ? 'Enregistrez vos modifications, puis quittez les paramètres pour recevoir les nouveautés de votre équipe.'
    : 'Terminez votre saisie ou fermez la fenêtre ouverte pour afficher les nouveautés de votre équipe.' };
  // A quiet company can have an old last write but a fresh successful check.
  // The healthy realtime scheduler reconciles every minute; allow its request to finish.
  const synced = verifiedAt ?? validCompanySyncTime(status.lastSyncedAt, now);
  if (synced === undefined || now - synced > 90_000) return { kind: 'checking', label: 'Vérification…', detail: 'Vérification automatique des nouveautés de votre équipe.' };
  return { kind: 'current', label: 'À jour', detail: 'Votre espace est à jour avec votre équipe.' };
}
