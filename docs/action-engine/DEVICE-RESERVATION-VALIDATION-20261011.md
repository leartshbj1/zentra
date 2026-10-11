# Action Engine — A8 : réservation d'exécution privée

## Résultat et périmètre

Le raccord serveur privé distingue une nouvelle exécution autorisée, une réservation détenue par un autre appareil, une création historiquement prouvée et une reprise locale qui ne donne aucun droit de créer. Il prépare la frontière nécessaire au writer natif ; il ne l'appelle pas encore.

**Lot local, non exposé et non déployé.** Il n'ajoute aucun endpoint, IPC, déclenchement Support, appel modèle, notification, émission ou envoi de devis. La partie native reste à compiler et à tester sur un hôte autorisé. Les 68 tests Rust des lots antérieurs ne sont pas exécutés ; le blocage Windows App Control 4551 n'a pas été retenté ni contourné.

La régression finale passe **1 730/1 730 tests dans 55 fichiers**, sans test ignoré, en **129,892 secondes**. Les **89 nouveaux cas** couvrent la composition (40), le classifieur (40) et les vrais budgets SQL (9). Typage, lint ciblé, format et build serveur passent aussi ; aucune validation native ou hébergée n'est comprise dans ces résultats.

Code serveur : `23c32a5e6e0b2adda97f30d18e2837e61d6dbed8`. Le manifeste `docs/evidence/action-engine-device-reservation-20261011.json` contient les empreintes des six sources créées, les résultats et les empreintes des rapports locaux. Taille : **432 530 octets** ; SHA-256 : `938467a8b43f4abdcf08a9c54bfcc972311f83ce56dff12972c86b69cbc70798`. Le checkout natif reste au commit `a7f278c8f88fb8129ffe6fc1f4dc49414c0f6a8b`, sans modification A8.

## Fichiers et responsabilités

- `lib/action-engine/reservation-state.ts` et son test : classification privée par SELECT sous assertion SQL, avec projection de propriété dans SQL. Une réservation d'autrui ne charge pas ses identifiants, son reçu ou sa preuve dans le résultat. Absence de proposition, table manquante, résultat malformé et réponse perdue ne deviennent jamais `unreserved`.
- `lib/action-engine/device-reservation.ts` et son test : composition authentifiée fermée `{sourceId, proposalId}`, identité appareil issue du serveur, droits actuels et délégation Support, confirmation A7 éventuelle ou progression complète avant réservation. Elle crée le registre avec la liaison de provenance initiale, écrite dans le même batch que la réservation.
- `lib/action-engine/device-reservation.fixture.ts` : migrations D1 cumulées réelles jusqu'à 0104, transactions SQLite, deux connexions possibles, registres et gardes réels. Les ports d'authentification et de chargement sont explicitement synthétiques dans cette fixture ; ses tables QA ne sont pas un miroir d'autorisation en production.
- `lib/action-engine/device-reservation-budget.test.ts` : neuf tests réussis séparément puis dans la régression, avec les vrais prédicats d'autorité, source et publication. Le vrai authentificateur appareil est exécuté sur des droits payés synthétiques locaux, sans Stripe hébergé. La garde finale est reproduite pour vérifier sa composition ; les 40 tests du wrapper exercent séparément sa dernière attente réelle.

Aucune source existante d'exécution ou native n'est modifiée par A8. Aucune migration D1 ou Supabase nouvelle, aucun backfill et aucune donnée supprimée. Les migrations proposées par les lots antérieurs restent à valider et déployer dans l'ordre avant activation.

## Contrat de retour

