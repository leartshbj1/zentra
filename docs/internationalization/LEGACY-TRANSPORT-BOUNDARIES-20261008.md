# Frontières des transports historiques — 8 octobre 2026

Cette phase poursuit la [fondation de création US](US-WORKSPACE-CREATION-20261008.md), source de départ `534d61da0a85a9c335f04f5035aea63d3a52ff29`. Elle raccorde les précontrôles pays aux points d'entrée historiques. Elle ne crée pas de souscription US, de finaliseur `ready`, d'entreprise américaine utilisable, de nouveau tarif Stripe ou de fonctionnalité fiscale. Aucun déploiement ni migration de production n'est effectué.

## Comportement

L'identité autorisée de l'entreprise est résolue avant le contrôle national. Une intention US durable, dans n'importe quel état, interdit le transport legacy. Le contrôle précède le corps à importer, la reprise d'un reçu existant, le choix D1/PG, la réservation de numéros, les lectures métier et les opérations de stockage externes. Une table de garde absente ou indisponible n'autorise aucun repli.

Les entrées publiques des bibliothèques sont également protégées : le contournement du routeur par un appel serveur interne ne suffit pas à lire ou écrire les données US avec ce transport. Les lecteurs internes sans contrôle sont privés et ne sont appelés que depuis les entrées protégées de leur propre module. Le lecteur de blobs vérifie le namespace exact `business-sync/{organizationId}/` ; sa boucle de fragments n'ajoute pas un contrôle SQL par fragment. Aucune décision nationale négative n'est conservée entre requêtes ou entreprises.

L'absence d'intention US conserve le comportement historique. **Ce n'est pas une attestation de pays CH.** Les configurations absentes, les entreprises préexistantes et les migrations d'anciens livres exigent toujours leur parcours de validation distinct.

| Famille | Couverture |
| --- | --- |
| Routes HTTP historiques | Bootstrap, transactions, validation, review, delivery, fingerprint, retirement, historique, fichiers et numéros ; sauvegardes appareil/compte ; copie d'entreprise, collaboration et équipe. |
| Bibliothèques D1/R2 | Bootstrap, publication, validation, transactions, projections, empreintes, historique, blobs, fichiers, copie, sauvegardes et réservations. |
| PG, projets et archives | Collaboration, contenu, fichiers projet, listes/upload/download des archives et récupération par compte. |

Les rôles et sessions restent contrôlés. La récupération CH par le compte ne reçoit pas une nouvelle exigence d'abonnement actif. Pour une archive, une première requête résout uniquement l'organisation autorisée via archive/membership ; après le contrôle national, la seconde relit les métadonnées en revalidant membership et la même organisation. Cette lecture d'identité n'est pas présentée comme une absence de tout SQL métier.

Le long poll revalide la session, les identités d'organisation/utilisateur/appareil/session et la garde pays après l'attente avant de retourner le résultat. `/api/account/team` est entièrement legacy : son accès reste fermé pour US jusqu'à un dispatch par édition. Les endpoints globaux d'identité, de profil, de préférences et le parcours international ne sont pas bloqués globalement.

La réponse HTTP de refus conserve le message public et ajoute uniquement le code stable `international_legacy_transport_forbidden`, statut 409. Les exceptions de prestataire, SQL, configuration privée, EIN et reçus ne sont pas sérialisés. Les autres erreurs publiques et contrats de retry restent inchangés.

## Migrations, activation et retour opérationnel

Cette phase n'ajoute aucune migration. Elle dépend de la chaîne D1 `0000..0086` et des migrations PostgreSQL d'admission déjà proposées. **Ne pas déployer ces sources avant la réconciliation et l'application approuvée de leurs dépendances.** Une table absente ferme volontairement le transport CH aussi ; les flags US fermés ne constituent pas un contournement du précontrôle legacy.

Les triggers D1/PG demeurent l'autorité atomique des mutations. Un précontrôle applicatif ne constitue ni transaction distribuée ni verrou entre D1, PG et R2. Les tests d'absence d'appels aux ports ne prouvent pas qu'une course réelle ne peut envoyer aucun octet externe. Aucun déplacement de région, affaiblissement RLS, reset, suppression de données ou modification des migrations antérieures n'appartient à ce lot.

Le retour opérationnel ferme les flags US et conserve intentions, preuves et gardes. Après des admissions, retirer les gardes pour rétablir l'ancien code constituerait une réouverture de transport interdite ; toute reprise doit être examinée avec ses dépendances et accès.

## Validation et limites

Le rapport final, les empreintes et l'inventaire des fichiers de cette phase sont consignés dans [le JSON de preuve](../evidence/legacy-transport-boundaries-20261008.json). Les sorties détaillées sont locales dans `.qa/legacy-transport-boundaries/` et les rapports des revues dans les répertoires de preuve indiqués par ce rapport.

