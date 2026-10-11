# A16 — chronologie des confirmations et destination du devis

## Résultat réel

Ce lot corrige dans les sources natives deux chemins qui pouvaient conserver une date incohérente après un recul de l'horloge locale. Il prépare aussi un résolveur TypeScript privé qui retrouve le devis courant dans l'entreprise actuellement admise. Ces changements restent inactifs dans le parcours public Action Engine : aucun raccord d'interface, endpoint, IPC, ordonnanceur ou notification n'est ajouté.

Version **1.90.15** et schémas **62** conservés. Aucun changement de tarif, migration, déploiement, donnée client, appel fournisseur ou opération financière. Le manifeste `docs/evidence/action-engine-confirmation-destination-20261011.json` contient les commits, empreintes et résultats vérifiables. Le rapport est recopié à l'identique dans le checkout natif.

## Correctifs natifs, non exécutés

Le lecteur historique et le nettoyage exigeaient déjà une chronologie RFC3339 réelle. La préparation et l'ACK n'appliquaient pas toujours ces mêmes invariants avant commit.

- `link_prepared` capture maintenant la date de création de l'outbox avec ses autres faits. La comparaison avant/après extraction inclut cette date. Un candidat neuf ou rejoué doit être postérieur ou égal à cette création, en comparant les instants, sans réécrire une date historique.
- `mark_published` vérifie la date de l'ACK transport avant sa première écriture. Le rejeu recorroborre les dates historiques et conserve leur valeur initiale, même si l'horloge actuelle est devenue antérieure. L'ordre lexical des chaînes SQLite ne remplace pas ce contrôle : deux offsets peuvent inverser cet ordre.
- Le nouvel ACK canonique appelle `require_confirmed_candidate` **dans la même transaction IMMEDIATE**, après le marqueur et la transition d'outbox, avant commit. Un échec annule les deux changements. La branche de rejeu conserve sa corroboration existante.

Les horloges incohérentes sont refusées sans inventer une date ou modifier un ancien fait. La correction n'est pas une réparation automatique des enregistrements déjà corrompus ; ceux-ci restent refusés. Aucun trigger ni schéma de production n'est affaibli.

Cinq régressions Rust sont écrites : nouveau lien sous horloge reculée, rejeu de lien antérieur/malformé et équivalence d'offsets, refus atomique/retry d'ACK transport, rejeu historique de transport et rollback/retry de confirmation canonique jusqu'au lecteur d'activité. Les fixtures de corruption utilisent uniquement des bases temporaires et le helper de test existant ; elles ne changent jamais l'horloge du PC. **Ces tests n'ont pas été compilés ni exécutés.**

## Destination actuelle, helper privé

`resolveConfirmedQuoteDestination` reçoit uniquement l'organisation, l'ID du devis et l'origine locale capturée, puis le workspace et l'identité actuellement chargés. Il réutilise `captureWorkspaceMutationOrigin`, exige un scope physique présent, la bonne organisation, une identité prête, le nonce d'origine et une durée de vie active.

La recherche utilise l'égalité exacte de `quoteId` dans `workspace.quotes`. Elle retourne l'objet actuel, même édité ou émis depuis la confirmation historique. Absence et doublons sont refusés ; aucun titre, numéro, client, proposition ou ancienne copie ne sert de repli. Une absence ne prouve pas une suppression : le document peut ne pas être encore chargé.

Le mode proposé est `edit` pour un brouillon avec écriture autorisée localement, `consult` dans les autres cas, notamment en lecture seule. Ce résultat ne confère aucun droit serveur et ne remplace pas les gardes du véritable éditeur. Le futur appelant devra contrôler sa durée de vie après chaque attente et résoudre juste avant l'ouverture.

**Le helper n'est pas raccordé au Journal, à WorkspaceApp ou à DocumentEditor.** Le repli actuel de DocumentEditor sur un ancien `suppliedItem` n'a pas été modifié. Aucun chargement, navigation, stockage ou réseau n'est effectué ; aucune ouverture réelle de devis n'est revendiquée.

## Fichiers

Créés dans `app-current-corrections` :

