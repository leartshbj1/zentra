# Support et Automation — poursuite des traitements serveur

27 septembre 2026. Correctif du point 2 de l’audit premier client.

## Problème et correction

Le résultat `idle` de `/api/support/mail-sync` dépendait uniquement de la présence d’une boîte à récupérer. Le client planifié interrompait donc ses appels quand aucune boîte n’était due, même si le premier lot de 20 workflows ou son budget de 20 secondes laissait des actions prêtes en file. Un traitement Automation pouvait aussi conserver un état `failed` en base sans le signaler dans le résultat du cycle.

Le résultat tient maintenant compte des deux files. Il contient les compteurs `workflows.checked`, `workflows.failed`, `workflows.interrupted` et le booléen `workflows.more`. Une interruption de worker expiré est comptée une seule fois. Les actions différées à une date future et celles détenues par un autre worker ne sont pas annoncées comme immédiatement prêtes. Le client planifié conserve les totaux avant de tester `idle` et signale les erreurs de messagerie comme d’Automation.

Les limites de lot, le budget de temps, les droits, les vérifications d’abonnement, les verrous et les identités stables des éléments sont conservés. Une demande sans jeton de planification valide ne traite aucune entreprise. Le centre ouvert d’une entreprise n’avance toujours que sa propre file. Aucun nouveau schéma ni secret requis.

## Vérification locale

- 339 tests réussis, 21 fichiers : `lib/automation`, `lib/support` et `lib/service-diagnostics.test.ts`, puis 3 tests du vrai script de planification sur un endpoint HTTP simulé (342 tests, 22 fichiers au total).
- Vérification TypeScript, contrôle des ressources de marque et compilation de production réussis.
- Régression de 27 règles : 2 traitées à la réception, puis 20 et 5 par deux cycles, puis un cycle vide ; exactement 27 éléments enregistrés.
- Budget dépassé pendant une analyse : les actions restantes sont signalées et reprises, sans doublon.
- Deux cycles simultanés : identités stables et un seul élément par action.
- Échec avant verrou, erreur du fournisseur d’analyse après verrou, worker expiré, droits révoqués, échéance future, isolation entre entreprises et appel non autorisé.

Ces scénarios utilisent SQLite en mémoire et simulent les services externes. Ils ne prouvent pas qu’un ordonnanceur distant fonctionne, ni une charge de 150 entreprises réelles.

## État de production constaté avant publication

- 08:29 UTC : la connexion au compte répond 503, avec un délai de nouvelle tentative de 60 secondes.
- 08:31 UTC : le contrôle Supabase avec la clé publique du projet répond 402 et indique `exceed_egress_quota` ainsi que `exceed_storage_size_quota`.
- La dernière synchronisation stockée dans `support_mailboxes` est le 24 septembre 2026 à 23:37:54 UTC. Il s’agit d’un passage mail, pas d’une preuve d’exécution du planificateur.
- Le dernier lancement GitHub consulté du workflow mail est l’échec 35506667301 du 20 septembre. Aucun lancement réussi plus récent n’est démontré.
- `SUPPORT_MAIL_BACKGROUND_ENABLED` n’est pas activé dans la configuration distante, révision 36. Le script Supabase alternatif est préparé dans `docs/SUPPLIER-MAIL-SCHEDULER.sql`, son activation n’est pas démontrée.

La publication de ce code ne rétablit pas les quotas et n’active pas le planificateur. Ne pas annoncer la réception autonome comme rétablie sur cette seule base.

## Recette de production restant à réaliser

Après rétablissement de l’hébergement et activation d’un planificateur, fermer les interfaces Gestion et Support. Envoyer une pièce fictive autorisée, constater son arrivée et son classement, puis vérifier les informations importées et leurs identifiants dans Gestion. Conserver le résultat du cycle réellement authentifié et l’état en base. Tester ensuite une panne suivie d’une reprise sans doublon. Ne passer le drapeau d’arrière-plan à vrai qu’après cette preuve.

Le suivi durable de santé du planificateur et une alerte après absence de passage restent à ajouter. Les logs de cycles ajoutés ici sont des diagnostics, pas une supervision permanente.
