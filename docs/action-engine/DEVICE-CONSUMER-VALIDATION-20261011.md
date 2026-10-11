# A11 — consommateur natif authentifié privé

Le raccord source relie réservation A8, création native du brouillon, publication collaboration, confirmation A7 et acquittement local. Il reste **privé et non exécuté** : aucun endpoint exposé, IPC, déclencheur Support, ordonnanceur ou notification ne l'active. L'objectif Action Engine n'est pas terminé.

Code serveur testé : `804d5597b196cb709abcb74c49aa822c37c1d0fd`. Sources natives : `ba69873c54ac24c4f87ece4505a32fe9541208b1`. Manifeste : `docs/evidence/action-engine-device-consumer-20261011.json`, SHA-256 `dec1387f9742cf96378c3ffd1ddb81864632c7e64a49baaddeb6f3502f634b38`. Ces références désignent les commits de code, avant la documentation.

## Modifications

- Le consommateur conserve pendant toutes les étapes le compte complet, les trois références protégées et leurs générations, l'espace physique, le nonce membre, l'identité SQL, le rôle et l'installation. Un changement puis retour au même compte ne rétablit pas une ancienne autorisation.
- A8/A7 utilisent le vrai transport HTTPS à origine fixe, sans redirection, avec un budget dédié de 128 KiB. Le budget ordinaire de compte reste de 64 KiB. URL, bearer, prix et acteur ne viennent pas de la WebView. La réponse, succès **ou erreur**, subit une vérification de contexte avant consommation. Aucun verrou compte/local n'est conservé pendant ces échanges A8/A7.
- Le codec Rust ferme les objets et contrôle UTF-8, doublons, tailles, identifiants, empreintes, cohérence du plan, montants entiers et reçu de brouillon non numéroté. Révision d'autorisation et révision de contexte restent distinctes. Scope et nonce local ne sont jamais reçus du serveur.
- Un ancien pending est résolu avant réservation/création. `known:false` conserve ID, manifeste et octets d'origine, seulement si la tête serveur est encore sa base exacte. Conflit, réception distante, ambiguïté ou panne imposent une reprise/revue conservatrice, sans fusion automatique ni activation du partage.
- `reserved` appelle le vrai writer ; `recovery_required` relit seulement le reçu existant. Après création ou rejeu, le lecteur A10 retrouve les candidats. Avant toute nouvelle publication, il les relit sous le même verrou compte acquis pour cette phase, pour éviter une publication redondante par deux consommateurs concurrents.
- Le pipeline collaboration existant prépare et envoie l'archive. Sa frontière HTTP est extraite pour des tests fermés, en conservant les champs et protocoles `prepare`/`prepare-content`, fragments et `commit`. L'ACK transport ne confirme toujours pas l'outbox métier.
- Seul un vrai résultat A7 pour les sélecteurs exacts peut déclencher l'ACK natif A10. Le verrou compte vit dans le worker bloquant ou la tâche de publication détachée : annuler l'attente ne doit pas libérer le compte pendant qu'un effet local continue. Ces garanties natives sont codées et relues, pas encore compilées/exécutées.

## Ajustement du contrat historique A8

A10 retournait un reçu seul pour `confirmed` historique. A11 retourne les **quatre sélecteurs exacts que sa composition A7 vient réellement d'utiliser** : source, proposition, réservation et snapshot. Ils ne sont déduits ni de la tête courante ni de l'ordre de candidats. Le codec refuse l'ancien reçu seul et tout sélecteur absent.

Le test de composition exécute le vrai handler/A7, simule la perte de sa réponse, ajoute une publication ultérieure, puis reprend par A8. Le résultat conserve le snapshot canonique d'origine sans créer de réservation, preuve ou événement supplémentaire. Le chargeur de contexte courant n'est pas appelé. Le contrat version 1 était privé, non déployé et sans caller ; aucun client public existant n'est migré silencieusement.

## Fichiers

Créés dans la copie native :

- `desktop/src-tauri/src/account_cloud_action_engine.rs`
- `desktop/src-tauri/src/account_cloud_action_engine_tests.rs`
- `desktop/src-tauri/src/action_engine_device_protocol.rs`
- `desktop/src-tauri/src/action_engine_device_protocol_tests.rs`
- `desktop/src-tauri/src/company_collaboration_action_execution_tests.rs`