- `desktop/src/confirmedQuoteDestination.ts`
- `desktop/src/confirmedQuoteDestination.test.ts`

Modifiés dans ce même checkout :

- `desktop/src-tauri/src/action_engine_quote_publication.rs`
- `desktop/src-tauri/src/action_engine_quote_tests.rs`

Documentation : présent rapport et copie native, manifeste, `STATUS.md`, plan d'intégration et README Action Engine côté serveur. Aucun code runtime serveur n'est modifié.

## Vérifications effectuées

| Contrôle | Résultat |
| --- | --- |
| Nouveau helper, ciblé | **48/48**, un fichier, Vitest 4.0.18 |
| Régression UI A15 + helper | **251/251**, 14 fichiers, zéro ignoré/échec |
| TypeScript application, `tsc --noEmit` | Réussi |
| Rustfmt, `--emit stdout --config skip_children=true` | Deux fichiers parsés ; sources inchangées |
| Tests natifs | **5 nouveaux écrits ; 194 cumulés ; zéro exécuté** |

Les 48 ciblés sont inclus dans les 251, pas additionnés à nouveau. Les tests frontend utilisent des documents et identités fictifs et exercent le vrai helper d'origine. Ils ne prouvent aucune autorisation distante ni ouverture native. Les **2 242 tests serveur A15** restent une preuve historique, non relancée dans ce lot puisque le runtime serveur est inchangé.

Deux revues statiques indépendantes du correctif natif n'ont trouvé aucun défaut bloquant ; le helper frontend a aussi été relu indépendamment. Elles ne constituent pas une compilation. Les helpers de corruption retirent plusieurs triggers dans les seules bases temporaires : les nouvelles fixtures ne prouvent donc pas toutes les transitions avec l'ensemble des triggers actifs.

Aucun nouveau build web, aperçu ou capture n'est nécessaire au changement purement logique et non raccordé ; la validation visuelle A15 n'est pas présentée comme une nouvelle vérification. Rustfmt vérifie seulement la syntaxe, pas les types, l'emprunt, les transactions exécutées ou les tests Rust. Aucun Cargo, exécutable de test/app native ou émulateur n'a été lancé.

## Hôte de compilation et blocage

L'audit en lecture seule a retrouvé l'ancien projet CircleCI `leartshbj1/zentra` et un job Windows 235 historiquement réussi. Cela ne prouve ni crédits gratuits ni disponibilité actuelle. La reconnexion normale CircleCI → GitHub « Public repos only » s'arrête sur **« Verify your two-factor authentication (2FA) settings »**. Aucun code, mot de passe, contournement, nouveau consentement ou paiement n'a été saisi. L'onglet temporaire a été fermé.

L'API GitHub accessible retourne 284 runs ; le plus récent, du 27 septembre, est en échec. Le dernier run natif identifié du 20 septembre n'a exécuté aucune étape. La facturation actuelle reste inconnue. Le HEAD natif audité `b5c1fd0e…` est absent du dépôt GitHub accessible ; aucun push ni job n'a été lancé. Codemagic épuisé et Mac indisponible restent des informations historiques non rétablies.

Windows App Control **4551** reste le blocage local connu. Il n'a pas été retenté ou contourné. Une demande précise de terminer la vérification GitHub a été laissée à l'utilisateur ; aucune réponse n'est supposée.

## Retour arrière et suite

Aucune migration ou donnée métier n'est produite par ce lot. Retirer le helper privé et revenir au code précédent ne nécessite pas de restauration, mais réintroduirait les défauts d'horloge identifiés. Préserver reçus, publications, confirmations et outboxes ; ne pas les supprimer pour débloquer une reprise.

La prochaine preuve nécessaire reste la compilation sur un hôte autorisé, l'exécution des **194 tests Rust**, puis l'interopérabilité d'une vraie archive fictive Rust → TypeScript et le staging coordonné. Ensuite seulement : raccords applicatifs sous origine conservée, ouverture réelle du devis, notification durable dédupliquée et essais sur deux appareils. **L'objectif global n'est pas atteint et aucune publication Action Engine n'est annoncée.**