| État | Signification | Droit d'écriture fourni |
| --- | --- | --- |
| `held` | La réservation permanente appartient à un autre acteur ou une autre installation. | Aucun ; seul l'ID de proposition déjà demandé est retourné. |
| `confirmed` | A7 a corroboré la preuve canonique durable de la création initiale. | Aucun ; reçu de création du brouillon existant. |
| `recovery_required` | La réservation appartient à cet appareil, mais la progression courante n'est plus autorisée. | Aucun ; uniquement proposition/réservation/empreinte pour rechercher un reçu local. |
| `reserved` | La progression complète reste autorisée et cette réservation exacte n'a ni reçu ni preuve au dernier contrôle SQL. | Input privé pour la future orchestration Rust, qui devra encore vérifier ses faits locaux. |

Le résultat `reserved` contient le plan canonique original, son empreinte, la source capturée, les IDs réservés par le serveur, l'identité appareil et la provenance de planification. L'appelant ne choisit ni prix, rôle, IDs métier, source textuelle, SQL, reçu ou capacité d'autorisation.

Le plan et la source ne sont pas reconstruits depuis une empreinte. Leur JSON canonique est recalculé et comparé à la proposition et à sa liaison. Les surrogates UTF-16 isolés, acceptables dans certains objets JavaScript mais refusés par Serde, imposent une revue avant tout input Rust ; aucune réparation ou normalisation ne change silencieusement les octets.

## Autorité et dernière attente

Une nouvelle réservation exige le pilote explicite, le consentement spécifique, l'admission et sa génération exactes, la demande Support actuelle et la publication de contexte committed sans pending ou tête plus récente. Le premier writer reste CH/CHF ; une intention US est refusée dans les gardes historiques et les mutations, y compris si elle apparaît pendant le batch de réservation.

Les lectures historiques permettent de confirmer une preuve déjà acquise après une pause de préparation ou un changement de catalogue. Elles conservent les droits actuels appareil/commerciaux et la délégation Support. Elles n'autorisent jamais une nouvelle création. Les branches commerciales admises restent celles du premier adaptateur A2, limitées aux packs Complets Stripe payés ; ce lot n'élargit pas les essais, droits manuels ou autres offres.

La revue a identifié une fenêtre importante : effectuer une dernière lecture historique après le contrôle complet de progression permettait à un consentement désactivé ou à une source modifiée pendant cette attente d'être ignorés. Le chemin de succès termine désormais par **un seul SELECT réunissant la progression complète et la réservation exacte encore sans reçu et sans preuve**. Aucune attente de lecture seule ne suit avant le retour `reserved`. Un reçu concurrent legacy impose une revue ; une preuve concurrente repasse par A7.

La garde finale utilise six paramètres : entreprise, réservation, proposition, empreinte, acteur et installation. Les IDs client/devis et la liaison initiale, déjà corroborés, sont immuables par les migrations SQL existantes. Les recopier dans cette garde n'ajouterait pas d'invariant et dépasserait le budget de 64 paramètres sur certaines sources longues. Les valeurs restent liées, jamais interpolées dans SQL.

Ce SELECT est le point d'acceptation serveur, pas une transaction distribuée. Une révocation postérieure au résultat déjà délivré ne peut pas être annoncée comme atomiquement appliquée au futur commit SQLite. Le Rust devra capturer et recorroborer l'origine entreprise, le contexte membre, les ressources locales et la réservation ; les fenêtres entre services restent explicites.

## Reprise et erreurs

Le classifieur est exécuté avant le chargeur de contexte courant. Une preuve durable peut donc être confirmée par A7 sans ancien transport, nouveau catalogue ou appel IA. Un reçu legacy sans preuve, ou une réservation ancienne sans sa liaison d'origine, demande une revue et n'est pas réparé.

La réponse `held` ne transfère jamais la propriété, même si le reçu d'un autre appareil existe. Une réponse perdue après réservation se rejoue avec les mêmes IDs. Les erreurs d'infrastructure restent des erreurs bornées de service ; elles ne deviennent ni absence, autorisation ou succès.

Après changement des faits, une réservation possédée peut seulement fournir les sélecteurs `recovery_required`. Si aucun reçu local ne permet de prouver la création précédente, ce résultat ne donne pas le droit de reconstruire un brouillon à partir du ticket actuel. Une révocation du droit de lecture, de la délégation ou du garde pays refuse aussi ces sélecteurs.

