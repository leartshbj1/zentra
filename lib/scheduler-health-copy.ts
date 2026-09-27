import type { SchedulerHealth } from './scheduler-health';

export function schedulerHealthCopy(
  health?: Partial<SchedulerHealth> & { background: boolean },
) {
  switch (health?.state) {
    case 'current':
      return {
        title: 'Traitement serveur vérifié',
        detail: 'La réception continue lorsque Support est fermé.',
        attention: false,
      };
    case 'running':
      return health.background
        ? {
            title: 'Traitement serveur en cours',
            detail: 'La réception continue lorsque Support est fermé.',
            attention: false,
          }
        : {
            title: 'Premier traitement en cours',
            detail:
              'Gardez Support ouvert jusqu’à la confirmation du premier passage.',
            attention: true,
          };
    case 'failed':
      return {
        title: 'Un traitement serveur a échoué',
        detail:
          'Gardez Support ouvert pour permettre la réception. Si le problème persiste, contactez Zentra.',
        attention: true,
      };
    case 'delayed':
      return {
        title: 'La réception en arrière-plan a pris du retard',
        detail:
          'Gardez Support ouvert pour permettre la réception. Contactez Zentra si le retard persiste.',
        attention: true,
      };
    case 'unverified':
      return {
        title: 'Réception en arrière-plan à vérifier',
        detail:
          'Aucun passage terminé n’est confirmé. Gardez Support ouvert pour permettre la réception.',
        attention: true,
      };
    case 'unavailable':
      return {
        title: 'État du traitement indisponible',
        detail:
          'La vérification du serveur n’a pas abouti. Gardez Support ouvert ; l’état sera vérifié à nouveau au prochain chargement.',
        attention: true,
      };
    default:
      return health?.background
        ? {
            title: 'Réception en arrière-plan configurée',
            detail:
              'Consultez la dernière récupération dans les réglages de votre boîte.',
            attention: false,
          }
        : {
            title: 'Réception pendant l’ouverture de Support',
            detail:
              'Gardez votre espace ouvert. La réception lorsque la page est fermée n’est pas encore active.',
            attention: false,
          };
  }
}