Le premier run consolidé reste enregistré comme échec supersédé : **71 fichiers, 1 874 tests réussis, deux échecs et 63 ignorés**. Les deux cas de reprise/conflit et de position canonique manquante ont été adaptés à la borne d'exécution huit, sans modifier le plafond contractuel douze ni les sources fonctionnelles. Les deux scénarios ciblés passent. **La reprise consolidée V2 est réussie : même sélection de 71 fichiers, 1 876 réussis, zéro échec et 63 ignorés sur 1 939 tests, exit 0.**

| Vérification | Résultat et périmètre | Limite |
| --- | --- | --- |
| Reprise consolidée | `final-tests-v2.json` : 71 fichiers, 1 876 réussis, zéro échec, 63 ignorés ; exit 0. | Sélection de régressions, pas toute la suite du dépôt. Les 63 ignorés sont des fixtures natives optionnelles. Un seul run compte ; les sous-suites ci-dessous ne s'y ajoutent pas. |
| Frontières D1 | 76 exports réellement appelés dans 25 bibliothèques ; 306 tests de refus/indisponibilité et namespace. | Fixture de prédicat réduite ; son état `ready` synthétique n'est pas une admission. |
| Routes historiques | 26 fichiers, 53 opérations HTTP ; 170 tests de frontière. Le rapport séparé 219 inclut 49 régressions existantes. | Auth, garde indisponible et ports contrôlés ; aucun prestataire vivant. |
| PG, projets, archives | 19 exports I/O et huit opérations HTTP, dans 13 tests agrégés ; chaîne réelle de 87 migrations Node SQLite. | Auth/appareil/PG/R2 simulés ; seule l'identité autorisée d'archive US est injectée défensivement. |
| Revue canonique réelle | workerd/D1, Auth et rate limit réels : pics 74 Stripe, 80 prépayé, 79 manuel pour 65 événements. | Majorant analytique 83 = transport 68 + coût Auth/fréquence maximal 15 ; autres parcours non mesurés. |
| Compatibilité V4 | Hash épinglé, plafond douze, pages huit/douze et positions exactes dans la preuve mixte. | Prototype du clone Site 1.46.1 ; aucune recette binaire 1.90.15. |
| TypeScript et lint du lot | Typecheck V2 exit 0 ; 73 fichiers lintés, zéro diagnostic. | Le lint global reste en échec : 116 erreurs dans 35 fichiers dont les blobs sont identiques à la base. |
| Prébuild et Vinext | Exits 0 consignés dans les logs de phase. | Build local ; aucune publication, activation, migration ou installation. |
| Dépendances SQL | 87 migrations D1 et huit PG inchangées, empreintes dans le JSON. | Présence locale ne prouve aucune application en production. |
| Appels de garde | Audit AST des 73 fichiers de code/preuve : 140 appels dans les sources fonctionnelles et sept appels de test, zéro dans une boucle. | Compteur de sites source, distinct du nombre d'exports et du nombre de requêtes exécutées. |

L'inventaire complet comprend **68 fichiers suivis modifiés et cinq fichiers de code/preuve créés**, plus ce document et son JSON de preuve. Aucun fichier de migration n'est modifié. `M` indique une modification depuis la base ; `A` une création de cette phase.

<details>
<summary>Inventaire complet des 73 fichiers de code et preuve</summary>

