# Zentra US — verticale commerciale du pilote financier V5

Date : 10 octobre 2026. Développement et validation locale terminés, pilote privé TEST.

Plan antérieur : [US-FINANCIAL-PILOT-COMMERCIAL-PLAN-20261010.md](US-FINANCIAL-PILOT-COMMERCIAL-PLAN-20261010.md), commit `e890018`. Base avant cette tranche : `41ef4d8`. Implémentation : `2d98aaa82bf1d131722b4ce4d14dac8bba22f93f`. Preuve finale enregistrée : `docs/evidence/us-financial-pilot-commercial-20261010.json`, recorder strict réussi. Cette livraison atteste les contrôles locaux décrits ci-dessous et ne constitue aucune publication ou activation hébergée.

## 1. Résumé des modifications

Le pilote ajoute la création d’un client, la création et la modification d’un devis, puis son acceptation interne depuis le navigateur. Ces intentions utilisent le même livre V5 et les commandes commerciales existantes ; aucun deuxième moteur ou état financier autoritatif n’est créé. Les devis restent des documents commerciaux avant détermination des sales taxes. L’acceptation enregistrée n’est ni une signature ni une preuve d’accord externe du client.

Le contrat public fermé utilise `consumer: financial-pilot`, `schemaVersion: 1`, `requestId`, la révision globale attendue et une commande parmi `create_customer`, `save_estimate`, `accept_estimate`. L’édition et l’acceptation indiquent également la révision exacte du devis. Le serveur impose l’organisation, la devise USD et la clé privée `pilot:commercial:<requestId>`. Les nouveaux clients, devis et lignes reçoivent des IDs déterministes dérivés du requestId ; l’édition conserve les IDs des lignes existantes. Le navigateur ne fournit ni rôle, numéro, statut, total, grant, policy, preuve fiscale ou écriture comptable.

Le nouveau détail public expose le devis, son snapshot client, l’association au projet, les dates, conditions, notes, lignes, traitements fiscaux déclaratifs et montants exacts avant taxe. Il est reconstruit depuis le livre courant validé et lié aux révisions de l’entreprise et du devis. Les getters, prototypes inattendus et champs privés sont refusés ; les données sont capturées et détachées avant les attentes asynchrones. Quantités et minor units restent des chaînes canoniques ; calculs et arrondis réutilisent les primitives existantes.

Les formulaires Clients et Devis se raccordent au pilote existant, aux quatre langues et aux thèmes clair/sombre. Ils permettent la sélection des clients au-delà de la première page, la conservation des brouillons et leur revue explicite lorsqu’une révision change. Ces comportements sont exercés dans les recettes navigateur enregistrées. Paiements et commandes commerciales partagent le même verrou de mutation et la même reprise exacte. Un résultat inconnu conserve la requête initiale ; une nouvelle révision ne retargete pas automatiquement une mutation en attente. Les réponses tardives sont liées à l’instance, à l’utilisateur et à l’espace.

Limites publiques : 100 lignes, 256 KiB par requête, descriptions de 4 000 unités UTF-16 et notes de 20 000. Le détail accepte les 1 000 lignes admises par le domaine historique sans troncature. Le test d’un historique de 101 lignes confirme sa lecture complète et le refus de le soumettre au contrat d’édition limité à 100 lignes ; l’interface indique cette limite. La recette visuelle conserve 28 captures, dans les quatre langues, les deux thèmes et aux largeurs 320, 390 et 1 440 px. La revue indépendante finale confirme un avis « ship » limité au pilote privé TEST.

## 2. Fichiers créés

Inventaire figé du code nouveau : 17 fichiers, repris dans `.qa/us-commercial-pilot/implementation-files.json` et la capture des sources de qualité :

- `app/api/international/workspaces/[organizationId]/financial-pilot/commercial/operations/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/estimates/[estimateId]/route.ts`
- `components/account/us-financial-pilot-commercial.css`
- `components/account/us-financial-pilot-commercial.tsx`
- `lib/international/browser-us-financial-pilot-commercial-copy.ts`
- `lib/international/browser-us-financial-pilot-commercial-input.test.ts`
- `lib/international/browser-us-financial-pilot-commercial-input.ts`
- `lib/international/browser-us-financial-pilot-commercial.test.ts`
- `lib/international/us-financial-pilot-commercial-bindings.test.ts`
- `lib/international/us-financial-pilot-commercial-bindings.ts`
- `lib/international/us-financial-pilot-commercial-projection.test.ts`
- `lib/international/us-financial-pilot-commercial-projection.ts`
- `lib/international/us-financial-pilot-commercial-server.test.ts`
- `lib/international/us-financial-pilot-commercial-server.ts`
- `lib/international/us-financial-pilot-commercial.postgres.test.ts`
- `lib/international/us-financial-pilot-commercial.test.ts`
- `lib/international/us-financial-pilot-commercial.ts`

