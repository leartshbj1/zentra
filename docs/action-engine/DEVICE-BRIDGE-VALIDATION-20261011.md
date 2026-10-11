# A10 — contrat appareil et acquittement local privé

Ce lot ajoute le contrat fermé entre les compositions serveur A8/A7 et les primitives natives de reprise/confirmation. Le handler est interne, sans route exposée. Il ne constitue pas encore un parcours utilisateur Support → client/devis → notification. L'objectif Action Engine reste actif.

Code serveur testé : `0236918e88b6ae2a91f0f22cfc4ddee3ec396082` ; sources natives : `283cb84c4bafdb1b92e1375833697898a1162456`. Manifeste détaillé : `docs/evidence/action-engine-device-bridge-20261011.json`, SHA-256 `541e354c04c82004430764ffaeba5e98958e71ef49375a589d4ca1d1081d6527`. Les commits de documentation suivants ne remplacent pas ces commits de code.

## Modifications

- Requêtes version 1, plates et limitées aux sélecteurs : `operation`, `sourceId`, `proposalId`, puis `reservationId` et `publicationSnapshotId` pour confirmer. Aucun acteur, plan, prix, droit, scope ou nonce n'est accepté du client.
- Le résultat `reserved` projette le vrai résultat A8 : plan canonique, empreinte, réservation et IDs métier, source, acteur/installation authentifiés, révision d'autorisation, révision de contexte et `binding.resourcesSha256`. Le scope physique et le nonce membre doivent être capturés par Rust, jamais reçus du serveur.
- Les codecs capturent des objets fermés et détachés, refusent accesseurs/champs supplémentaires/incohérences d'identité et vérifient synchroniquement les SHA et le JSON canonique. Aucun `await` n'est ajouté après le dernier contrôle complet de progression A8 avant encodage et réponse.
- `held` ne révèle pas les IDs d'exécution d'un autre appareil. `recovery_required` ne permet pas une nouvelle création. Un `confirmed` historique A8 contient le reçu seul : il ne fabrique pas de réservation/snapshot et ne suffit pas à acquitter l'outbox locale.
- Le succès A7 corrèle les quatre sélecteurs capturés et le reçu exact. Le devis conserve `quoteNumber: null`, `status: "draft"` et `requiresHumanValidation: true` ; aucun numéro, émission, envoi ou paiement n'est ajouté.
- Le handler exige POST, bearer d'appareil et rate limit, puis JSON UTF-8 valide de **2 KiB maximum**. Le parseur plat refuse les clés dupliquées, y compris échappées, objets imbriqués, tableaux et paramètres de requête. Les erreurs sont bornées, sans données source/secrets et sans cache. Expiration d'abonnement et interdiction de ledger sont traitées comme refus d'accès, pas comme panne temporaire.

## Primitives natives et preuve locale

- `recover_action_engine_quote_receipt_in_transaction` réutilise les contrôles historiques A9 dans la transaction IMMEDIATE du lecteur/ACK, sans reprendre le mutex, écrire, réparer ou fermer la transaction de son appelant. Il vérifie l'origine avant toute absence de reçu/outbox.
- `read_action_engine_quote_publication_candidates` relit le reçu/outbox/audit et les candidats privés exacts sous origine et transaction communes. Les candidats sont bornés, avec manifeste canonique/SHA et dates contrôlés ; cette lecture ne dépend pas du catalogue ni du devis courant et ne donne aucun droit de recréer.
- `acknowledge_action_engine_quote_confirmation` attend un vrai succès A7 fermé. Il compare source/proposition/réservation, reçu et candidat, puis écrit atomiquement le marqueur privé `company_local_action_engine_quote_confirmations` et la transition de l'outbox. Un simple ACK de transport, un reçu historique sans sélecteurs, une autre origine ou un candidat inconnu sont insuffisants.
- Le marqueur mémorise le snapshot canonique. Le rejeu du même succès est historique et ne nécessite plus l'archive ; un autre snapshot ou un état terminal sans marqueur exact ne produit ni backfill ni libération des archives.
- Réception/fusion/restauration conservent les seules données privées locales et l'ordre des clés étrangères. Export, import et changement d'entreprise ne transportent pas cette confirmation privée.
- Le nettoyage reste conservateur : la structure SQL seule ne prouve ni une date réelle ni un manifeste canonique. Le contrôle Rust doit parser les instants RFC3339 et corroborer candidat/marqueur/reçu/outbox avant de relâcher les pins.

**Gel natif et revue finale terminés.** Le nettoyage recorroboré refuse les dates invalides, les manifestes non canoniques et les marqueurs contradictoires. Cette revue porte sur les sources ; elle ne revendique aucune exécution Rust.

## Fichiers

Dans `international-site` :

- Créés : `lib/action-engine/device-execution-contract.ts`, `device-execution-contract.test.ts`, `device-execution-handler.ts`, `device-execution-handler.test.ts`, `native-confirmation-schema.test.ts`, ce rapport et `docs/evidence/action-engine-device-bridge-20261011.json`.
- Modifiés : `lib/action-engine/device-reservation.test.ts`, avec trois compositions handler/A8/A7 ; `lib/action-engine/README.md`, `docs/action-engine/STATUS.md` et `EXECUTION-INTEGRATION-PLAN-20261011.md`.
- Aucun changement de dépendance, aucune route `app/api` ajoutée.

