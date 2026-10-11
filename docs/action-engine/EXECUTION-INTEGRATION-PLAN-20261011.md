# Action Engine — frontière d'exécution A8/A13

État : réservation privée A8, reprise/journal A9, contrat/ACK A10, consommateur natif authentifié A11, découverte/reprise de préparation serveur A12 et contrat privé de travail A13 codés. Les essais et limites figurent dans leurs rapports, dont `DEVICE-CONSUMER-VALIDATION-20261011.md`, `SUPPORT-DISCOVERY-VALIDATION-20261011.md` et `SUPPORT-WORK-BRIDGE-VALIDATION-20261011.md`. Le consommateur natif n'a jamais été exécuté ; aucun endpoint, IPC, caller Support ou notification n'est exposé. Les 136 tests Rust restent non compilés/non exécutés sous Windows App Control 4551. Ne pas retenter ni contourner ce blocage. Les 2 173 tests serveur réussis ne remplacent pas la validation native et staging.

## Réservation distante avant toute écriture native

La composition privée A8 `device-reservation.ts` possède une entrée fermée `{sourceId, proposalId}`. L'acteur, l'entreprise, l'installation et les droits viennent de l'authentificateur appareil. La nouvelle réservation exige l'admission actuelle, le consentement spécifique, le pilote serveur, la source exacte et la publication de contexte courante.

A8 réutilise `createPublishedQuoteFences` et construit le registre avec `reservationBinding: fences.reservationBinding`. A12 centralise le garde pays natif dans ces fences partagés, sans le lier deux fois dans A8. La liaison initiale est écrite dans le même batch que la réservation. Les IDs client et devis viennent du serveur. L'appareil ne fournit ni plan, prix, rôle, SQL ou reçu.

La réponse privée destinée au Rust doit lier le plan canonique original et son SHA, la source capturée, la réservation et sa provenance. Capturer ces valeurs avant toute attente ; les relire sous les gardes actuelles avant retour. Un autre appareil reçoit un état détenu, sans transfert automatique ni expiration autorisant une seconde création.

Le fast-path historique `reserveExecution` peut retrouver un reçu sans passer par une nouvelle réservation. A8 ne l'expose pas : il exige la preuve A6 corroborée par A7 avant de retourner un succès historique. Une réservation legacy non liée ou un reçu sans preuve impose une revue ; aucun backfill. Une réservation détenue ne divulgue aucun ID d'exécution ; une reprise sous contexte périmé ne fournit que des sélecteurs locaux, jamais un nouvel input d'écriture.

Le retour `reserved` termine par un SELECT réunissant progression complète et réservation exacte encore sans reçu/preuve. Aucune attente historique ne suit ce contrôle sur succès. Ce point d'acceptation serveur ne rend pas atomiques une révocation ultérieure et le futur commit SQLite ; les contrôles natifs ci-dessous restent indispensables.

## IPC à sélecteurs uniquement

Le Rust devra lui-même appeler le serveur HTTPS fixe avec la session appareil protégée. Capturer l'origine de l'entreprise et le contexte membre avant l'attente, puis les recorroborer avant toute mutation locale. Ne pas exposer directement `ActionEngineQuoteInput` à la WebView.

Le webhook/workflow Support actuel possède une autorité déléguée, pas une session appareil ni une installation. Il ne peut donc pas appeler ce parcours en fabriquant une identité appareil. Le futur déclenchement devra transmettre un travail durable à un consommateur réellement authentifié, ou faire l'objet d'un adaptateur d'autorité serveur distinct, explicitement conçu et testé. Avec le premier writer SQLite natif, la création effective dépend d'un appareil autorisé disponible ; aucun traitement métier en arrière-plan lorsque tous les appareils sont fermés n'est garanti par A8. Ne pas raccorder directement ce lot à `automation/activity.ts`, déjà exposé, avant validation de la surface publique.