La livraison documentaire et sa preuve sont distinctes du commit d’implémentation. Les fichiers de préparation et rapports `.qa` sont ignorés et ne sont pas des modules de l’application.

## 3. Fichiers modifiés

- `components/account/us-financial-pilot.tsx`
- `lib/international/browser-us-financial-pilot-session.ts`

L’intégration conserve la session du pilote pour les paiements, les lectures, le polling et le nouveau transport commercial. L’inventaire figé contient ces deux modifications et les 17 nouveaux fichiers ci-dessus, soit 18 fichiers TypeScript/TSX et une feuille CSS. Il ne modifie aucun ancien module CH, abonnement, identifiant Stripe, dépendance ou migration. La capture avant/après des contrôles de qualité conserve les mêmes 3 538 fichiers et l’empreinte `d8ac0d5104cfbbe55137682ecf77cab4b4d7fd8a26c79841c2b685fb0284dd56`, rattachées au commit d’implémentation dans la preuve finale.

## 4. Migrations proposées et retour arrière

**Aucune nouvelle migration.** Les routes réutilisent les 32 migrations du pilote, les wrappers privés existants et leur capacité V5 cumulative. Les commandes commerciales sont déjà prises en charge par `executeUsFinancialKernelV5`, `transitionUsFinancialErpV5` et les gardes SQL. Aucun protocole public ERP5 n’est ouvert.

L’accès demeure fermé par défaut : opt-in TEST vivant et versionné, grant privé, espace US/USD/accrual, abonnement Gestion effectif et rôle owner/admin/accountant. Aucun accès supplémentaire pour member/read_only. Les routes exigent l’utilisateur attendu, le scope du pilote, les cookies same-origin et une origine autorisée ; les credentials natifs et l’en-tête Authorization sont refusés. Auth/D1, configuration, flags, scope/grant/opt-in sont revérifiés autour des attentes. Les réponses ne contiennent pas le livre privé, ses preuves, sa policy ou des secrets.

Le CAS lie l’append à la révision globale ; le domaine contrôle aussi la révision du devis, les clients/projets sélectionnés et le verrouillage d’un devis déjà facturé. La garde PO008 protège les sources des commandes commerciales actives lors d’une nouvelle mutation. Les tests PostgreSQL confirment le refus de ces mutations et la priorité des reçus historiques exacts, sans requalification par un verrou apparu ensuite. Ils confirment aussi qu’une collision d’ID client dérivé préserve la donnée existante. Les reçus publics lient l’action concrète, l’entité et la révision à la demande ; ils ne prétendent pas distinguer un succès concurrent d’un rejeu via un booléen non fiable.

Les données commerciales, événements, reçus et révisions sont effectivement persistés dans le pilote autorisé. En revanche, ces trois intentions n’ajoutent **aucune écriture comptable**, aucun paiement, aucune taxe calculée ou action de prestataire. Le journal et les soldes des factures ne sont pas modifiés par un devis ou son acceptation.

Retour arrière : fermer les flags du pilote et revenir au code antérieur selon la procédure existante, sans supprimer les événements, reçus, grants ou marqueurs V5. Une entreprise promue ne doit jamais retomber silencieusement sur sa baseline ERP4 figée. Aucune modification hébergée ou publication n’a été exécutée dans cette tranche.

## 5. Tests exécutés et résultats

**Validation locale finale : 5 819/5 819 tests réussis dans 175 fichiers, dont les 168 précédents conservés ; aucun échec, skip ou todo.** Les résultats ci-dessous ont été lus dans les rapports enregistrés, sans répéter les essais pendant le gel. Les suites ciblées et la revue backend se recoupent : leurs nombres ne s’ajoutent pas une seconde fois au total de régression.

