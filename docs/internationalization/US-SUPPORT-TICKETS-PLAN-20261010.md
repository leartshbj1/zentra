# H3b — tickets Support US, corrections et affectations

Base : `412fdc0`. Développement local incrémental ; l'objectif ERP international reste ouvert. Aucun changement du site CH publié, des données hébergées, des abonnements existants ou des applications natives.

## Contrat de la verticale

- Transformer une classification H3a **durablement terminée** en un ticket partagé, une seule fois par source dans la même entreprise et le même espace Support. La décision et sa provenance proviennent des tables privées H3a, jamais d'un résultat envoyé par le navigateur.
- Conserver la catégorie/priorité initiales et leurs motifs de vérification. Les corrections humaines, affectations et changements de statut constituent des révisions tracées, sans réécrire la décision du modèle.
- Les propriétaires et administrateurs gèrent les règles par catégorie, corrigent et affectent. Un membre peut faire avancer uniquement son ticket attribué. Comptables et lecteurs consultent la projection des tickets, sans accès nouveau au texte des e-mails ni aux secrets.
- Une règle ne peut viser qu'un propriétaire, administrateur ou membre actif de la même entreprise. La destination est vérifiée à l'application, même si elle était valide à l'enregistrement. Aucun identifiant de groupe externe n'est assimilé à une appartenance Zentra.
- L'affectation automatique applique uniquement une règle explicite à une analyse sans motif de vérification. Une analyse incertaine, une cible révoquée ou une règle absente restent à examiner. Aucune réponse, opération comptable, création fournisseur ou rendez-vous ne découle de cette affectation.
- Les commandes utilisent un identifiant idempotent, une révision attendue et un reçu durable. Une demande dont le résultat est incertain est reprise à l'identique ; un rafraîchissement ne l'acquitte pas et ne remplace pas un brouillon.

## Données et limites

H3a ne conserve pas l'objet ni le corps du message. Le ticket présente donc le numéro de message, la date de création du ticket, les catégories et le suivi ; il ne prétend pas contenir le message complet. Toute future conservation de contenu devra avoir son consentement, sa rétention et ses permissions propres. Les identifiants privés de boîte et les credentials ne font pas partie de la projection publique.

Le registre H1 et les droits SaaS US courants restent requis pour chaque lecture et écriture. Une gate distincte `INTERNATIONAL_US_SUPPORT_TICKETS_ENABLED`, fermée par défaut, protège cette verticale ; consulter son historique ne nécessite pas une boîte encore connectée. Les sessions natives doivent annoncer le protocole 4. Auth, révocation, changement de rôle et fermeture de gate sont recontrôlés après les opérations asynchrones.

## Réalisation et validation

1. Contrats typés et validés, schéma D1 additif versionné, store avec CAS, journal et protections contre les écritures directes incohérentes.
2. Handlers HTTP privés et raccordement optionnel à la fin/reprise H3a. Aucun nouvel appel au modèle pour corriger ou affecter.
3. Interface compacte de suivi, règles séparées, quatre langues et thèmes existants, actualisation discrète et purge sur perte d'accès.
4. Tests SQLite/D1 et chaîne workerd, HTTP avec vrai store local, transports/brouillons, rôles, isolation, révocations, doublons, reprises et régressions CH/US pertinentes. TypeScript, lint ciblé et build.
5. Inspection navigateur groupée desktop/mobile, correction groupée des défauts observés, puis au plus une confirmation. Livraison avec les huit rubriques demandées et preuves exactes.

## Retour arrière et production

La migration est proposée et appliquée seulement aux bases locales fictives. En cas de retour arrière applicatif, fermer la gate et garder l'historique ; ne pas supprimer les nouveaux tickets ou révisions. La suppression des tables n'est pas un rollback de production autorisé. Réception autonome, délégations worker, contenu intégral, routage vers des prestataires externes et staging multi-appareils restent des verticales ultérieures.