Le writer privé `commit_action_engine_quote_draft` possède déjà son mutex `LocalStore` et sa transaction IMMEDIATE. Ne pas l'entourer d'un second verrou du même store. Il prépare seulement le client éventuel, le brouillon non numéroté, les lignes, le reçu, l'audit et l'outbox ; aucune émission, facture ou transmission.

L'autorisation distante et le commit SQLite ne forment pas une transaction distribuée. Définir explicitement le point d'acceptation de l'opération et les fenêtres de révocation ; ne pas annoncer une révocation instantanément atomique entre deux services ou après une réponse serveur déjà délivrée.

## Trois conditions de reprise A9, composées en A11 et à valider

1. **Retrouver la création locale sans ticket actuel.** A9 ajoute `recover_action_engine_quote_receipt` : sélecteurs fermés, origine fraîche capturée, reçu/outbox/audit vérifiés dans le même snapshot SQLite. L'ancien input complet n'est plus nécessaire à cette API privée. Une absence reste `recovery_uncertain`, jamais une permission de recréer.
2. **Résoudre le pending antérieur avant une nouvelle création.** Le writer retrouve d'abord un reçu historique, puis sa nouvelle garde refuse pending, réception, conflit ou entreprise étrangère avant toute écriture. Le futur consommateur doit résoudre l'envoi sous son origine capturée avant de réessayer ; `prepare_locked` ne peut toujours pas être interprété comme une nouvelle archive par défaut.
3. **Lier durablement la création à sa publication.** A9 ajoute un journal privé version1 distinct du payload immuable : proposition/réservation → snapshot/base/SHA/manifeste/clock, écrit avant transport après vérification de l'archive figée. Les hooks de prepare, reprise pending, fusion et ACK conservent les candidats et leurs octets. Réception/restauration locale préserve les liens ; partage/import/changement d'entreprise ne les transporte pas. Une panne de lecture des liens bloque le nettoyage. Le futur consommateur doit encore obtenir A7 avant de confirmer l'outbox et libérer la conservation.

Ces sources A9 ne sont ni compilées ni exécutées. Le SQL privé est vérifié par Node SQLite sans changer le schéma partagé62. Voir `NATIVE-RECOVERY-VALIDATION-20261011.md` pour les résultats et la distinction entre reprise locale, ACK de transport et preuve canonique.

La première archive doit figer le brouillon complet avant édition/émission. Si cette première preuve est déjà impossible, conserver le reçu, afficher une revue requise et ne pas recréer. Après preuve durable, A7 peut confirmer le fait historique sans relire le transport ancien.

## Découverte Support et reprise de préparation A12, privées

Le callback facultatif actuel `dispatchMailWorkflows` suit la persistance de la classification Support. Un arrêt entre les deux laisse un ticket classé sans workflow. `discoverDeviceSupportQuoteWork` dérive maintenant le travail des tickets, intakes et propositions durables, sous la vraie session appareil et la délégation actuelle ; il ne dépend pas de la réussite du callback et ne l'active pas.

Ordre du futur consommateur :

1. Reprendre d'abord les candidats de l'outbox locale A11 sous leur origine, y compris après un ACK local perdu. La découverte exclut un résultat déjà canoniquement confirmé ; elle ne remplace donc pas cette reprise locale.
2. Lire une ronde entière de pages d'IDs source, maximum 50 par page, avec le curseur lié au membre/espace/installation. Relire la même page sous droits frais avant retour ; un changement d'espace, de droits ou d'admissibilité impose refus/conflit, sans utiliser la page ancienne.
3. Appeler le préparateur privé avec chaque ID source. `readPreparedDeviceQuote` récupère d'abord la proposition immuable sous droits actuels, avant archive/catalogue/clé. Si elle n'existe pas, suivre la préparation ordinaire gardée. Résoudre la clé seulement lorsqu'une décision neuve est réellement nécessaire après `intake.start` ; un résultat fini peut rejoindre le registre sans nouvel appel IA.
4. Passer ensuite les sélecteurs source/proposition à A8/A11, jamais un plan fourni par l'interface. Une proposition historique n'autorise pas une création fraîche. Les droits de progression, le mode Support, le pays et la publication restent contrôlés aux mutations.
5. À la ronde suivante, repartir sans curseur : classification tardive et expiration de bail ne changent pas forcément la date du ticket. Prévoir cadence bornée et gestion de conflit ; aucun scheduler ou retry automatique d'analyse incertaine n'est installé dans A12.

