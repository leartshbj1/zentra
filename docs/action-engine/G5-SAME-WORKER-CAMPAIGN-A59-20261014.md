# A59 — prochaine campagne de reprise native A41

Candidat local test-only, non exécuté en natif. Aucun Cargo/EXE local, accès
cloud, nouvelle préparation hébergée, activation produit, commit ou push.
CI313 sur `dea41` a compilé et passé les onze tests de profil et les neuf du
superviseur, puis terminé Failed : la nouvelle proposition est `needs_review`
avec confiance 0.7. L'ancienne proposition à 0.58 reste intacte ; head rev1,
aucune réservation/preuve de devis. Ce résultat ne permet pas de lancer G5.
La cause fournisseur doit être comprise avant toute nouvelle campagne.

## Trois frontières, cinq processus

Le coordinateur conserve uniquement en mémoire le chemin privé issu de
`privateContinuationSink`, les références d'installation et les sélecteurs.
Les cinq tests utilisent le même exécutable compilé, le même worker Windows
et le même utilisateur DPAPI. Les deux stores ne sont jamais archivés,
exportés vers les artefacts, mis en cache ou transférés à un autre job.

1. Recevoir la tête canonique actuelle dans deux nouveaux stores, vérifier le
   pin revision/snapshot/archive, toutes les reviews antérieures et les deux
   révisions de consentement. Créer une seule nouvelle demande fictive normale
   via la connexion API existante. Préparer cette seule source une fois. Une
   review termine le scénario sans réserve ni nouvelle analyse. Si ready,
   réserver réellement, appeler le vrai writer, observer le reçu durable puis
   bloquer sur le pipe. Node tue ce processus et attend sa fin effective.
2. Réouvrir le même store écrivain. Publier l'archive réelle avec les helpers
   existants. Sur le seul paquet POST commit, utiliser la même session native
   fraîche/PATH/body/query/headers et observer HTTP200 et les identités de
   commit avant de jeter sa réponse. L'ancien pending et l'archive restent
   conservés. Node tue ce deuxième processus et attend sa fin effective.
3. Réouvrir, récupérer la publication via le gateway réel et le pending
   original, appeler réellement la confirmation A7, vérifier HTTP200 et la
   réponse fermée exacte. Jeter cette réponse **sans ACK local**, puis tuer et
   attendre la fin effective du troisième processus.
4. Réouvrir, reprendre les mêmes sélecteurs avec le consumer existant et
   appliquer son ACK réel. L'appareil B reçoit la nouvelle publication ; les
   deux copies contiennent le même devis/lignes/reçu/audit.
5. Réouvrir les deux stores dans un nouveau processus. Vérifier le devis
   unique, l'activité privée écrivain 1/receveur 0, la publication historique,
   toutes les projections de review préexistantes et les consentements.

Les compteurs métier partent de la baseline réelle et attendent un delta de
un, sans supposer une base vide ou une seule review. L'inventaire des reviews
est complet, borné à 50, sans curseur partiel. Les DTO ne contiennent ni plan
ni confiance : leur conservation ne remplace pas un postcontrôle D1 de la
valeur de confiance. La review historique connue reste vérifiée séparément.

Exception de transport explicitement nommée dans le reçu :
`commitTransport=native_session_request_status_observed` ;
`otherPublicationTransport=original_helper`. Le POST observé n'utilise pas
l'enveloppe `action_publication_transport`, qui jette le statut HTTP ; il
reprend ses mêmes contrôles de session et son transport réel. Aucun deuxième
POST ne sert à mesurer le premier. Les locks compte/LocalStore, TransferGuard,
pause de synchronisation et checks d'origine avant/après sont conservés.

## Admission future

Même workflow opt-in, même contexte et mêmes deux variables privées. Aucun
paramètre YAML, privilège ni secret supplémentaire. La variable cookie contient
un JSON canonique fermé de format `zentra-a41-g5-context-v1`, avec les champs
`sourceSha`, `campaignId`, `workspaceId`, `connectionId`, `apiHookToken`,
`browserCookieHeader`, `expectedBaseline` ; ce dernier contient seulement
`revision`, `snapshotId`, `archiveSha256`. Le token Sites reste séparé.
Le pin est celui du vrai head observé avant la future campagne ; il n'est pas
forcé à 2. Le mode ne modifie ni le head ni les consentements et ne renouvelle
aucun token automatiquement.

