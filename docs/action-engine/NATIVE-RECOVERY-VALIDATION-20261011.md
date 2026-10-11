# A9 — reprise locale et lien durable de publication

Le raccord natif privé conserve désormais la création locale et son association à une archive de synchronisation. Il ne constitue pas encore le parcours Support → devis confirmé. Aucun endpoint, IPC, déclencheur Support, notification, opt-in ou déploiement n'est ajouté.

Sources natives : `d5f50f2e4eaa456d58a752b6caa049a6afcdf844`. Test SQL serveur : `e7b07c07c658eb653e51d75f0eef6e04fc44cc76`. Preuves détaillées : `docs/evidence/action-engine-native-recovery-20261011.json`, SHA-256 `cf682b82f2c25c75e862187f500e18f322aa1fbad0b54674a17de0093664b556`. Les commits de documentation ultérieurs ne sont pas les commits de code testés.

## Comportements codés

- `recover_action_engine_quote_receipt` reçoit seulement les sélecteurs source/proposition/réservation/empreinte et l'origine locale capturée. Sous un mutex et une transaction IMMEDIATE, il vérifie identité, installation, espace, nonce, reçu, outbox et événement de création borné. Le hash de la demande est recomposé depuis les faits conservés, sans ancien mail ni nouveau plan. Aucun résultat `None`, backfill ou droit de recréer en cas de doute.
- Cette reprise est historique : elle ne dépend pas du catalogue, du client ou du devis courant. Le résultat indique un état **local** d'outbox, jamais une confirmation canonique A7.
- Le writer retrouve d'abord son reçu existant. Avant toute nouvelle création, il refuse un ancien pending, une réception en attente, un conflit ou une autre entreprise liée. La garde ne reprend pas le mutex du writer.
- La migration privée locale v1 ajoute un journal proposition/réservation → snapshot/base/manifeste/SHA/clock. Les faits sont immuables ; plusieurs candidats peuvent subsister. L'ACK n'admet que la révision exacte `base + 1` et ne confirme pas l'outbox.
- Le lien est écrit avant le transport, aussi lors du rejeu d'un pending et après fusion. Il exige les mêmes client/devis/toutes les lignes/reçu/audit dans l'archive figée. Un vieux pending sans reçu, ou un document déjà modifié/émis/supprimé, peut continuer sa synchronisation ordinaire sans devenir une première preuve. Une corruption provoque un refus conservateur.
- L'acteur et l'installation du lien doivent correspondre au publieur local courant. Un autre collaborateur peut synchroniser l'entreprise sans acquitter l'opération réservée au premier acteur. A7 doit encore corroborer l'identité réelle du fait PostgreSQL.
- L'ACK est conservé avant effacement du pending. Le nettoyage retient les archives liées tant que l'outbox n'est pas confirmée ; une panne SQL, un état invalide ou un lien orphelin bloque le nettoyage.
- Réception et fusion préservent les faits privés locaux. La restauration supprime les enfants avant leurs parents, puis les réinsère dans l'ordre inverse. Un lien acquitté est restauré par insertion pending puis transition exacte dans la même transaction. Tout import assainit aussi l'identité et l'outbox de l'archive entrante ; réception/fusion rétablissent ensuite uniquement les faits privés capturés sur cet appareil. Changement d'entreprise et import ne transportent pas ces liens ; aucune reconstruction depuis le seul reçu partagé.

## Fichiers concernés

Dans le checkout natif `app-current-corrections` :

- Créés : `desktop/src-tauri/src/action_engine_quote_publication.rs`, `action_engine_quote_publication_schema.sql`, `company_collaboration_action_publication_tests.rs`.
- Modifiés : `action_engine_quote.rs`, `action_engine_quote_tests.rs`, `company_collaboration.rs`, `backup.rs`, `database.rs`, `lib.rs`.

Dans le checkout serveur `international-site` :

- Créé : `lib/action-engine/native-publication-schema.test.ts`.
- Documentation : ce rapport, `STATUS.md`, `EXECUTION-INTEGRATION-PLAN-20261011.md`, `lib/action-engine/README.md` et le manifeste de preuves A9.
- Aucun code runtime serveur modifié, aucun changement de dépendance.

## Migration

SQL additive de housekeeping local v1, exécutée dans les deux branches de migration `LocalStore`, y compris les profils déjà en version 62. **Le schéma partagé, le sidecar et `PRAGMA user_version` restent 62 ; l'application reste 1.90.15.** L'ancien fichier de migration 62 n'est pas réécrit. Le namespace privé exclut suivi/digest/fusion ; les lignes sont aussi explicitement retirées des archives exportées et assainies à l'import.

Aucune nouvelle migration D1/PostgreSQL/Supabase ni modification de production. Les schémas et la validation staging des lots précédents restent nécessaires avant activation.

## Vérifications exécutées

- **1 805/1 805 tests serveur, 56 fichiers, aucun ignoré**, en 122,44 secondes : 75 nouveaux cas SQL par rapport à A8. Les tests exécutent le vrai SQL natif 62 puis le nouveau SQL privé sur SQLite Node, avec données synthétiques.
- Cas SQL : migration additive/répétée sans changement de version, reçu/outbox exacts, identité immuable, anti-REPLACE, plusieurs candidats, manifeste fermé et clés dupliquées, bornes, ACK exact et terminal, purge ordonnée, round-trip acquitté et rollback atomique.
- TypeScript `tsc --noEmit --incremental false` et lint ciblé Action Engine : réussis. Une première erreur de typage du tableau de cas de test a été corrigée avant ces contrôles finaux.
- Les 98 tests du premier passage ciblé recouvrent la régression complète ; ils ne sont pas additionnés au total.

**21 nouveaux tests Rust écrits, 89 avec A3/A5/A6, tous non exécutés** : 12 pour la reprise/éligibilité de création, 9 pour les hooks de publication/conservation/restauration, dont une fusion de ZIP avec conservation des deux candidats. Les tests de restauration sont aussi enrichis pour vérifier l'assainissement des données privées entrantes. Rustfmt a seulement parsé les fichiers existants et formaté les deux nouveaux fichiers Rust ; cela ne remplace ni compilation ni tests. Windows App Control 4551 n'a pas été retenté ou contourné. Ces tests Node ne prouvent ni le writer Rust, ni une archive produite par Rust, ni un compte ou transport hébergé. Aucun nouveau build serveur n'est nécessaire pour un fichier de tests seul ; le build runtime A8 reste la dernière preuve de build serveur.

## Limites et suite

Le consommateur natif authentifié reste à composer : réserver sous autorité fraîche, reprendre le reçu avant écriture, publier le candidat exact, appeler A7 et ne libérer la conservation qu'après preuve/confirmation durable. Les générations doivent être capturées avant les attentes, avec ordre verrou compte → worker LocalStore. Les gardes locales ne créent pas une transaction distribuée entre D1, PostgreSQL et SQLite.

Valider ensuite compilation/tests natifs et interopérabilité d'une vraie archive synthétique sur un hôte autorisé, puis protocole multi-connexions PostgreSQL en staging approuvé. Notifications et déclencheurs resteront désactivés jusque-là. Objectif actif, non terminé.
