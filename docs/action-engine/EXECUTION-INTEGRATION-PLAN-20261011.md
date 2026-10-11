# Action Engine — frontière d'exécution A8/A9

État : réservation serveur privée implémentée dans A8, primitives de reprise et journal de publication natifs ajoutés dans A9. Les essais et limites sont consignés dans `DEVICE-RESERVATION-VALIDATION-20261011.md` et `NATIVE-RECOVERY-VALIDATION-20261011.md`. Le consommateur natif reste à composer et à tester. Aucun endpoint, IPC ou writer supplémentaire n'est exposé par ce document. Les 89 tests Rust restent non compilés/non exécutés sous le blocage Windows App Control 4551. Ne pas retenter ni contourner ce blocage.

## Réservation distante avant toute écriture native

La composition privée A8 `device-reservation.ts` possède une entrée fermée `{sourceId, proposalId}`. L'acteur, l'entreprise, l'installation et les droits viennent de l'authentificateur appareil. La nouvelle réservation exige l'admission actuelle, le consentement spécifique, le pilote serveur, la source exacte et la publication de contexte courante.

A8 réutilise `createPublishedQuoteFences` et construit le registre avec `reservationBinding: fences.reservationBinding`, en ajoutant le garde pays natif au fence. La liaison initiale est écrite dans le même batch que la réservation. Les IDs client et devis viennent du serveur. L'appareil ne fournit ni plan, prix, rôle, SQL ou reçu.

La réponse privée destinée au Rust doit lier le plan canonique original et son SHA, la source capturée, la réservation et sa provenance. Capturer ces valeurs avant toute attente ; les relire sous les gardes actuelles avant retour. Un autre appareil reçoit un état détenu, sans transfert automatique ni expiration autorisant une seconde création.

Le fast-path historique `reserveExecution` peut retrouver un reçu sans passer par une nouvelle réservation. A8 ne l'expose pas : il exige la preuve A6 corroborée par A7 avant de retourner un succès historique. Une réservation legacy non liée ou un reçu sans preuve impose une revue ; aucun backfill. Une réservation détenue ne divulgue aucun ID d'exécution ; une reprise sous contexte périmé ne fournit que des sélecteurs locaux, jamais un nouvel input d'écriture.

Le retour `reserved` termine par un SELECT réunissant progression complète et réservation exacte encore sans reçu/preuve. Aucune attente historique ne suit ce contrôle sur succès. Ce point d'acceptation serveur ne rend pas atomiques une révocation ultérieure et le futur commit SQLite ; les contrôles natifs ci-dessous restent indispensables.

## IPC à sélecteurs uniquement

Le Rust devra lui-même appeler le serveur HTTPS fixe avec la session appareil protégée. Capturer l'origine de l'entreprise et le contexte membre avant l'attente, puis les recorroborer avant toute mutation locale. Ne pas exposer directement `ActionEngineQuoteInput` à la WebView.

Le webhook/workflow Support actuel possède une autorité déléguée, pas une session appareil ni une installation. Il ne peut donc pas appeler ce parcours en fabriquant une identité appareil. Le futur déclenchement devra transmettre un travail durable à un consommateur réellement authentifié, ou faire l'objet d'un adaptateur d'autorité serveur distinct, explicitement conçu et testé. Avec le premier writer SQLite natif, la création effective dépend d'un appareil autorisé disponible ; aucun traitement métier en arrière-plan lorsque tous les appareils sont fermés n'est garanti par A8. Ne pas raccorder directement ce lot à `automation/activity.ts`, déjà exposé, avant validation de la surface publique.

Le writer privé `commit_action_engine_quote_draft` possède déjà son mutex `LocalStore` et sa transaction IMMEDIATE. Ne pas l'entourer d'un second verrou du même store. Il prépare seulement le client éventuel, le brouillon non numéroté, les lignes, le reçu, l'audit et l'outbox ; aucune émission, facture ou transmission.

L'autorisation distante et le commit SQLite ne forment pas une transaction distribuée. Définir explicitement le point d'acceptation de l'opération et les fenêtres de révocation ; ne pas annoncer une révocation instantanément atomique entre deux services ou après une réponse serveur déjà délivrée.

## Trois conditions de reprise codées en A9, à composer et valider

1. **Retrouver la création locale sans ticket actuel.** A9 ajoute `recover_action_engine_quote_receipt` : sélecteurs fermés, origine fraîche capturée, reçu/outbox/audit vérifiés dans le même snapshot SQLite. L'ancien input complet n'est plus nécessaire à cette API privée. Une absence reste `recovery_uncertain`, jamais une permission de recréer.
2. **Résoudre le pending antérieur avant une nouvelle création.** Le writer retrouve d'abord un reçu historique, puis sa nouvelle garde refuse pending, réception, conflit ou entreprise étrangère avant toute écriture. Le futur consommateur doit résoudre l'envoi sous son origine capturée avant de réessayer ; `prepare_locked` ne peut toujours pas être interprété comme une nouvelle archive par défaut.
3. **Lier durablement la création à sa publication.** A9 ajoute un journal privé version1 distinct du payload immuable : proposition/réservation → snapshot/base/SHA/manifeste/clock, écrit avant transport après vérification de l'archive figée. Les hooks de prepare, reprise pending, fusion et ACK conservent les candidats et leurs octets. Réception/restauration locale préserve les liens ; partage/import/changement d'entreprise ne les transporte pas. Une panne de lecture des liens bloque le nettoyage. Le futur consommateur doit encore obtenir A7 avant de confirmer l'outbox et libérer la conservation.

