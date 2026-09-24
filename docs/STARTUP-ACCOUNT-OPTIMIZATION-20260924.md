# Connexion au compte et disponibilité d’Automation

Optimisations ajoutées après la version 1.85.1. Correctifs serveur publiés dans la version Sites 252 le 24 septembre 2026 ; correctifs de l’application compilés dans le candidat Windows 1.86.0 et vérifiés localement, sans nouvel installateur publié à ce stade.

## Parcours examiné

Amorçage Tauri → session protégée et licence signée → résolution de l’entreprise → WorkspaceApp → fournisseur d’état Automation → API et accès par entreprise → activité et règles. Le panneau Compte et son retour d’autorisation ont aussi été suivis jusqu’à App. Le graphe JavaScript compilé a été vérifié pour les modules différés.

## Corrections supplémentaires

- Le panneau Compte affiche la session protégée locale, puis vérifie le serveur en arrière-plan. Une réponse révoquée remplace cette identité ; le cache d’affichage n’accorde aucun droit supplémentaire.
- L’app et le panneau Compte partagent une même vérification native lorsqu’elle est déjà en cours. Aucun résultat terminé n’est conservé comme autorisation. Une demande de connexion, une approbation, une déconnexion ou une remise à zéro invalide ce regroupement ; une ancienne réponse ne peut pas supprimer la nouvelle demande en cours.
- Une autorisation ou une vérification native déjà terminée relit directement la licence signée. Elle ne redemande plus `/api/account/me` avant de prendre en compte la licence. Un changement de rôle déclenche toujours son renouvellement.
- Les demandes d’état Automation en cours sont regroupées par entreprise. Un changement d’espace n’attend plus la réponse de l’ancien espace avant de lancer sa propre demande. Les réponses ne sont pas mises en cache après leur résolution ; la vérification native de session et d’entreprise reste obligatoire.
- Le serveur lit d’abord l’offre Automation déjà liée. Dans le scénario d’offre manuelle testé, cette vérification utilise trois lectures fraîches, au lieu de six. La découverte d’identité est réservée aux offres valides qui restent à relier. Les contrôles d’expiration, de révocation et d’accès Gestion restent exécutés.
- Le bilan d’activité démarre dès que les droits sont vérifiés, sans attendre les lectures indépendantes des réglages et des fonctions disponibles. Le résumé fournisseur charge ses totaux et ses cinq dernières factures simultanément. Ces lectures restent limitées à l’entreprise et à la période demandées ; aucun résultat d’autorisation n’est conservé entre requêtes.

La fréquence et le contenu des échanges de synchronisation métier ne changent pas. La première connexion et le premier téléchargement d’une entreprise restent dépendants du réseau. Aucun achat, abonnement ou accès réel n’a été modifié par les tests.

## Vérifications du 24 septembre 2026

- 62 tests frontend ciblés et 125 tests serveur ciblés : connexion locale, panne réseau, autorisation, rôle réduit, révocation, changement d’entreprise, licences, facturation Automation, offres, factures reçues et workflows. Les six tests du bridge utilisent le vrai bridge avec un transport natif simulé et couvrent le regroupement des lectures, sa durée de vie et les changements de compte.
- Test du chargement serveur avec horloge simulée : droits à 25 ms, réglages/fonctions à 100 ms, activité en 100 ms. La réponse complète arrive à 125 ms au lieu des 200 ms nécessaires avec les anciennes dépendances. Aucun accès aux données d’activité avant 25 ms, ni en cas de refus ou d’échec du contrôle. Il s’agit d’une mesure des dépendances de chargement, pas de la latence du serveur public.
- Vérification TypeScript des deux projets et compilation du frontend réussies.
- Suite frontend complète après intégration : 1 646 tests réussis dans 202 fichiers. Ce résultat ne remplace pas les essais des paquets natifs.
- Parcours Playwright du vrai composant App et du bridge de compte, données fictives, `/me` retardé volontairement de 10 secondes : bureau 1 440 px, espace à 446 ms, Automation à 467 ms, panneau Compte à 35 ms ; mobile 390 px, respectivement 428 ms, 445 ms et 39 ms. Aucune erreur JavaScript ni nouvel écran bloquant après revalidation. Ces délais mesurent l’affichage dans le banc d’essai, pas une authentification complète sur le serveur public.
- Une seule lecture réseau pendant ce parcours pour l’ouverture de l’app et du panneau Compte, contre deux avant le regroupement ; aucun contrôle supplémentaire déclenché par le retour du panneau.
- Graphe de production : 141 fichiers locaux vérifiés. Paie détaillée, éditeur de documents, achats, catalogue, personnalisation, planification et certificats restent différés. Ces mesures ne sont pas un essai de démarrage à froid sur iPhone ou Mac physique.
- Candidat Windows 1.86.0 compilé depuis `e5768bf07c5b9a93f533559319f12e291904a5a6` : installateur NSIS et signature de mise à jour générés. L’exécutable a été lancé puis relancé dans un profil fictif distinct ; base locale au schéma 60, intégrité et clés étrangères valides. Cette vérification ne constitue ni un essai de connexion au compte réel, ni un test de l’installateur, ni une publication. Preuves : `outputs/release186/windows-candidate/candidate-manifest.json` et `outputs/release186/local-smoke/verification.json`.

Preuves locales : `outputs/startup-account-optimization.json`, `outputs/startup-optimization-build.log`, `outputs/redesign186/frontend-final-tests.log`. Publication serveur vérifiée : source `cdb1bb456ea0e9abee0eca654f7a366d59a832ae`, version 252, déploiement `appgdep_6ab52d47535881919c88ad1650630d5a`, état `succeeded`, domaine `https://www.zentraapp.ch`. Les changements du client doivent encore être livrés dans un nouvel installateur pour bénéficier aux installations existantes.