```text
A lib/business-sync-country-guard.test.ts
A lib/international/legacy-country-error.test.ts
A lib/international/legacy-transport-routes.test.ts
A lib/legacy-cloud-transport.test.ts
A scripts/qa-review-v4-runtime-fixtures.mjs
M app/api/account/collaboration/route.ts
M app/api/account/company-copy/route.ts
M app/api/account/team/route.ts
M app/api/archive/account/[archiveId]/route.ts
M app/api/archive/invoices/[archiveId]/route.ts
M app/api/archive/invoices/route.ts
M app/api/backups/account/file/route.ts
M app/api/backups/account/route.ts
M app/api/backups/chunk/route.ts
M app/api/backups/item/route.ts
M app/api/backups/route.ts
M app/api/projects/sync/file/route.ts
M app/api/projects/sync/route.ts
M app/api/sync/bootstrap/file/route.ts
M app/api/sync/bootstrap/files/route.ts
M app/api/sync/bootstrap/integrity/route.ts
M app/api/sync/bootstrap/publish/route.ts
M app/api/sync/bootstrap/route.ts
M app/api/sync/bootstrap/structure/route.ts
M app/api/sync/history/file/route.ts
M app/api/sync/history/route.ts
M app/api/sync/numbers/route.ts
M app/api/sync/transactions/commit/route.ts
M app/api/sync/transactions/delivery/route.ts
M app/api/sync/transactions/file/route.ts
M app/api/sync/transactions/fingerprint/route.ts
M app/api/sync/transactions/retirement/cancel/route.ts
M app/api/sync/transactions/retirement/route.ts
M app/api/sync/transactions/review/route.ts
M app/api/sync/transactions/route.ts
M app/api/sync/transactions/validate/route.ts
M lib/account.ts
M lib/business-sync-blob-store.ts
M lib/business-sync-bootstrap.ts
M lib/business-sync-committed-files.ts
M lib/business-sync-credit-projection.ts
M lib/business-sync-files-http.ts
M lib/business-sync-files.ts
M lib/business-sync-history.ts
M lib/business-sync-integrity.ts
M lib/business-sync-native-guard-digests.ts
M lib/business-sync-native-guards.test.ts
M lib/business-sync-publication.test.ts
M lib/business-sync-publication.ts
M lib/business-sync-retirement.ts
M lib/business-sync-state-fingerprint.test.ts
M lib/business-sync-state-fingerprint.ts
M lib/business-sync-transaction-chunk.ts
M lib/business-sync-transaction-commit.ts
M lib/business-sync-transaction-delivery.ts
M lib/business-sync-transaction-files.ts
M lib/business-sync-transaction-fingerprint.ts
M lib/business-sync-transaction-review.ts
M lib/business-sync-transaction-transitions.ts
M lib/business-sync-transaction-validation.ts
M lib/business-sync-transactions.ts
M lib/business-sync-validation.ts
M lib/company-collaboration-route.test.ts
M lib/company-collaboration.test.ts
M lib/company-collaboration.ts
M lib/company-content.test.ts
M lib/company-content.ts
M lib/company-copy.test.ts
M lib/company-copy.ts
M lib/document-number-reservations.ts
M lib/international/legacy-country-guard.test.ts
M lib/project-sync.ts
M lib/workspace-backup.ts
```

</details>

Les suites distinguent spies HTTP, SQLite Node avec les migrations réelles, workerd/D1 et PGlite. Une fixture `ready` de prédicat ne prouve pas un finaliseur US : le trigger réel continue de refuser cet état. Les ports Auth/appareil/PG/R2 simulés ne sont pas des résultats de recette client. La mesure D1 doit inclure les contrôles de connexion, de places, de période et de fréquence ; les anciens compteurs HTTP avec ces ports simulés ne sont pas des budgets complets.

La comptabilité suisse, les formats natifs et les corps SQL financiers ne sont pas réécrits pour ajouter une garde pays. Les tests ne constituent pas une certification fiscale, une preuve de charge concurrente ou une validation physique Windows/macOS/iOS/Android.

### Budget et compatibilité du traitement canonique

Les premières mesures HTTP simulaient authentification et rate limit. La revue indépendante a montré que les accès réellement admis peuvent ajouter jusqu'à 15 lectures/écritures, en incluant les places, les preuves de période et une session froide : ce chiffre n'était donc pas un budget de requête complet. Les extractions privées de contexte/chunk réduisent les réentrées sans retirer les contrôles des exports publics.

Le plafond attesté `APPLY_CHANGES=12`, le hash V4, les offsets et les gates CAS restent identiques. Une borne d'exécution interne de huit changements programme des pages plus petites sous ce plafond. Elle ne revalide pas un document avec d'autres règles, ne retire pas de preuve et ne change pas une somme ou une position canonique. La preuve mixte utilise le module réel épinglé au checkpoint de départ (pages de douze), reprend son checkpoint puis alterne pages de huit/douze et requêtes concurrentes sur le même état. Les positions exactes, le hash, la version et le résultat de reprise sont comparés.

Le `desktop` du clone SITE est le prototype **1.46.1** ; son `lifecycle.rs` exige la version de review 4 et une progression monotone, pas une taille fixe de page. Il ne faut pas l'assimiler aux sources publiées de l'application **1.90.15**, qui sont conservées dans un autre clone et utilisent d'autres chemins. La lecture de ce contrat et les tests serveur ne prouvent pas un essai binaire sur les appareils actuels.

Pour la validation structurelle, le helper garde son plafond testé de 24 requêtes par passe grâce à un contexte privé ; ce plafond n'inclut pas les coûts de la route et de la connexion. Les mesures finales workerd avec les vraies fonctions d'authentification et de fréquence, les branches réellement exercées et le majorant issu de revue sont séparés dans le rapport de phase. Aucun budget de tous les endpoints ou de charge multi-clients n'est déduit d'un seul scénario de 65 changements.

## Suite du développement US

1. Catalogue USD validé, droits propres à l'espace et finalisation D1 ; pas de copie d'abonnement CHF ni de prix inventé.
2. Dispatch par édition dans comptes, sélection d'entreprise, invitations et claims/appareils.
3. Onboarding national et rattachement natif isolé du livre CH existant.
4. Fournisseurs, achats, commandes, avoirs, récurrence, documents/mail et workflows persistés ; correction comptable et banques.
5. Fiscalité/prestataire et paiements marchands distincts du SaaS, validation professionnelle puis recette staging avec deux connexions PG, offline et appareils physiques.
