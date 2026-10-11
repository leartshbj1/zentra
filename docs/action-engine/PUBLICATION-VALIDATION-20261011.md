# Action Engine — coordination privée A4, 11 octobre 2026

## Résultat et portée

Le lot A4 compose désormais les droits actuels, la source Support déléguée et une publication Gestion corroborée dans les mêmes mutations D1 de préparation. Un protocole de publication opt-in empêche ces mutations d'avancer pendant qu'une nouvelle archive peut devenir la tête Supabase. Le préparateur privé raccorde ces capacités à l'intake durable et au fournisseur existant ; il n'est appelé par aucune route, aucun déclencheur Support ni aucune commande native.

**Aucune fonction autonome n'est activée en production.** Les migrations sont proposées et testées sur des bases éphémères seulement. La configuration `ACTION_ENGINE_PUBLICATION_ORGANIZATIONS` est vide par défaut. Aucun appel JEV réel, e-mail, paiement, accès à une boîte ou modification de données clients n'a été effectué. Le dépôt utilisateur d'origine n'est pas modifié.

Les preuves, empreintes, commandes et limites de validation sont consignées dans `docs/evidence/action-engine-publication-20261011.json`. Code serveur : `a5c75c9830e9a291928447ba11deee22e3c9a664`, branche `codex/international-runtime`. Le natif demeure au checkpoint A3 `e7ae48848a529a368b238ac57f724f1c8aff10df`, desktop **1.90.15**, sans modification A4.

## Fichiers créés

- `lib/action-engine/publication-ledger-types.ts`, `publication-ledger.ts`, `publication-ledger.test.ts` : tentatives permanentes, journal et prédicat de publication.
- `lib/action-engine/publication-coordinator.ts`, `publication-coordinator.test.ts` : coordination pending → CAS PostgreSQL → settlement D1 et reprise par opération.
- `lib/action-engine/publication-gateway.ts`, `publication-gateway.test.ts` : adaptateur serveur authentifié du transport existant, opt-in et corroboration fermée du fait PostgreSQL.
- `lib/action-engine/publication-coordination.postgres.test.ts` : migrations réelles et rôles dans PostgreSQL WASM éphémère.
- `lib/action-engine/publication-stack.integration.test.ts` : composition réelle du coordinateur, des deux bases et du vérificateur de fait.
- `lib/action-engine/support-source.ts`, `support-source.test.ts` : capacités privées de source et gardes SQL courantes/historiques.
- `lib/action-engine/published-fences.ts`, `published-fences.test.ts` : composition admission/source/publication, identité de proposition et refus de confirmation non prouvée.
- `lib/action-engine/device-preparation.ts`, `device-preparation.test.ts` : composition privée du préparateur et contrôles unitaires des raccords.
- `drizzle/0102_action_engine_publication_ledger.sql` et `supabase/migrations/20261011011348_action_engine_publication_coordination.sql` : migrations additives proposées.

## Fichiers modifiés

- `db/action-engine-schema.ts` : déclarations des nouvelles tables D1.
- `lib/action-engine/production-admission.ts` et tests : capture atomique de la génération d'autorité et prédicat CAS réévaluant les réglages disponibles au runtime.
- `lib/action-engine/published-context.ts` : capacité de source privée et empreinte du manifeste normalisé.
- `lib/company-collaboration.ts` et tests : choix explicite du transport coordonné ; seul un rejet PostgreSQL définitif `PA103` permet de rejoindre ce chemin après retrait du flag. Un délai ou un échec ambigu n'autorise jamais un changement de protocole.
- `lib/runtime.ts` : liaison serveur typée de l'allowlist.
- `lib/action-engine/README.md`, `docs/action-engine/PUBLISHED-CONTEXT-CONTRACT.md`, `STATUS.md` : état réel du raccord et suites nécessaires.

Ce compte rendu et le manifeste de preuves sont enregistrés séparément des sources.

## Protocole codé

