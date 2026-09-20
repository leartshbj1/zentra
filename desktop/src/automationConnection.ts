export type AutomationProblem = 'offline' | 'session' | 'company_mismatch' | 'company_unlinked' | 'service';

/** Only display known guidance, never a raw server response or a protected token. */
export function automationProblem(reason: unknown, online = true): AutomationProblem {
  const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  if (text.includes('[automation:company_mismatch]')) return 'company_mismatch';
  if (text.includes('[automation:company_unlinked]') || text.includes('Connectez et partagez cette entreprise')) return 'company_unlinked';
  if (/session.*(expir|révoqu)|[Rr]econnectez votre compte|Connectez votre compte|connexion a changé/.test(text)) return 'session';
  return online ? 'service' : 'offline';
}

export const automationConnectionMessages = {
  offline: { title: 'Connexion Internet interrompue', body: 'Automation reprendra dès le retour du réseau. Vos données restent disponibles.', account: false },
  session: { title: 'Reconnectez votre compte', body: 'La connexion au compte Zentra doit être renouvelée dans Compte et équipe.', account: true },
  company_mismatch: { title: 'Le compte et l’entreprise ne correspondent pas', body: 'Le compte connecté appartient à une autre entreprise. Ouvrez Compte et équipe pour rétablir le bon lien. Vos données sont conservées.', account: true },
  company_unlinked: { title: 'Reliez cette entreprise', body: 'Dans Compte et équipe, activez le partage de cette entreprise pour retrouver Automation.', account: true },
  service: { title: 'Automation est momentanément indisponible', body: 'Les réglages n’ont pas pu être chargés. Réessayez dans un instant ; ce message ne signifie pas que votre connexion Internet est coupée.', account: false },
} as const;
