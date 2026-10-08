# Journal et périodes US : stockage et preuves locales

Base de travail : `90d131646a352e149c03b80b9260ec8eda724a2d`, clone `D:/Codex-Zentra-Temporary/2026-10-08/international-site`. Contrat : `US-JOURNAL-PERIODS-CONTRACT-20261008.md`. Ce lot ne déploie rien en production et n'accorde aucun accès fiscal ou prestataire.

## Frontière des sessions D1

La migration additive `drizzle/0089_international_us_device_capability_v4.sql` crée `international_us_device_v4_challenges` et `international_us_device_v4_sessions`, exclusivement pour les nouveaux identifiants portant la capacité 4. Les tables et toutes les lignes 1–3 restent en place : aucun transfert, effacement, remplacement ou changement de capacité d'un ancien identifiant.

Les deux familles interrogent la même vue existante `international_us_device_admissible`, donc le même espace US, les mêmes membres, sièges, abonnements USD et droits actuels. Elles ne constituent pas deux autorités métier. Des déclencheurs additifs empêchent les collisions de codes et de hashes dans les deux directions. La consommation est une transaction D1 qui insère la session et lie le challenge ; les clés étrangères différées imposent la paire exacte. Une recherche union ambiguë échoue plutôt que de choisir une famille.

`us-device-contract.ts` accepte la déclaration 4 ; le serveur `us-device-server.ts` ne la capture dans un nouveau challenge que si son port privé `maxSchemaVersion` l'autorise avant et après création. Les bindings root imposent séparément tous les flags exacts et plafonnent les en-têtes à la capacité immuable de la session. Une déclaration de navigateur n'est jamais un droit d'abonnement, de fiscalité, ni une promotion de l'identifiant 3. Fermer seulement le flag comptable ne réécrit pas la session : les métadonnées et la révocation des identifiants déjà capturés restent possibles. La révocation connue reste idempotente avec les flags communs fermés.

## Frontière PostgreSQL

La nouvelle migration versionnée `supabase/migrations/20261008161118_international_us_journal_periods_v4.sql` prolonge le même livre privé US : mêmes tables d'entêtes, enregistrements, reçus, audits et événements, mêmes verrous d'organisation, CAS et clés d'idempotence. Aucun changement d'une migration historique. Aucun déplacement d'entreprise ou de données suisses.

Les RPC v4 sont `zentra_read_us_erp_v4`, `zentra_us_erp_receipt_v4`, `zentra_us_erp_revision_v4` et `zentra_us_erp_delta_v4`. Le commit conserve son nom existant `zentra_commit_us_erp`. Les fonctions restent `SECURITY INVOKER`, `search_path=''`, sans accès public/anon/authenticated. Les tables métier restent sous RLS ; le port serveur privilégié conserve la responsabilité de vérifier l'identité et les droits frais avant/après l'opération.

La capacité 4 initialise un nouveau livre 4 ; l'adoption d'un livre existant nécessite la commande propriétaire explicite `upgrade_accounting`, uniquement 3→4. Cette transition ne change aucun montant, compte, compteur, document ou audit. Les RPC 1–3 refusent une entête 4 avant lecture ou reprise de reçu (`PU008`). Les événements antérieurs restent à leur version historique ; seule l'enveloppe de transport reflète la capacité du RPC.

Les nouvelles commandes comptables sont validées à nouveau dans SQL, indépendamment du moteur TypeScript : source/action et entité exactes ; hash SHA-256 du JSON canonique de `[organisation, utilisateur, requête]` ; centimes canoniques de 36 chiffres maximum ; débits=crédits ; comptes de contrôle exclus ; catégorie explicite seulement pour un mouvement de trésorerie net non nul ; empreinte privée canonique exacte ; acteur et instant finaux corrélés au journal, audit, reçu et événement. Une contrepassation conserve l'ordre des lignes et descriptions, échange exactement débits/crédits et ne peut se produire qu'une fois sur un original manuel.

Les périodes sont réelles, non chevauchantes et au nombre de 1 à 100. L'ouverture ajoute une période après toutes les dates existantes sans toucher l'historique. Une nouvelle clôture 4 concerne la plus ancienne période encore ouverte. La reconstruction conserve les clôtures légales historiques 1–3 ; elle ne réinterprète pas rétroactivement leur ordre. Les déclencheurs différés exigent l'événement et le reçu correspondant à chaque nouvelle entête et chaque enregistrement 4. Les horodatages d'une nouvelle opération comptable ne reculent pas.