Modifiés dans la copie native : `account_cloud.rs`, `company_collaboration.rs`, `lib.rs`, dans `desktop/src-tauri/src/`.

Modifiés côté serveur : `lib/action-engine/device-reservation.ts`, `device-execution-contract.ts` et leurs deux fichiers de tests. Aucune dépendance ajoutée, aucune route publique créée. Rapport, manifeste, STATUS, README et plan d'intégration sont documentés séparément des commits source.

## Tests exécutés

| Périmètre | Résultat |
| --- | --- |
| Action Engine, 40 fichiers | 1 458/1 458 |
| Automation, Support et collaboration, 19 fichiers distincts | 524/524 |
| Total distinct, même cohorte que A10 | **1 982/1 982**, aucun échec ou ignoré |
| Ciblés codec/handler/A8-A7 | 176/176, inclus dans le total |
| `tsc --noEmit --incremental false` | Réussi |
| Lint et format des quatre fichiers TypeScript modifiés | Réussis |
| Build de production du site, contrôle des assets inclus | Réussi, non déployé |
| Rustfmt des huit fichiers natifs | Parsing réussi uniquement |

Six cas serveur s'ajoutent aux 1 976 A10 : cinq refus de contrats de confirmation incomplets et une composition historique après réponse perdue. Les deux cohortes de régression sont disjointes ; les 176 ciblés ne sont pas additionnés deux fois. `ZENTRA_NATIVE_SOURCE_ROOT` et `PGLITE_MODULE_DIR` étaient définies pour les passages finaux. Le build conserve ses avertissements de conventions middleware, temps de plugins et classification de routes ; il ne prouve pas l'accessibilité du handler privé comme endpoint.

**37 tests Rust supplémentaires écrits, aucun exécuté** : 15 codec, 8 publication/reprise, 14 contexte/verrous/annulation. Cumul : **136 écrits, 0 exécuté**. Les fixtures nouvelles installent une licence synthétique réellement signée par une autorité publique de test et utilisent les vraies gardes locales. Les assertions `Send` ne seront vérifiées qu'à la compilation native. Le parcours complet `execute_quote_draft` n'a pas été pollé ; le test de sa future la laisse volontairement non exécutée.

## Revue et risques

Deux corrections issues de la revue : relire les candidats sous le verrou compte avant publication concurrente ; installer une vraie licence de test dans la fixture de publication plutôt que dépendre de l'admission debug sans clé configurée. La revue du protocole d'envoi n'a identifié aucun autre défaut concret, mais reste statique.

Windows App Control 4551 empêchait la validation native avant compilation du projet. Aucun Cargo, exécutable natif, contournement ou nouvelle tentative de build natif n'a été lancé. Rustfmt vérifie la syntaxe, **pas** les types, `Send`, durées de vie ou comportement. Le refactoring partagé de l'envoi nécessite les régressions natives ordinaires avant distribution.

Les essais serveur utilisent des données synthétiques et des frontières auth/Storage/PostgreSQL contrôlées selon leurs fixtures. Ils ne prouvent ni une transaction distribuée SQLite/D1/PostgreSQL, ni une synchronisation entre appareils réels, ni une vraie archive Rust acceptée en ligne. Aucun appel JEV ou fournisseur, e-mail réel, paiement ou donnée client n'est intervenu.

## Migrations et retour arrière

Aucune nouvelle migration D1, Supabase ou native. SQL privé A9/A10 inchangé, vérifié par SHA-256 dans le manifeste. App 1.90.15, schémas partagé et sidecar 62, marqueur privé A9 version 1 conservés. Aucun déploiement ni changement de production. Le rollback de ce lot source retire le raccord privé ; il ne dispense pas des exigences permanentes A4 pour une entreprise éventuellement activée ultérieurement.

## Terminé et restant

**Terminé dans les sources** : codec et consommateur authentifié privés, reprises avant écriture, publication via primitives existantes, confirmation/ACK exacts, tests préparés, correction historique A8 testée côté serveur.

**Encore expérimental** : tout comportement Rust ajouté et l'orchestration complète. Avant activation : compiler/exécuter les 136 tests et régressions natives sur un hôte autorisé ; valider une vraie archive synthétique Rust côté serveur ; tester le gateway et PostgreSQL en staging approuvé ; puis raccorder IPC aux seuls sélecteurs, déclencheur Support et notification après confirmation canonique. Émission du devis, e-mail, paiement et comptabilisation restent hors du moteur de brouillons.
