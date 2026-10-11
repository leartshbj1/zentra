# A15 — activité historique des devis confirmés, sources privées

## Résultat et état réel

Une projection privée serveur expose les créations de brouillons corroborées par la preuve canonique et le journal de confirmation. Un lecteur natif distinct retrouve les confirmations A10 de l'acteur et de l'installation courants. Le composant existant `AutomationJournal` accepte désormais une page serveur facultative et un callback d'ouverture du devis exact. Ces trois éléments restent séparés : aucun endpoint, IPC, ordonnanceur, caller applicatif ou notification système n'est activé.

Source serveur : `4f3a453d34720698112755099179a33810de48d7`. Source native/UI : `e0597c7c7aad451964d6cefe7025ebb896681d75`. Version **1.90.15**, schémas partagé/sidecar **62**, inchangés. Manifeste : `docs/evidence/action-engine-confirmed-activity-20261011.json`, SHA-256 `99208deea2a1798a390dfe0044d84b8f1065276e08e94143615d1264fcc1f936`.

**La fonction n'est pas livrée dans l'application publique.** Le build web ne compile pas Rust. Windows App Control 4551 reste le blocage natif connu ; aucune nouvelle tentative Cargo, application native, émulateur ou contournement de sécurité n'a été effectué. Aucune migration hébergée, donnée client réelle, analyse JEV en ligne, émission/envoi de document ou opération financière.

## Contrats et comportement

### Historique partagé côté serveur

`readDeviceConfirmedQuoteActivity` réutilise l'authentificateur appareil et son prédicat de lecture actuel. Chaque ligne conserve l'entreprise et la délégation exacte du workspace Support source. Un autre collaborateur/appareil autorisé peut lire le fait historique sans devenir propriétaire de la réservation d'exécution.

La sélection joint proposition, réservation, événement immuable `receipt_confirmed`, preuve canonique A6, liaison de réservation et publications de planification/exécution committed. Empreintes, IDs, acteurs, installations, révisions et instants doivent correspondre. Un ACK de transport, retour fournisseur ou compteur de ronde ne constitue jamais une création confirmée.

Le résultat fermé contient seulement `organizationId`, `items`, `nextCursor` ; chaque élément contient `activityId`, `proposalId`, `quoteId`, `confirmedAt` en secondes Unix, `kind: quote_draft_created` et `requiresHumanValidation: true`. Aucun mail, prix, acteur, installation ou ID de réservation privé n'est renvoyé. Maximum 50 éléments, curseur lié à entreprise/utilisateur/installation, réponse bornée à 64 KiB.

La même page est relue sous autorité fraîche ; divergence et révocation refusent la réponse. La ligne supplémentaire est validée aussi. Le curseur par instant/événement est un sélecteur temporaire : recommencer sans curseur après le parcours, car une transaction peut finir avec un instant capturé antérieur. Il ne promet ni notification exactement une fois ni watermark durable.

Les faits canoniques restent historiques après changement de tête/catalogue, édition ou clôture du mail, pause du connecteur ou modification ultérieure du devis. Si le ticket source est supprimé, l'autorisation de son workspace n'est plus reconstructible : le feed omet sa ligne sans effacer le journal durable. La projection ne revalide pas le ZIP/PostgreSQL à chaque lecture. L'authentificateur existant peut rafraîchir `device_sessions.last_seen_at` ; il n'y a aucune écriture métier ou d'activité.

### Historique local natif

`read_action_engine_quote_activity` est privé et **limité à l'acteur/installation locaux**, pas à l'équipe entière. Il vérifie onboarding et origine réelle même à vide, prend le mutex et une transaction IMMEDIATE, puis sélectionne au maximum `limit + 1` marqueurs A10 avec le SQL natif réel. Aucune jointure ne masque un reçu/outbox/candidat manquant.

Les 13 colonnes attendues, types et tailles sont vérifiés avant allocation. Chaque marqueur et la ligne supplémentaire passent la vraie reprise historique, `same_execution`, l'état outbox Confirmed et la corroboration du candidat/manifeste/hash/instant. Le lecteur ne charge ni catalogue ni devis courant, ne répare pas un schéma et ne crée aucune activité. Édition, émission, suppression ultérieure du devis ou purge du ZIP n'effacent pas le fait historique corroboré.

