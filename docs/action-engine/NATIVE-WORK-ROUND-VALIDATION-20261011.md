# A14 — ronde native privée, reprise locale avant nouveau devis

## Résultat et état réel

Les sources de l'application relient désormais le contrat privé A13 de découverte/préparation au consommateur A11 de réservation, création, publication et confirmation. Une ronde conserve une seule origine compte/entreprise/membre/installation, reprend d'abord les intentions locales, puis parcourt les demandes Support par pages bornées. Une vérification atomique ferme aussi le cas où une autre préparation crée une intention pendant une attente réseau.

Source native : `52e507e6abb93aa31214c795dae54ee8e5eb88cc`. Source du nouveau test SQL serveur : `50d9e3816254b49b5890fdfd318ad7cd6b5c4984`. Les versions restent **1.90.15**, schéma partagé/sidecar **62**. Manifeste : `docs/evidence/action-engine-native-work-round-20261011.json`, SHA-256 `493d6788a206827a3d5a5d3ad1332803d0ea215cc8ff9b216c674dfcf6dae47a`.

**Sources privées, non compilées et non activées.** Aucun endpoint, IPC, ordonnanceur, callback Support, notification ou opt-in ajouté. Aucun déploiement, migration hébergée, appel JEV en ligne ou donnée client réelle. Le succès des tests serveur ne prouve pas le fonctionnement de l'application native.

## Modifications

- Le codec Rust accepte seulement les enveloppes fermées `discover`/`prepare` : IDs ASCII bornés, curseur explicite même lorsqu'il vaut `null`, raisons de revue connues, empreinte SHA, état cohérent et validation humaine obligatoire. Les clés dupliquées, champs supplémentaires, incohérences et réponses excessives sont refusés. Un résumé n'établit jamais l'autorité du plan complet.
- Le transport privé conserve son origine HTTPS fixe et sa session appareil protégée. Le travail A13 dispose de plafonds propres de 8 KiB par demande et 16 KiB par réponse ; l'exécution A10 conserve ses plafonds de 2 KiB/128 KiB. Aucun réglage de transport ne vient de la WebView.
- `read_action_engine_quote_recovery_work` prend le mutex local et une transaction IMMEDIATE, exige l'onboarding et l'origine réelle même à vide, puis lit au maximum `limit + 1` lignes. Le LEFT JOIN conserve les orphelins. Chaque sélection, y compris la ligne supplémentaire, passe les vrais contrôles historiques de reçu, hash de demande, audit et outbox. La lecture ne répare aucun schéma et ne consulte pas les documents/catalogues actuels pour réinventer l'historique.
- `begin_quote_work_round` capture l'origine une fois. Chaque `advance_quote_work_round` traite un lot de reprise ou une page de découverte, sans boucle d'arrière-plan. Taille fixée à 20, maximum de 10 000 sources par ronde, doublons et cycles refusés. Une file locale non vidée empêche la découverte fraîche.
- Le curseur est conservé seulement en mémoire et avancé après réussite de toute la page et dernier contrôle d'origine. Une interruption laisse le curseur inchangé ; les effets déjà engagés restent récupérables par leur journal. Après parcours complet, une nouvelle ronde repart sans curseur afin de retrouver aussi les anciens tickets devenus admissibles tardivement.
- `execute_quote_draft_at` réutilise l'origine initiale ; il ne recapture pas un nouveau compte après préparation. Le résumé ou sélecteur de reprise est lié à l'empreinte exacte du résultat A8 avant toute écriture ou ACK. `Held` n'accorde aucune écriture. Les vrais A8/writer/publication/A7/ACK restent les seuls chemins de production.
- Le writer de production `commit_action_engine_quote_draft_after_recovery` vérifie, dans son IMMEDIATE et après rejeu historique exact, l'absence d'un autre outbox non confirmé pour l'entreprise. L'erreur `recovery_pending` ne crée aucun second devis. L'ancien wrapper multi-reçus est désormais **`#[cfg(test)]` uniquement** ; il sert aux fixtures historiques. Aucun appel de production à ce wrapper ne subsiste.
- Les compteurs de lot sont volatils : ils ne constituent ni une activité durable ni une notification. Ces dernières devront suivre la confirmation canonique et l'ACK local, avec déduplication entreprise/proposition.

## Fichiers

Créé côté serveur : `lib/action-engine/native-work-recovery-sql.test.ts`. Aucun runtime serveur modifié dans A14.

Modifiés côté natif :

- `desktop/src-tauri/src/account_cloud_action_engine.rs`
- `desktop/src-tauri/src/account_cloud_action_engine_tests.rs`
- `desktop/src-tauri/src/action_engine_device_protocol.rs`
- `desktop/src-tauri/src/action_engine_device_protocol_tests.rs`
- `desktop/src-tauri/src/action_engine_quote.rs`
- `desktop/src-tauri/src/action_engine_quote_publication.rs`
- `desktop/src-tauri/src/action_engine_quote_tests.rs`

Documentation : présent rapport, manifeste, `STATUS.md`, `EXECUTION-INTEGRATION-PLAN-20261011.md`, `lib/action-engine/README.md`, et copie du rapport dans le checkout natif. Scripts et logs locaux : `.qa/action-engine-native-work-round/` ; leurs empreintes figurent dans le manifeste.