## Validation exécutée

Les tests ciblés de composition exécutent les vraies migrations, assertions, transactions, registres, gardes publiées/historiques et confirmation A7. La reprise de preuve utilise une vraie SQLite synthétique au schéma natif, le ZIP strict et le WASM ; elle n'est pas produite par Rust. Les ports PG et Storage sont interdits dans la fixture de réservation : leur appel inattendu ferait échouer le test.

Ils couvrent deux acteurs/installations et deux connexions SQLite, réponse perdue ou rollback, preuve durable, legacy sans preuve, mutation des entrées, caractères invalides pour Serde, intention US et changements de source/catalogue/consentement/révision à la dernière attente. Les régressions existantes conservent leurs propres ports et limites ; aucun test local ne prouve le login hébergé ou une synchronisation réelle entre appareils.

La première exécution ciblée a échoué à charger la suite de composition, car un import transitif Cloudflare n'avait pas son port externe simulé. Les ports PG/Storage explicitement interdits corrigent la fixture. Les diagnostics lint du tableau creux et d'une méthode de fermeture non liée ont également été corrigés. Ces essais initiaux ne sont pas comptés comme validations réussies.

Contrôles réellement exécutés :

- Régression Action Engine/Automation, connecteurs mail, collaboration et gardes pays : **1 730/1 730**, 55 fichiers, zéro échec et zéro ignoré. Baseline A7 : 1 641 ; les ciblés recouvrent les 89 nouveaux cas et ne sont pas additionnés une seconde fois.
- `tsc --noEmit --incremental false` : sortie 0 après gel des six sources.
- Lint `lib/action-engine`, schéma, route collaboration, test de route, plugin SQLite et configurations Vite/Vitest : sortie 0. Les diagnostics Support antérieurs hors de ce périmètre ne sont pas annoncés comme corrigés.
- `oxfmt --check` des six fichiers TypeScript : sortie 0.
- `pnpm run build`, avec contrôle des assets dans le prebuild : sortie 0. Ce build serveur ne compile pas le writer Rust et ne déploie rien.
- `git diff --check` et `git diff --cached --check` avant commit : sorties 0.

Le test maximal exécute un JSON source de **256 000 caractères**, les vrais CAS d'autorité/source/publication et le garde final : **63 paramètres**, ou **64** avec l'identifiant d'une assertion transactionnelle. Un dépassement est refusé. Désactivation du consentement, changement de génération/source, pending ou nouvelle publication, reçu concurrent et autre installation sont refusés sans écriture ni assertion résiduelle.

Ni latence hébergée, login réel, transfert entre appareils, compilation native ou nouvelle exécution Workerd ne sont revendiqués. Les suites PostgreSQL éphémères existantes sont rejouées ; elles ne constituent pas le staging multi-connexions requis avant activation.

## Reste nécessaire avant le premier brouillon utilisable

1. Valider les sources Rust et les 68 tests sur un hôte autorisé, puis tester une vraie archive synthétique produite par le writer dans le lecteur TypeScript/WASM.
2. Ajouter une orchestration native à sélecteurs seulement : reprise du reçu local avant création, résolution de l'ancien pending et lien local durable réservation → snapshot avant upload/nettoyage. Aucun input privé de writer ne doit être confié à la WebView.
3. Valider le protocole et les migrations D1/PG antérieurs dans un staging approuvé, avec plusieurs connexions PG, puis raccorder les endpoints et les clients dans l'ordre.
4. Raccorder le déclenchement Support et la notification après preuve/confirmation métier, avec ouverture du vrai brouillon existant et validation humaine. Ne pas émettre ou envoyer automatiquement le devis.

L'objectif global demeure en cours. Aucun compte, e-mail, paiement ou document client réel n'a été utilisé pour A8.