La pagination locale est BINARY par proposition, non chronologique. La date est une chaîne ISO et le DTO est distinct du serveur : un adaptateur explicite reste nécessaire. Le frontend refuse volontairement une conversion implicite. Aucun résultat local ne remplace la preuve canonique distante ni ne garantit qu'une autre installation a reçu son ACK.

### Journal utilisateur facultatif

`AutomationJournal` conserve son comportement existant lorsque la prop est absente. Une page invalide, indisponible ou étrangère ne devient pas une activité réussie. Les données de l'ancienne entreprise disparaissent immédiatement ; les doublons strictement identiques sont regroupés et les identités contradictoires refusent toute la page.

La ligne « Devis préparé » décrit la création historique, pas le statut éditable actuel. Elle reprend la typographie, les couleurs clair/sombre et les cibles tactiles de 44 px existantes, en français, allemand, italien et anglais. « Ouvrir le devis » existe seulement si le vrai callback est fourni et reçoit uniquement le `quoteId` exact. L'aperçu vérifie cet appel avec des données fictives ; **il n'ouvre pas un vrai document de WorkspaceApp**. Le raccord ultérieur devra résoudre ce devis dans l'entreprise autorisée, gérer sa disparition et ses permissions courantes.

La déduplication du rendu n'est pas une notification persistante ou un état « lu ». Aucun badge/toast système, fetch, bridge ou raccord ControlCentre/Hub/WorkspaceApp n'est ajouté.

## Fichiers

Créés côté serveur :

- `lib/action-engine/confirmed-quote-activity.ts`
- `lib/action-engine/confirmed-quote-activity.test.ts`
- `lib/action-engine/native-confirmed-activity-sql.test.ts`

Modifiés côté natif/UI :

- `desktop/src-tauri/src/action_engine_quote_publication.rs`
- `desktop/src-tauri/src/action_engine_quote_tests.rs`
- `desktop/src/AutomationJournal.tsx`
- `desktop/src/automation-design.css` : trois règles de ligne de devis seulement.

Créés côté UI : `desktop/src/confirmedQuoteActivity.ts`, ses tests `.test.ts`/`.test.tsx`, `desktop/tests/confirmedQuoteActivity.preview.html`/`.tsx`.

Documentation : présent rapport et copie native, manifeste, `STATUS.md`, plan d'intégration et README du moteur. Logs locaux ignorés par Git ; leurs chemins et empreintes sont conservés dans le manifeste.

## Migrations et retour arrière

Aucune migration native, D1 ou PostgreSQL nouvelle ou réécrite, aucun tarif/abonnement changé. Les sélections utilisent les schémas déjà versionnés. Le retrait de ces sources inactives n'exige aucune restauration métier ; conserver les preuves, reçus, outboxes et confirmations permanentes. Les gardes de coordination A4 restent obligatoires pour une entreprise déjà protégée.

## Tests réellement exécutés

| Contrôle | Résultat |
| --- | --- |
| Régression Action Engine | **1 666/1 666**, 46 fichiers |
| Régression adjacente Automation/Support/collaboration | **576/576**, 20 fichiers |
| Total serveur distinct | **2 242/2 242**, 66 fichiers, zéro échec/ignoré |
| Nouveaux tests serveur ciblés | **36/36 + 11/11**, inclus dans les 2 242 |
| Régression UI | **203/203**, 13 fichiers, zéro échec/ignoré |
| Nouveaux tests UI ciblés | **53/53**, deux fichiers, inclus dans les 203 |
| TypeScript sans cache incrémental serveur | Réussi |
| Lint/format des trois nouveaux fichiers serveur | Réussis |
| Build production serveur et assets | Réussis, sans déploiement |
| Build web de l'application, icônes et TypeScript | Réussis ; aucune compilation native |
| Aperçu navigateur | **18/18** cas : quatre langues, deux thèmes, 1440/390 px et allemand 320 px |
| Rustfmt | Deux fichiers parsés via `--emit stdout`, sources inchangées |
| Tests natifs | **8 nouveaux écrits, 189 cumulés, zéro exécuté** |

Les deux cohortes serveur sont disjointes et utilisent au maximum quatre workers avec les chemins natif/PGlite explicites. Les ciblés se recouvrent avec les régressions et ne s'additionnent pas une seconde fois. Vitest affiche 14 suites imbriquées pour la régression UI, mais ses `testResults` contiennent 13 fichiers distincts.