| Contrôle | Résultat observé ou état |
| --- | --- |
| Contrat/constructeur commercial | 38/38 tests ciblés exécutés, sortie 0. |
| Projection détaillée et vrai noyau mémoire | 6/6 tests ciblés exécutés, sortie 0. |
| Lint typé des quatre fichiers contrat/projection | Sortie 0, deny-warnings. |
| Serveur et bindings | 43/43 serveur et 26/26 bindings ; rapport final figé, sortie 0. |
| Transport navigateur | 37/37 commerciaux et 71/71 de la session existante, soit 108/108 ciblés, sans échec ni pending. |
| Recette PostgreSQL commerciale | 15/15, 32 migrations existantes, aucune nouvelle ; fermeture/réouverture NodeFS confirmée. Avec serveur et bindings : 84/84, échecs 0, pending 0, sortie 0. |
| Régression finale, dont parseurs de saisie | 5 819/5 819 ; 175 fichiers exécutés, dont 168 conservés et 7 nouveaux ; échecs, pending/skip et todo : 0. Sélection exacte et empreinte du rapport dans la preuve finale. |
| TypeScript global non incrémental | Sortie 0 dans `quality-commands.json`. |
| Lint typé du périmètre complet | 18 fichiers TypeScript/TSX, type-aware et deny-warnings, sortie 0. |
| Vérification des ressources de marque | Sortie 0 dans `quality-commands.json`. |
| Build | Sortie 0, sources figées identiques avant/après. Un build ne constitue pas un déploiement. |
| Inspection visuelle locale | 28 captures conservées, FR/DE/IT/EN, clair/sombre, largeurs 320/390/1 440 px ; correction ciblée de la case à cocher puis confirmation. Détecteur final : `[]`. |
| Revue backend indépendante | Trois défauts reproduits et corrigés ; avis final sans problème backend, confidentialité, permissions, idempotence ou arrondi encore actionnable dans le périmètre relu. 178/178 essais de revue, déjà inclus dans les autres suites. |
| Revue indépendante finale | Avis « ship for the private TEST financial pilot » ; 28 PNG finaux ouverts et contrôlés, aucun défaut bloquant du raccord commercial. Limites du contrôle consignées dans `design-finish-review.md`. |
| Commit et preuve finale | Code `2d98aaa` ; recorder strict réussi, empreintes des 19 sources, du rapport global et des captures enregistrées dans `docs/evidence/us-financial-pilot-commercial-20261010.json`. |

Les rapports ciblés du contrat/projection se trouvent dans `.qa/us-financial-commercial/contract-projection-tests.json`, `.log` et `contract-projection-lint.log`. Ils vérifient les DTO fermés, identités serveur, montants exacts supérieurs à MAX_SAFE_INTEGER, dates/adresses, limites, doublons, getters et captures immuables. Le vrai noyau V5 et son CAS mémoire créent un client, créent/modifient/acceptent un devis et conservent le journal comptable identique. Ils lisent un historique de 101 lignes sans troncature et vérifient les refus de révision périmée, source corrompue, détail manquant et réponse incohérente. Cette recette mémoire ne prouve pas la persistance PostgreSQL.

La preuve `.qa/us-financial-commercial/server-pg-proof.json` enregistre les 84 essais serveur/bindings/PostgreSQL et les empreintes de ses sept fichiers. Les 15 cas PostgreSQL exécutent les 32 migrations existantes et les vrais handlers Request/Response, avec données fictives, Auth/D1 et observations fiscales synthétiques. Ils couvrent deux sessions HTTP, création/édition/acceptation, CAS global et révision du devis, reprise exacte après réponse perdue et paiement intermédiaire, requestId réutilisé avec un contenu différent, IDs de lignes étrangers, collision client, PO008 et devis facturé, reçus historiques prioritaires, révocation grant/opt-in, isolation d’utilisateur/espace/rôle/credentials natifs, conservation des avoirs/paiements et du journal, puis fermeture/réouverture NodeFS. La recette rouverte conserve le devis accepté et le livre à la révision 11. Les deux sessions de handlers synthétiques ne sont pas deux navigateurs visuels ; PGlite sérialisé ne démontre ni course multiconnexion, ni charge, ni récupération après crash, ni Supabase hébergé.

La revue indépendante `.qa/us-commercial-pilot/backend-review.md` a fait corriger trois défauts matériels avant le gel : la provenance des IDs de lignes retenues, la réadmission complète avant une erreur dépendant d’une source asynchrone, et la récupération d’un reçu lorsque la demande initiale a committé entre la lecture du reçu absent et celle du livre. Seul le `revision_conflict/409` propre au runtime permet une reprise exacte bornée après réadmission complète ; un verrou de source ne déclenche pas de reprise. L’avis final ne relève plus de problème actionnable dans ce périmètre. Ses 178 essais sont un recoupement contrat/projection/navigateur/bindings, pas un total supplémentaire.

La preuve `.qa/us-commercial-pilot/visual-proof.json` conserve les 28 captures et leurs empreintes. Elle enregistre création/édition/acceptation, mise à jour automatique du second client, reprise après réponse perdue, brouillon conservé, sélection d’un client après la première page et effacement lors d’un refus d’accès. Les captures couvrent quatre langues, deux thèmes et les largeurs 320, 390 et 1 440 px ; elles ne représentent pas une matrice exhaustive de toutes les combinaisons. Après une première inspection groupée, la case à cocher a été corrigée avec une cible de 46 px et une case de 20 px, puis contrôlée à nouveau. Le détecteur final `.qa/us-commercial-pilot/ui-detector-final.json` contient `[]`. Le noyau V5 mémoire est réel et les données/autorités restent fictives ; la persistance est éprouvée séparément par PostgreSQL. La recette de réponse perdue committe réellement la commande puis substitue un HTTP 503, sans simuler une véritable panne réseau. La conversion des captures JPEG en PNG conserve les pixels RGB décodés, attestés dans `capture-format-proof.json` ; il ne s’agit pas de captures PNG originales sans perte du navigateur.