La catégorie `quote` est seulement un présélecteur ; le préparateur distingue demande et offre. Les intakes `started`/`uncertain` ne sont jamais redispatchés. Les connecteurs sans expéditeur structuré restent non planifiables et demandent une revue. Une révision Gestion plus récente peut invalider conservativement une proposition non réservée ; aucun rebase silencieux.

La migration D1 0105 ajoute uniquement l'index `(workspace_id, created_at, id)`, vérifié avec le vrai EXPLAIN SQLite local. Aucun nouveau schéma Supabase/natif ni changement de production. L'index et les pages bornées ne prouvent pas une limite stricte de scan/CPU ou une charge de 150 entreprises. La compilation native et le staging restent des prérequis à toute exposition du raccord.

## Contrat de travail A13 et origine de la future ronde

`handleDeviceQuoteWork` compose A12 depuis deux demandes fermées : `discover` avec taille/curseur facultatifs, et `prepare` avec un ID source. Session et quota appareil actuels précèdent lecture/dispatch. Le résumé de préparation vérifie entreprise/source/CHF/SHA sans attente supplémentaire et ne contient ni plan métier ni permission A8. Le JSON de travail accepte 8 KiB pour le curseur A12 ; le handler d'exécution garde son plafond 2 KiB. Aucun endpoint ou décodeur/caller natif n'est ajouté. Le connecteur Support API persiste maintenant les métadonnées expéditeur facultatives ; leur absence/ambiguïté reste un motif de revue.

Le prochain raccord natif doit capturer son `ActionStamp` avant toute découverte et le conserver pour préparation, réservation, effets locaux, publication, A7 et ACK. Ne pas appeler naïvement `execute_quote_draft` après préparation s'il recapture alors une nouvelle origine : extraire une composition interne liée au stamp, conserver le wrapper existant et vérifier l'origine après chaque attente/sur rejet. Les gardes de tâche/worker A11 restent nécessaires pendant l'annulation.

Il manque un lecteur borné des sélecteurs d'intentions locales : les primitives actuelles attendent déjà des IDs connus. Le lecteur devra recorroborer outbox/reçu/audit sous origine et transaction locales, sans reconstruire un brouillon depuis un état incertain. Les intentions déjà canoniquement confirmées avec ACK local perdu ne sont pas récupérées par la découverte serveur : outbox d'abord.

Le consommateur `Confirmed` ne distingue pas à lui seul nouvelle confirmation et rejeu. L'activité utilisateur doit dériver du marqueur durable de confirmation A10, avec clé stable entreprise/proposition et référence au vrai document courant. Un push éventuel suit l'ACK local et ne remplace pas cette projection après crash. Ni `prepared`, ni l'ACK de transport, ni chaque retour historique `Confirmed` ne déclenche une nouvelle notification. Compiler, exécuter les tests natifs et valider l'archive/staging avant toute exposition.

## Fichiers à examiner au prochain lot

- Serveur : `lib/action-engine/device-reservation.ts` et son classifieur sont implémentés en A8 ; conserver leurs contrats et tests lors de la future exposition. `ledger.ts`, `published-fences.ts`, `confirmation-records.ts`, `historical-quote-fences.ts`, `device-confirmation.ts` restent les frontières de référence.
- Découverte/préparation : `device-work-contract.ts`, `device-work-handler.ts`, `device-work-discovery.ts`, `device-proposal-recovery.ts`, `device-preparation.ts`, avec tests de composition D1 et migration 0105 existante. Ils restent privés ; aucun hook Support ou ordonnanceur ne peut fabriquer l'identité appareil à leur place.
- Native : `account_cloud_action_engine.rs` et `action_engine_device_protocol.rs` créés en A11, avec leurs tests. Examiner aussi `account_cloud.rs`, `action_engine_quote.rs`, `action_engine_quote_publication.rs`, `company_collaboration.rs` et leurs tests dans `desktop/src-tauri/src/`. Journal privé A9 réutilisé, schéma partagé inchangé.
- Exposition seulement après validation : `commands.rs`, `lib.rs`, contrat HTTP fermé et consommateurs UI. La route collaboration reste un transport, sans plan métier ni autorisation déclarée par l'appelant.