Les adaptateurs `runtime-store.ts` et `runtime-sync-store.ts` choisissent les RPC par capacité protégée. Les nouveaux codes SQL publics sont PU016→accounting_upgrade_required/409, PU017→accounting_period_order_conflict/409, PU018→manual_account_forbidden/422, PU019→invalid_reversal/409 et PU020→period_limit_reached/409 ; les mappings antérieurs restent inchangés.

## Tests réellement exécutés

Commande locale finale, avec `PGLITE_MODULE_DIR=D:/Codex-Zentra-Temporary/2026-10-07/international/postgres-tests/node_modules/@electric-sql/pglite` :

```text
pnpm exec vitest run --config vitest.config.ts
  lib/international/journal-periods.postgres.test.ts
  lib/international/projects.postgres.test.ts
  lib/international/us-device-capability-v4.test.ts
  lib/international/us-device-bindings.test.ts
  lib/international/us-device-workerd.test.ts
```

Résultat final : **5 fichiers, 105 tests exécutés et réussis**, aucune exclusion dans cette commande.

| Suite | Tests | Preuve |
| --- | ---: | --- |
| Journal/périodes, moteur + vraie chaîne PostgreSQL locale + RPC | 30 | Initialisation 4, upgrade 3, décimales exactes, comptes interdits, source/hash falsifiés mais équilibrés, dates/périodes, contrepassation, CAS, rollback, réponse perdue, RLS/permissions |
| Régression projets historiques sur la nouvelle migration 4 | 39 | Conservation CH et livres/reçus/événements/preuves 1–2, projets 3, achats, reprise historique, limites/1000 projets et clôtures historiques |
| Nouvelle famille 4, vraie SQLite SQL + crypto + handlers | 11 | Conservation intégrale des anciennes lignes/FK/hashes, collisions, ambiguïté, paire différée, révocation, fermeture des gates |
| Bindings serveur réels, catalogue/configuration synthétiques TEST | 20 | Tous les flags exacts, pas de promotion 3, refus de l'en-tête 4 forgé, métadonnées/révocation après fermeture 4 |
| Vrai moteur local workerd D1 | 5 | Consommation concurrente/reprise exacte et rollback de paire 4, mêmes régressions pour la famille historique |

Le journal final exact est `.qa/us-journal-periods/store-final.log`. Les premières passes et la reproduction de l'empreinte non canonique sont conservées séparément ; leurs échecs sont corrigés dans le résultat final et ne sont pas présentés comme réussis.

`git diff --check` a été exécuté et ne signale pas d'erreur de whitespace (avertissements Git habituels LF/CRLF). La tentative de lint typé est enregistrée dans `.qa/us-journal-periods/store-lint.log` : le lancement de `tsgolint.exe` a été refusé avec `spawnSync UNKNOWN`. Aucun contournement de la protection Windows, aucune répétition Cargo et aucune affirmation de lint typé réussi. Les contrôles globaux TypeScript/build sont réalisés séparément par root après gel.

Les tests utilisent les vraies migrations, RPC, validation de domaine et transactions locales. PGlite est une connexion RAM sérialisée ; Auth/abonnements/configuration sont des ports synthétiques TEST. Les anciens essais de fiscalité de la suite projets conservent leurs observations **explicitement fictives TEST**, sans appel de prestataire ni preuve de configuration fiscale. workerd teste les transactions D1 locales mais pas une instance Cloudflare hébergée. Aucune de ces preuves ne certifie la conformité réglementaire, la résidence des données, le débit concurrent PostgreSQL de production, la durabilité après crash, ni un exécutable natif publié.

## Ordre de déploiement et retour arrière

1. Appliquer et vérifier la migration D1 additive avant tout handler qui interroge les deux familles. Sans table 4, une union ne peut pas fonctionner, même pour une session historique.
2. Appliquer et vérifier la migration PostgreSQL dans un environnement de staging, puis déployer les nouveaux adaptateurs/bindings avec tous les gates 4 fermés.
3. Contrôler l'accès 1–3, les permissions, les RPC 4 et la conservation des lignes avant d'autoriser de nouveaux credentials 4 ; ne jamais utiliser un en-tête pour contourner un gate.
4. En cas de problème, fermer les gates 4 et arrêter les nouvelles opérations. Conserver les tables, sessions, reçus et événements ; révoquer explicitement si nécessaire. Un livre déjà adopté en 4 reste en 4 : ne pas tenter de le rétrograder, de supprimer ses écritures ou de réutiliser un ancien client pour le modifier.

Les migrations proposées n'ont été exécutées ni en staging hébergé ni en production. Leur validation distante, le plan de sauvegarde vérifié et la confirmation du propriétaire restent nécessaires avant une application sur les données clients.