Les 36 tests serveur composent authentificateur, délégation, registre et preuve canoniques sur SQLite et migrations réelles locales ; adaptateurs D1/horloge et archives ZIP synthétiques. Les fixtures de pagination supplémentaires sont des faits stockés cohérents, pas des archives natives indépendamment vérifiées. Aucun résultat hébergé ou archive Rust réelle n'est revendiqué. La revue indépendante du gel serveur n'a trouvé aucun défaut bloquant dans son périmètre statique.

Les 11 tests Node SQLite extraient le **vrai ACTIVITY_SQL Rust** et les trois vrais schémas privés. Ils vérifient colonnes, bindings, origine sélectionnée, pagination/lookahead, rejeu et conservation des lignes orphelines/incohérentes pour le validateur Rust. Ils n'exécutent ni son contrôle d'origine ni sa corroboration sémantique. Les huit nouveaux tests Rust utilisent LocalStore/writer/archive réels avec un résultat privé A7 synthétique ; ils restent seulement écrits.

Les 18 captures ont été ouvertes et vérifiées. Contrôles DOM : absence de débordement horizontal, deux lignes attendues, boutons du Journal >= 44 px, touche Entrée transmettant le bon quoteId et changement d'entreprise retirant les lignes. Ce sont des preuves de l'aperçu web Chromium ; pas des essais iPhone/WebKit/macOS natifs, de zoom texte 200 % ou de notifications réelles.

Revue Impeccable indépendante : `ship`, au seul périmètre de cette extension facultative et des captures fournies. Documentation de design : `extension conforme au système existant, fichiers de design préservés`. Le détecteur unique signale sept rayons 5/9 px dans du CSS préexistant inchangé ; aucun ne concerne les trois nouvelles règles. Le système et ses briefs sont préservés ; `design.json` déjà périmé et un ancien brief orphelin sont signalés sans réparation non demandée.

## Tentatives et limites conservées

- Les premiers essais serveur de la nouvelle projection ont eu des fixtures d'admission/registre incohérentes. Les corrections concernent les fixtures ; journaux initiaux 32/36 et 35/36 conservés, puis 36/36 et régression complète réussis.
- Deux premiers essais SQL ont été arrêtés par le trigger immuable puis par la clé étrangère de la fixture de corruption. Le test final retire explicitement ce trigger et désactive brièvement les FK dans sa seule base en mémoire, les réactive et constate l'orphelin voulu. Aucune garde de production n'est affaiblie. Les deux rapports 10/11 sont conservés ; le final et la régression passent.
- Le premier lancement UI via pnpm a matérialisé les dépendances et exécuté leurs postinstall JavaScript. Aucun package/lockfile source n'a changé. Première suite 52 cas conservée, finale 53 ; aucun test natif lancé.
- Le build web régénère `dark.generated.css` avec le retrait d'une règle Notes préexistante. Ce diff sans rapport est conservé dans la QA puis le fichier suivi est rétabli exactement à HEAD ; il ne fait pas partie du lot. Les nouvelles règles utilisent déjà les tokens, sans ajout généré nécessaire.
- Avertissements de build conservés : gros chunks web et diagnostics/outils existants. Une sortie 0 ne démontre pas performance réseau ou capacité de 150 entreprises.

## Suite et condition d'activation

1. Compiler sur un hôte autorisé et exécuter les **189 tests natifs**, plus restauration/fusion et interopérabilité d'une vraie archive fictive Rust → TypeScript.
2. Valider le protocole coordonné sur un staging approuvé avec plusieurs connexions PostgreSQL et le gateway complet. Aucun droit de migration de production n'est inféré.
3. Après ces preuves, raccorder les contrats privés à l'application : origine actuelle, adaptateur explicite, pagination/rafraîchissement bornés, résolution réelle du devis et état indisponible/absent.
4. Ajouter une notification dédupliquée durable seulement après la confirmation canonique et le marqueur local approprié. La visibilité partagée et l'acquittement local restent distincts.
5. Valider deux vrais appareils, changements de compte/espace, pertes de réponses, permissions et supervision des états incertains avant tout opt-in.

Terminé dans les sources : projection historique serveur, lecteur local de confirmations, contrat/rendu facultatif du Journal et preuves locales ci-dessus. Expérimental/inactif : compilation native, adaptateurs/raccords applicatifs, notification, déclenchement Support et pilote hébergé. **L'objectif global n'est pas atteint.**