Dans `app-current-corrections` :

- Créé : `desktop/src-tauri/src/action_engine_quote_confirmation_schema.sql`.
- Modifiés : `action_engine_quote.rs`, `action_engine_quote_tests.rs`, `action_engine_quote_publication.rs`, `company_collaboration.rs`, `company_collaboration_action_publication_tests.rs`.
- Copie de ce rapport ajoutée dans `docs/action-engine/DEVICE-BRIDGE-VALIDATION-20261011.md`.

## Migration proposée

SQL privée locale additive de confirmation, installée via le housekeeping existant. Le marqueur A9 version 1, le schéma partagé et `PRAGMA user_version` 62 restent inchangés ; aucune ancienne migration n'est réécrite. Les faits privés restent exclus des archives partagées et des données d'une autre installation.

Aucune nouvelle migration D1/PostgreSQL/Supabase, aucune suppression de données métier et aucune modification de production. Les prérequis et validations staging A4–A9 restent nécessaires avant activation.

## Vérifications et limites de preuve

| Périmètre | Cas | Résultat final |
| --- | ---: | --- |
| Codec privé | 82 | 82/82 réussis ; formatage et lint ciblés réussis |
| Handler | 45 | 45/45 réussis, dont refus d'abonnement expiré et interdiction de ledger |
| Réservation A8 | 43 | Suite ciblée réussie, dont trois nouvelles compositions |
| SQL natif de confirmation | 41 | 41/41 réussis |
| Régression serveur complète | 1 976 | 1 976/1 976 réussis, 59 fichiers, aucun ignoré, 120,53 secondes |

Typecheck final, lint final du périmètre, formatage des six fichiers contrôlés, `git diff --check` des deux checkouts et build de production : **exit 0**. Ils ne prouvent pas une exécution hébergée ou native. Le handler sans route n'est pas un endpoint de production vérifié par ce build. Les avertissements existants Vinext concernent middleware déprécié, temps de plugins et classification de certaines routes. Les suites ciblées recouvrent la régression ; leurs nombres ne doivent pas être additionnés à son total. Le lot ajoute 171 cas distincts aux 1 805 de A9.

Le premier passage complet a donné 1 974 réussites et deux échecs dans les `beforeEach` des suites existantes `intake.test.ts` et `ledger.test.ts`, avec un nettoyage secondaire sur une base fermée. Le build et le typecheck étaient alors simultanés ; la contention est une hypothèse, pas une cause démontrée. Le rapport initial est conservé. La même régression, sans modification de ces suites, de leurs assertions ou timeouts, est repassée seule après la fin des deux contrôles : 1 976 réussites. Ce lot ne prétend pas avoir corrigé la fragilité des fixtures sous charge.

Les trois compositions utilisent le vrai handler, les codecs, A8/A7, les prédicats et les batches/ledgers sur SQLite D1 locale. L'authentification, le chargeur source/catalogue et les frontières PostgreSQL/Storage sont explicitement synthétiques. Le cas de confirmation part d'une preuve canonique déjà durable : il vérifie refus d'un mauvais snapshot, confirmation et rejeu sans doublon, sans prétendre réaliser une publication hébergée. Les tests SQL exécutent le vrai SQL local, pas les méthodes Rust.

Sources natives : **deux nouveaux tests du helper et huit du journal écrits, non exécutés : 99 cumulés avec les 89 précédents**. Les cas écrits couvrent transaction partagée/rollback, origine, lecture historique, ACK perdu, reçu/sélecteurs/candidat, marqueur exact, état terminal et restauration privée. Rustfmt a parsé les cinq fichiers Rust modifiés via `--emit stdout --config skip_children=true` avec sorties 0 ; aucun formatage massif ou contrôle compilateur n'est revendiqué.

**Aucun Cargo, test ou binaire natif exécuté.** Windows App Control 4551 demeure la limite de validation ; il n'est ni retenté ni contourné. Un parse Rustfmt ne constitue pas une compilation. Aucun appel fournisseur/JEV, compte ou donnée client réel, endpoint exposé, IPC, déclencheur Support, notification, activation ou déploiement n'est effectué.

## Terminé, expérimental et suite

Le codec et le handler interne sont implémentés ; les compositions locales corroborent leur raccord avec les mécanismes serveur existants. Le reader/ACK et son marqueur sont codés dans les sources natives, avec validation native toujours manquante.

La composition authentifiée complète côté compte Rust, le transport vers une route validée, le déclenchement Support et l'expérience utilisateur restent à raccorder et valider. Un type de confirmation ou un marqueur SQL ne remplace pas la réception authentifiée d'un vrai succès A7. Avant chaque attente, le futur consommateur doit capturer l'espace/le contexte membre, les recontrôler au retour, reprendre l'ancien reçu/pending avant toute nouvelle écriture et ne jamais confondre publication de transport et preuve métier.

Prochaines barrières : composer le consommateur privé sous générations compte/espace/membre, compiler/exécuter les tests natifs sur un hôte autorisé, vérifier une vraie archive synthétique entre Rust et TS, puis valider staging, reprises après crash et changements de compte avant toute exposition. Aucun port privé ni résultat local n'est présenté comme opérationnel en production.