Utiliser uniquement le checkout natif `app-current-corrections`, version 1.90.15/schema 62, et non le desktop 1.46.1 de la copie serveur. Ne pas modifier les anciennes migrations ni distribuer un client exigeant des schémas hébergés absents.

## Ordre concret codé en A11, non exécuté

1. Capturer l'origine via `ActionStamp` dans `account_cloud_action_engine.rs` : session, références protégées, générations, workspace, identité SQL et nonce sous verrou compte → mutex LocalStore. `CloudSession` ne contient pas l'utilisateur ; `project_sync_session` seul n'autorise pas une écriture. Conserver le stamp original jusqu'à l'ACK final.
2. Résoudre l'ancien transfert sous cette origine avant A8/writer. `known:false` conserve archive et ID uniquement à base serveur exacte. Appeler A8 avec les deux sélecteurs ; relâcher les verrous pendant cet HTTP et recorroborer après succès **et rejet**. `held` reste sans effet, `recovery_required` ne recrée rien ; seul `reserved` fournit l'input neuf après comparaison acteur/installation.
3. Appeler le vrai writer sous garde compte, sans mutex LocalStore externe. Relire les candidats A10 après commit/rejeu. Avant une nouvelle publication, les relire encore sous le même verrou compte acquis pour fermer la course entre consommateurs. Réutiliser prepare → lien A9 → upload → ACK ; ne pas inférer le snapshot depuis une tête courante. La tâche de publication conserve la garde compte même si le caller annule son attente.
4. Appeler A7 avec source/proposition/réservation/snapshot exact. Revalider succès/rejet sous origine inchangée puis appeler `acknowledge_action_engine_quote_confirmation` : marqueur privé et outbox terminale dans la même transaction, sans modifier client/devis. Le `confirmed` historique A8 peut aussi transmettre les quatre sélecteurs de son vrai A7 à cet ACK. Un ACK transport ou reçu sans snapshot ne suffit pas. La conservation des candidats reste permanente jusqu'à cette preuve.

Le handler serveur et ses codecs sont testés localement. A11 compose dans les sources le consommateur natif et les primitives existantes, avec vérifications de contexte sur succès/rejet et durée de garde protégée contre l'annulation. Le `confirmed` historique A8 transporte les quatre sélecteurs réellement corroborés par A7 ; l'ancien reçu seul reste refusé. Tout ce comportement natif demeure non compilé/non exécuté : aucun IPC, endpoint public ou déclencheur ne doit précéder les validations native et staging.

## Essais discriminants avant activation

- Deux appareils et connexions concurrentes : un seul propriétaire de réservation et un seul client/devis.
- Réponse perdue après réservation D1, commit SQLite, upload, commit PG, preuve A7 et confirmation D1.
- Source/catalogue modifiés avant l'écriture : refus ; modifiés après une création locale réussie : reprise historique sans duplication.
- Changement de compte, d'entreprise ou de contexte membre à chaque attente.
- Ancien pending, conflit de synchronisation, crash après nettoyage et tête distante avancée.
- Réponse serveur, plan/SHA/source/IDs altérés, archive hors limites et reçu legacy.
- Vraie archive synthétique produite par Rust passée au lecteur TS/WASM ; restauration/fusion et conservation du lien de publication.

Les données restent fictives. Aucun compte, e-mail, paiement ou document client réel n'est nécessaire à ces essais. Les migrations hébergées et le protocole multi-connexions PostgreSQL nécessitent un staging approuvé avant activation ; la réussite des suites locales A7 ne remplace pas ces preuves.
