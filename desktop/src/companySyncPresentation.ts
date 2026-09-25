import type { CompanySyncState } from './companySync';

export function companySyncPresentation(status: CompanySyncState & { error?: string; receiving?: boolean; checkedAt?: number }, organizationId: string, online: boolean, now = Date.now()) {
  if (!online) return { kind: 'offline', label: 'Hors ligne', detail: 'Vos modifications restent sur cet appareil et seront envoyées au retour du réseau.' };
  // An old company's status must never imply that the newly selected space is synchronized.
  if (!status.enabled || status.organizationId !== organizationId) return { kind: 'checking', label: 'Connexion…', detail: 'Connexion à cet espace en cours.' };
  if (status.conflict) return { kind: 'attention', label: 'À vérifier', detail: 'Un document nécessite votre choix. Ouvrir Compte et accès.' };
  if (status.error) return { kind: 'attention', label: 'Connexion à vérifier', detail: 'La synchronisation réessaie automatiquement. Ouvrir Compte et accès pour vérifier la connexion.' };
  if (status.pending) return { kind: 'sending', label: 'Envoi en cours', detail: 'Vos modifications sont envoyées à votre équipe en arrière-plan.' };
  if (status.receiving || status.ready) return { kind: 'receiving', label: 'Réception en cours', detail: 'Les nouveautés arrivent en arrière-plan. Votre saisie reste ouverte.' };
  // A quiet company can have an old last write but a fresh successful check.
  // The healthy realtime scheduler reconciles every minute; allow its request to finish.
  const synced = status.checkedAt ?? Date.parse(status.lastSyncedAt || '');
  if (!Number.isFinite(synced) || now - synced > 90_000 || synced > now + 5_000) return { kind: 'checking', label: 'Vérification…', detail: 'Vérification automatique des nouveautés de votre équipe.' };
  return { kind: 'current', label: 'À jour', detail: 'Votre espace est à jour avec votre équipe.' };
}
