# Connexion au compte et disponibilité d’Automation

Optimisations ajoutées après la version 1.85.1. Code vérifié localement ; ce document ne constitue pas une preuve de publication ou d’installation.

## Parcours examiné

Amorçage Tauri → session protégée et licence signée → résolution de l’entreprise → WorkspaceApp → fournisseur d’état Automation → API et accès par entreprise → activité et règles. Le panneau Compte et son retour d’autorisation ont aussi été suivis jusqu’à App. Le graphe JavaScript compilé a été vérifié pour les modules différés.

## Corrections supplémentaires

- Le panneau Compte affiche la session protégée locale, puis vérifie le serveur en arrière-plan. Une réponse révoquée remplace cette identité ; le cache d’affichage n’accorde aucun droit supplémentaire.
- Une autorisation ou une vérification native déjà terminée relit directement la licence signée. Elle ne redemande plus `/api/account/me` avant de prendre en compte la licence. Un changement de rôle déclenche toujours son renouvellement.
- Les demandes d’état Automation en cours sont regroupées par entreprise. Un changement d’espace n’attend plus la réponse de l’ancien espace avant de lancer sa propre demande. Les réponses ne sont pas mises en cache après leur résolution ; la vérification native de session et d’entreprise reste obligatoire.
- Le serveur lit d’abord l’offre Automation déjà liée. Dans le scénario d’offre manuelle testé, cette vérification utilise trois lectures fraîches, au lieu de six. La découverte d’identité est réservée aux offres valides qui restent à relier. Les contrôles d’expiration, de révocation et d’accès Gestion restent exécutés.

La fréquence et le contenu des échanges de synchronisation métier ne changent pas. La première connexion et le premier téléchargement d’une entreprise restent dépendants du réseau. Aucun achat, abonnement ou accès réel n’a été modifié par les tests.

## Vérifications du 24 septembre 2026

- 56 tests natifs/frontend ciblés et 101 tests serveur ciblés : connexion locale, panne réseau, autorisation, rôle réduit, révocation, changement d’entreprise, licences, facturation Automation, offres et workflows.
- Vérification TypeScript des deux projets et compilation du frontend réussies.
- Parcours Playwright du vrai composant App, données fictives, `/me` retardé volontairement de 10 secondes : bureau 1 440 px, espace à 452 ms, Automation à 477 ms, panneau Compte à 38 ms ; mobile 390 px, respectivement 439 ms, 457 ms et 40 ms. Aucune erreur JavaScript ni nouvel écran bloquant après revalidation.
- Deux lectures réseau pendant ce parcours : une à l’ouverture de l’app, une à l’ouverture explicite du panneau Compte ; aucune troisième lecture déclenchée par son retour.
- Graphe de production : 141 fichiers locaux vérifiés. Paie détaillée, éditeur de documents, achats, catalogue, personnalisation, planification et certificats restent différés. Ces mesures ne sont pas un essai de démarrage à froid sur iPhone ou Mac physique.

Preuves locales : `outputs/startup-account-optimization.json`, `outputs/startup-optimization-build.log`. Le code applicatif et le correctif serveur doivent être inclus dans leurs prochaines publications respectives pour bénéficier aux installations clientes.