1. Le serveur vérifie l'identité appareil, le rôle, le pays autorisé et l'opt-in. Les données du navigateur et du modèle ne fournissent pas le locataire ni les permissions.
2. PostgreSQL active une garde permanente sous le verrou de tête. Les métadonnées du snapshot deviennent immuables avant leur lecture par l'adaptateur.
3. D1 enregistre une tentative `pending` permanente avec UUID serveur, identité et empreintes exactes **avant** le CAS de tête PostgreSQL. Une seule tentative pending par entreprise peut exister. Le prédicat de préparation refuse toute entreprise avec une publication pending.
4. Le RPC v2 prend le même verrou de tête, fixe un fait durable et utilise un marqueur privé de transaction non forgeable par `SET LOCAL`. Il réutilise le vrai noyau de synchronisation et ses contrôles des fragments ; il ne crée pas de devis.
5. L'adaptateur compare le fait PostgreSQL à la tentative : opération, entreprise, snapshot, appareil, acteur, base, résultat, manifeste normalisé, taille et empreintes. D1 devient terminal seulement après cette corroboration. Une erreur conserve la barrière.
6. Une réponse perdue est reprise avec la même opération. Après 120 secondes, un autre candidat peut demander une clôture PostgreSQL sous le verrou de tête : réception du commit original ou tombstone permanent. L'âge seul ne libère jamais D1. Un commit retardé ne peut dépasser le tombstone.
7. Le settlement D1 doit réussir avant d'annoncer la révision et nettoyer les anciennes copies de transport. Les erreurs d'annonce/nettoyage ne transforment pas un succès déjà établi en échec métier.

Le protocole repose sur tous les writers autorisés passant par ce gateway. Un RPC service-only, un UUID, un manifeste ou une relecture Supabase ne constituent pas une autorisation D1 ou une transaction distribuée.

## Cas de reprise corrigés

- Retirer l'allowlist empêche la préparation dans le nouveau chemin, mais ne rétablit pas le protocole ancien pour une entreprise déjà protégée. Le wrapper public legacy verrouille la tête et refuse `PA103` avant tout retour, **même historique**. Cela ferme le cas commit PostgreSQL réussi / accusé perdu / D1 pending / flag retiré.
- Un replay historique antérieur à l'opt-in peut renvoyer son fait de création, sans introduire un témoin de catalogue obsolète dans D1. Il ne remplace pas la tête courante.
- Le gateway de commit relit la tentative D1 avant les métadonnées d'archive : un reçu permanent reste récupérable après purge d'une ancienne copie de transport. Un caller d'une autre entreprise, installation ou identité ne peut le réutiliser.
- Le résultat d'une opération annulée reste son résultat historique exact, même après une publication ultérieure. Le commit/close RPC et le fact RPC concordent alors avec le reçu D1.
- Les variations de source, délégation, connexion, abonnement, consentement ou publication pendant les attentes font échouer les mutations. Les gardes sont appliquées dans le même batch D1, sans accepter du SQL fourni en HTTP.

La relecture d'un binding runtime est limitée au déploiement/contexte Worker qui le fournit ; elle n'arrête pas instantanément des requêtes d'un ancien déploiement. La désactivation persistante des droits/consentements D1 est vérifiée par le CAS de progression.

## Contrôles exécutés

Les résultats finaux sont détaillés dans le manifeste de preuves associé. La passe de régression principale a exécuté **1 256 tests dans 40 fichiers**, tous réussis, avec quatre workers : Action Engine, Automation, connecteurs Support sélectionnés et anciens parcours collaboration/transport/pays.

Après correction du wrapper legacy, la nouvelle passe ciblée a exécuté **72 tests dans quatre fichiers**, tous réussis, incluant les 14 tests PostgreSQL et les cinq scénarios composant les bases et le vrai vérificateur. Ces 72 tests recouvrent une partie de la régression ; ils ne s'ajoutent pas au total comme des cas uniques.

Les **14 tests unitaires** supplémentaires du préparateur privé ont réussi : gate initial, capture avant attente, raccords, révocation, génération modifiée, refus SQL, retrait du flag et confidentialité de la clé. Cela donne **1 270 cas distincts exécutés avec succès**, répartis sur 41 fichiers. Typecheck complet, lint du noyau, format des 19 fichiers TypeScript concernés et contrôle des assets ont également réussi. Le lint global du dépôt n'est pas annoncé propre ; les diagnostics Support préexistants sont consignés dans le rapport A3.