## Migrations et retour arrière

Aucune migration native, D1 ou PostgreSQL nouvelle/réécrite. Les requêtes opèrent sur les schémas A3/A9/A10 déjà versionnés. Aucune suppression de données ni modification d'abonnement.

Le lot étant inactif, son retrait source n'exige pas de restauration métier. Conserver les reçus, outboxes, publications et confirmations existants. Les obligations permanentes de coordination A4 ne disparaissent pas : une entreprise déjà protégée ne peut revenir à un ancien transport non coordonné.

## Tests réellement exécutés

| Contrôle | Résultat |
| --- | --- |
| Régression Action Engine | **1 619/1 619**, 44 fichiers |
| Régression adjacente Automation/Support/collaboration | **576/576**, 20 fichiers |
| Total distinct | **2 195/2 195**, 64 fichiers, zéro échec/ignoré |
| Nouveau test SQL ciblé | **22/22**, inclus dans le total ; 13 sélection + 9 garde |
| TypeScript sans cache incrémental | Réussi |
| Lint et format du nouveau test | Réussis |
| Assets et build production serveur | Réussis, sans déploiement |
| Rustfmt | Sept fichiers parsés, sans compilation ni exécution Rust |
| Tests natifs | **45 nouveaux écrits, 181 cumulés, zéro exécuté** |

Les 45 tests natifs ajoutés se répartissent en 18 codecs, 9 lectures de reprise, 4 gardes du writer et 14 rondes/origines/interruptions. Aucun Cargo, test/build/application natif, émulateur ou contournement App Control tenté. Rustfmt a formaté les deux fichiers du consommateur ; la passe de preuve sur sept fichiers utilise `--emit stdout` et vérifie qu'elle ne modifie pas les sources.

Les deux cohortes complètes sont disjointes, avec quatre workers maximum et les variables `ZENTRA_NATIVE_SOURCE_ROOT`/`PGLITE_MODULE_DIR` explicitement renseignées. Elles passent avant la dernière correction de format du nouveau test. Le premier contrôle de format a échoué ; seul oxfmt a changé la présentation, puis les 22 tests ciblés et les contrôles ont été relancés. Les premiers logs sont conservés, et les ciblés ne sont pas additionnés une seconde fois au total distinct.

Périmètres de preuve :

1. Les 22 nouveaux tests Node SQLite extraient **les deux vraies requêtes Rust** et utilisent le vrai schéma natif. Ils prouvent sélection, ordre BINARY, jointure/scope entreprise, ligne supplémentaire, vidage, états et prédicat de garde. Ils n'exécutent ni le lecteur/writer Rust ni leurs contrôles d'origine/audit ; ils ne prouvent pas le placement atomique de la garde.
2. Les 14 tests natifs de ronde utilisent le vrai LocalStore et une licence de test signée. Certains préparent une intention avec le vrai writer et ses reçus/outboxes. Les futurs HTTP et exécution de la ronde sont synthétiques et ne produisent aucune confirmation canonique prétendue. **Ces tests sont seulement écrits.**
3. Les régressions serveur existantes conservent leurs propres périmètres : bases locales D1/workerd, SQLite et PostgreSQL éphémère selon la suite, ports externes synthétiques. Elles ne remplacent pas des essais hébergés, plusieurs appareils ou une archive réellement produite par Rust.

Deux défauts ont été corrigés par revue statique : contrôle de file vide susceptible de devenir périmé pendant le réseau, fermé dans le writer transactionnel ; fixture de corruption qui aurait été arrêtée par le trigger SQL avant d'atteindre le lecteur, corrigée en retirant explicitement ce trigger dans sa base jetable. Les gardes de production ne sont pas affaiblies.

## Risques, limites et suite

- **Windows App Control 4551** reste le blocage de compilation connu. Compilation, 181 tests natifs, restauration/fusion et interopérabilité d'une vraie archive synthétique Rust → TypeScript doivent passer sur un hôte autorisé avant activation. Aucune nouvelle tentative du blocage.
- Le staging PostgreSQL avec plusieurs connexions et le gateway complet reste obligatoire. Les transactions locales ne sont pas une transaction distribuée D1/PostgreSQL/SQLite.
- Les erreurs de travail `busy`/`uncertain` sont conservativement refusées côté natif, sans nouvelle analyse automatique. Une présentation spécifique et un rapprochement supervisé restent à construire.
- Une réservation créée juste avant une erreur native demeure durable ; elle doit être reprise avec ses mêmes sélecteurs, sans transfert automatique ni duplication. Une corruption ou origine étrangère bloque la reprise, sans réparation silencieuse.
- Les bornes de sortie/mémoire et le quota de 500 demandes de travail par heure ne prouvent ni une cadence de trois secondes ni la capacité de 150 entreprises. Mesures de charge et stratégie de cadence restent à définir avant un ordonnanceur.
- L'activité persistante, l'ouverture du vrai devis et la notification dédupliquée après confirmation/ACK restent à raccorder. Aucun document n'est émis ou envoyé automatiquement.

Terminé dans les sources : codec de travail, lecteur de reprise, ronde à origine constante, liaison d'empreinte et garde atomique avant nouveau brouillon. Expérimental/inactif : compilation et parcours natifs réels, supervision, notification et déclenchement utilisateur. L'objectif global reste actif et non atteint.