Ces sources A9 ne sont ni compilées ni exécutées. Le SQL privé est vérifié par Node SQLite sans changer le schéma partagé62. Voir `NATIVE-RECOVERY-VALIDATION-20261011.md` pour les résultats et la distinction entre reprise locale, ACK de transport et preuve canonique.

La première archive doit figer le brouillon complet avant édition/émission. Si cette première preuve est déjà impossible, conserver le reçu, afficher une revue requise et ne pas recréer. Après preuve durable, A7 peut confirmer le fait historique sans relire le transport ancien.

## Fichiers à examiner au prochain lot

- Serveur : `lib/action-engine/device-reservation.ts` et son classifieur sont implémentés en A8 ; conserver leurs contrats et tests lors de la future exposition. `ledger.ts`, `published-fences.ts`, `confirmation-records.ts`, `historical-quote-fences.ts`, `device-confirmation.ts` restent les frontières de référence.
- Native : module d'orchestration privé à créer ; `desktop/src-tauri/src/account_cloud.rs`, `action_engine_quote.rs`, `action_engine_quote_publication.rs`, `company_collaboration.rs` et leurs tests. Réutiliser le journal privé local v1 A9, sans nouvelle version du schéma partagé pour cette association.
- Exposition seulement après validation : `commands.rs`, `lib.rs`, contrat HTTP fermé et consommateurs UI. La route collaboration reste un transport, sans plan métier ni autorisation déclarée par l'appelant.

Utiliser uniquement le checkout natif `app-current-corrections`, version 1.90.15/schema 62, et non le desktop 1.46.1 de la copie serveur. Ne pas modifier les anciennes migrations ni distribuer un client exigeant des schémas hébergés absents.

## Ordre concret du consommateur A10

1. Dans `account_cloud.rs`, étendre le principe d'`InboxReadStamp` avec le nonce membre et `company_local_identity.user_id` : `CloudSession` ne contient pas l'utilisateur. Capturer session, références protégées, générations, workspace, identité et nonce sous verrou compte → mutex LocalStore. Relâcher les verrous pendant HTTP et recorroborer après succès **et rejet**, avant tout effet local. `project_sync_session` seul n'autorise pas une écriture.
2. Appeler réellement A8 avec les deux sélecteurs source/proposition. `held` reste sans effet, `recovery_required` n'utilise que la reprise locale à sélecteurs, et seul `reserved` fournit l'input neuf. Comparer acteur/installation serveur à l'origine locale ; le worker du writer ne doit pas être entouré d'un second mutex LocalStore.
3. Résoudre l'ancien transfert via `recover_pending_publication_with`, puis réutiliser le chemin prepare → lien A9 → upload → ACK. Ajouter une lecture privée bornée du candidat exact ; ne pas remplacer son snapshot par la tête distante courante.
4. Appeler A7 avec source/proposition/réservation/snapshot lié. Il reste à coder l'acquittement local transactionnel de son reçu sous origine inchangée : reçu retourné identique au reçu historique, puis outbox `confirmed`, sans modification du client/devis. Un ACK transport ne peut appeler cette opération. La rétention reste volontairement permanente tant que cette preuve n'est pas acquise.

Le handler serveur authentifié, le consommateur Rust et cet acquittement sont encore absents. Aucun port abstrait ne doit être présenté comme un raccord effectif ; aucun IPC ni déclencheur ne doit précéder les validations natives et staging.

## Essais discriminants avant activation

- Deux appareils et connexions concurrentes : un seul propriétaire de réservation et un seul client/devis.
- Réponse perdue après réservation D1, commit SQLite, upload, commit PG, preuve A7 et confirmation D1.
- Source/catalogue modifiés avant l'écriture : refus ; modifiés après une création locale réussie : reprise historique sans duplication.
- Changement de compte, d'entreprise ou de contexte membre à chaque attente.
- Ancien pending, conflit de synchronisation, crash après nettoyage et tête distante avancée.
- Réponse serveur, plan/SHA/source/IDs altérés, archive hors limites et reçu legacy.
- Vraie archive synthétique produite par Rust passée au lecteur TS/WASM ; restauration/fusion et conservation du lien de publication.

Les données restent fictives. Aucun compte, e-mail, paiement ou document client réel n'est nécessaire à ces essais. Les migrations hébergées et le protocole multi-connexions PostgreSQL nécessitent un staging approuvé avant activation ; la réussite des suites locales A7 ne remplace pas ces preuves.