La revue indépendante de finition `.qa/us-commercial-pilot/design-finish-review.md` a ouvert les 28 PNG finaux et contrôlé leurs dimensions, empreintes et pixels décodés. Elle confirme la correction de la case à cocher, les contrôles contenus dans la largeur disponible, la hiérarchie des actions et la cohérence des états de brouillon, reprise et refus. Les images très hautes dépassent la limite d’affichage de l’outil ; leurs rasters complets ont été décodés et vérifiés séparément. Son verdict est « ship » pour ce pilote privé TEST, sans nouveau défaut bloquant. Ce contrôle ne remplace pas des essais indépendants de lecteur d’écran, clavier, appareil tactile ou contraste instrumenté.

## 6. Risques identifiés

Les contrôles Auth/D1 et les grants PostgreSQL appartiennent à des autorités distinctes. Les fences successives ne constituent pas une transaction distribuée et n’éliminent pas une révocation survenant après le dernier contrôle. Les credentials service_role restent une frontière serveur de confiance ; le consommateur ne prétend pas interdire leurs lectures arbitraires.

Une panne ou une réponse perdue après le commit peut laisser un résultat inconnu côté navigateur. La reprise doit conserver le même requestId, contenu et révisions, sans nouvelle mutation concurrente ni succès optimiste. Un conflit connu nécessite un rafraîchissement et une revue explicite du brouillon ; ses champs ne doivent pas être écrasés silencieusement par le polling. Les données et brouillons doivent être effacés lors d’une révocation ou d’un changement d’espace.

La sauvegarde d’un devis accepté produit un nouveau brouillon selon les règles existantes ; l’interface doit rendre ce changement compréhensible. Une acceptation est une confirmation interne, jamais une signature électronique ou une preuve juridique. Un total de devis reste avant sales tax et ne détermine pas l’obligation fiscale d’une entreprise. Un historique dépassant les limites publiques doit être présenté complètement ou refusé explicitement, jamais réduit en silence.

Les essais PGlite/mémoire, les callbacks d’autorité synthétiques et les contrôles navigateur locaux ne démontrent ni capacité de charge, SLA, résistance aux crashes, admission hébergée, publication native ou conformité comptable/fiscale. Les 28 captures et le résultat `[]` du détecteur sont bornés aux écrans et conditions inspectés ; ils ne garantissent pas l’absence de tout défaut visuel dans l’application. Les revues backend et de finition indépendantes sont terminées avec les limites précisées ci-dessus. La navigation héritée conserve son défilement horizontal mobile ; une bande terminale claire de certaines captures sombres appartient au harness local et ne recouvre pas les contrôles commerciaux. Ces observations adjacentes ne constituent pas un défaut bloquant du raccord commercial.

## 7. Fonctionnalités terminées

Implémentation locale des contrats commerciaux fermés, du constructeur vers les trois commandes existantes, des IDs dérivés, des reçus liés à la demande et du détail complet de devis. Les tests ciblés attestent la création/édition/acceptation sur le vrai noyau mémoire avec arithmétique exacte, snapshot client historique et absence d’effet sur le journal.

Les routes, bindings, transport partagé et formulaires sont implémentés et exercés : 84 essais serveur/bindings/PostgreSQL, 108 essais navigateur ciblés et 28 captures locales sont enregistrés. La reprise exacte, les brouillons, le second client automatique et les refus d’accès font partie des recettes confirmées. Les trois défauts de la revue backend ont été corrigés avant le gel. La régression finale réussit 5 819 tests dans 175 fichiers, les quatre contrôles de qualité sortent à 0, la revue indépendante confirme le raccord local et le recorder lie les preuves au code `2d98aaa`. Aucun état « terminé en production » ne peut être déduit de cette section.

## 8. Expérimental et prochaine phase

Le consommateur reste un pilote privé TEST et fermé par défaut. Aucun provisioning, activation commerciale hébergée, changement de tarifs/abonnements, distribution Windows/macOS/iOS/Android ou migration de données n’est livré ici. Les entreprises et données CH existantes restent hors de ce raccord.

L’émission fiscale d’une facture depuis ce parcours, les avoirs navigateur, le PDF du devis, l’envoi d’e-mail, la signature, les prestataires fiscaux et paiements marchands réels sont des tranches distinctes. Ce lot n’annonce ni conformité US GAAP, ni certification, ni validation fiscale professionnelle. L’objectif ERP US complet demeure actif ; la prochaine tranche doit préserver le livre V5 unique, les événements historiques, les contrôles d’autorité et les reprises exactes.