Les scénarios transversaux vérifient : progression bloquée avant settlement ; commit PostgreSQL avec accusé perdu ; refus du replay legacy sous garde ; réutilisation de l'opération originale ; clôture/tombstone avant nouveau candidat ; commit retardé annulé ; résultat conservé après purge ; manifeste incohérent qui conserve pending puis reprise exacte.

Les tests natifs A3 restent **50 écrits, non exécutés**. Cargo n'a pas été retenté : le dernier essai échoue avant compilation du projet sous Windows App Control, erreur 4551. Les nouveaux tests de composition privée remplacent leurs dépendances ; ils ne sont pas des appels JEV, authentifications distantes ou créations natives réels.

La construction Vinext de production a réussi séparément sans déploiement. Elle conserve ses avertissements connus sur `middleware` déprécié et la classification statique incomplète de certaines routes. Une première invocation utilisait un chemin CLI inexistant ; le champ `bin` du paquet a ensuite été lu et le chemin réel utilisé. Les deux premières passes de typage ont identifié des erreurs dans les fixtures de tests, corrigées avant la passe finale. Aucun échec d'assertion n'a été masqué ou test ignoré.

## Migrations et retour arrière

La migration D1 0102 ajoute deux tables, index et triggers d'immutabilité. Elle ne stocke ni corps d'e-mail, catalogue, mot de passe ou jeton. L'unicité du snapshot est tenant-scoped ; l'opération est un UUID serveur global. Une archive est limitée à **512 MiB**, distincte de la limite de stockage globale par entreprise.

La migration PostgreSQL ajoute garde, registre permanent, contexte de transaction privé, triggers et RPC service-only. RLS est activée ; `anon` et `authenticated` n'ont pas les accès ; les fonctions privées et marqueurs n'accordent pas d'écriture directe à `service_role`. Les fonctions definer ont un `search_path` vide. La migration est exécutée après les quatre parents réels de collaboration/content/country dans les fixtures ; les données préexistantes synthétiques et les parcours non opt-in restent vérifiés. Les migrations historiques ne sont pas réécrites.

Avant opt-in, garder l'allowlist vide permet de revenir aux sources précédentes sans supprimer les tables ni les données. **Après opt-in, la garde est permanente : un rollback vers un gateway ne supportant pas v2 est interdit.** Retirer le flag désactive la préparation, tandis que le gateway compatible continue les publications protégées. Aucun script de suppression/downgrade n'est fourni. Toute migration ou activation distante demande une validation distincte.

## Limites et suite

1. PostgreSQL WASM utilise une connexion sérialisée : les tests ne prouvent pas les ordonnancements entre connexions PostgreSQL, le comportement PostgREST, la parité d'une instance Supabase déployée ou la disponibilité du service. Le registre publication est testé dans SQLite ; cela ne remplace pas une recette Cloudflare D1 hébergée.
2. Le protocole protège les mutations D1 de préparation pendant la publication ; il ne crée pas une transaction D1/Supabase commune. La session du transport existant est celle capturée par son authentification ; les RPC ne prouvent pas une autorisation Automation.
3. La confirmation de devis est volontairement refusée (`SQL 0`) : le catalogue publié ne prouve pas la présence du devis, des lignes, du reçu et de l'audit dans la base métier. Leur projection canonique et leur corroboration restent nécessaires.
4. Le writer natif A3, sa migration 62 et les régressions de restauration/fusion doivent compiler et passer sur un hôte autorisé. Il faut ensuite faire lire une vraie archive synthétique Rust au codec TypeScript.
5. La reprise commit après purge est testée côté serveur. Le client natif fait encore `prepare` avant `commit` ; ce chemin de reprise antérieur doit être adapté avant de revendiquer une récupération complète de bout en bout.
6. Aucun IPC, endpoint Action Engine, déclenchement Support, notification ou interface n'est raccordé. Le pilote reste CH/CHF, pack Complet Stripe payé, consentement distinct et mode `suggest` ; US, essais, droits manuels/fondateur/prépayés et transitions restent hors de ce chemin.

L'objectif global reste actif. A4 est un checkpoint serveur local ; aucune garantie « exactly once », conformité fiscale, devis créé en ligne ou synchronisation sur appareils physiques n'est annoncée.