G5 choisit localement le template fermé `en-g5-v1`. Le sujet est
`Quotation request: 3 radiators A41-RAD-100 — <campaign>` et le corps exact est
`Please prepare a new quotation for 3 pieces of Radiateur A41 (SKU A41-RAD-100). Thank you.`
Les parenthèses délimitent le SKU complet avant la ponctuation de la phrase.
Le nom du catalogue, la quantité, le client, l'identité de campagne et les
comparateurs métier restent inchangés. Le hash couvre l'enveloppe réellement
envoyée. Aucun champ du JSON privé ne choisit ce texte ; la continuation garde
son template français exact par défaut. Ce choix ne fabrique aucune confiance
et n'autorise aucune nouvelle campagne avant A61 testé et déployé en QA.

Les variables privées sont supprimées avant Git et compilation. Source exacte,
fichiers suivis, checkout propre, réconciliation Tauri, profil 11 et trois
régressions de session précèdent le flag interne G5. Les cinq noms suivants
doivent tous exister dans le vrai catalogue du même exécutable :

```text
account_cloud::live_a41_g4_tests::continuation::g5::fresh_source_writer_durable_before_process_stop
account_cloud::live_a41_g4_tests::continuation::g5::real_publication_commit_response_loss_before_process_stop
account_cloud::live_a41_g4_tests::continuation::g5::real_confirmation_response_loss_before_local_ack_and_process_stop
account_cloud::live_a41_g4_tests::continuation::g5::recover_exact_confirmation_ack_and_receive_second_store
account_cloud::live_a41_g4_tests::continuation::g5::reopen_both_stores_after_ack_without_new_preparation
```

Le format antérieur de continuation reste inchangé et son pin rev1 est
conservé. Le cookie brut ne lance jamais le scénario vierge archivé. La
baseline et les magasins privés d'un job terminé ne sont pas récupérables
dans un nouveau job sans export : ce candidat crée ses propres deux stores.

## Portée des preuves

G0 A24 conserve 239 tests natifs et 16 cas de vraie archive Rust→TS, avec
autorité de publication synthétique. G3/job293 conserve 8 cas PostgreSQL réels,
4 backends et 6 attentes de verrou, sur cluster éphémère ; son bootstrap US
ne doit pas être appliqué à A41 CH. A35 conserve 74 assertions Auth/RLS/ACL/
Storage réelles et deux objets de setup, sans publication canonique ni
autorité D1/appareil. A43 conserve 28 HTTP réels et deux sessions/licences
d'essai ; le paiement TEST A49 et les parcours natifs restent distincts.

Ce candidat ne prétend couvrir que trois frontières nommées. Les reçus gardent
`fullG5Passed=false`, `g6Passed=false`, mail/scheduler/activation false, même
si cette future exécution réussit. `freshPreparationRequests=1` compte la
préparation AE, pas tous les appels fournisseur : la classification Support
éventuelle est observée séparément et aucun appel fournisseur direct n'est
attesté par ces compteurs.

Restent notamment la course de première réservation à deux appareils, la
perte PUT, le trou interne PG-commit/D1-settlement, fermeture contre commit
retardé sur CH hébergé, retraits d'autorité à chaque attente, mutations
source/catalogue, archives hostiles et reprise après pruning. Les tests locaux
existants de ces primitives restent utiles mais ne prouvent pas ces pannes
sur les services déployés. Storage-v0 doit être éprouvé séparément ; content-v1
R2 ne le prouve pas. Le crash-test `backup::recovery_crash_tests` concerne la
restauration synthétique de profils, pas cette chaîne AE authentifiée.

Les commandes, sorties brutes et hashes locaux sont conservés dans
`.qa/a59-g5-recovery/agent/`. Ils ne constituent pas un résultat CI natif.
Les contrôles locaux donnent 52/52 tests Node (25 nouveaux G5 et 27 de
continuation), 283 contrôles G4 historiques, 360 contrôles CI avec 4 032 cas
de matrice, six vérifications de syntaxe et `git diff --check` réussis.
Ces ensembles sont distincts et ne sont pas additionnés en preuve native.
La revue indépendante A49 n'a trouvé aucun blocage concret ; elle n'a pas
exécuté le natif. Le Rust ajouté reste à compiler et éprouver en CI future.
