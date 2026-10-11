# A13 — contrat privé de travail Support et identité API

## Résultat et état réel

Le raccord serveur privé sait maintenant recevoir une demande fermée de découverte ou de préparation, puis appeler les vrais services A12. Il retourne des IDs ou un résumé minimal de proposition, jamais un plan fourni par le navigateur. Le connecteur Support API conserve aussi une identité structurée facultative, nécessaire à la recherche ou à la création fiable du client.

Source serveur : `4f17e843b76e3de56fde86f9313161ee697c8d5c`. Checkout natif inchangé à `1954f1d4d42d4439b2cb16727515a60b708d2199`, sources A11 `ba69873c54ac24c4f87ece4505a32fe9541208b1`. Manifeste : `docs/evidence/action-engine-support-work-bridge-20261011.json`, SHA-256 `ed134500ac85c290c5186346c18ebcc1c412071aaa74c2ec87ae8f14ece5603a`.

**Ce lot reste privé et non activé.** Aucun endpoint `app/api`, IPC, ordonnanceur, callback Support, notification ou opt-in de production ajouté. Il ne constitue pas une création native de devis exécutée, un test JEV en ligne ou une publication de mise à jour. Aucun compte, abonnement, mail ou document client réel utilisé/modifié.

## Modifications

- `handleDeviceQuoteWork` capture les headers avant toute attente, exige la session appareil et applique une limite dédiée de 500 demandes par entreprise/installation/IP/heure avant lecture du corps. Les services appelés conservent leurs propres revalidations et fences durables.
- Opérations seules : `discover` avec taille/curseur facultatifs, ou `prepare` avec un ID source. Aucun acteur, entreprise, installation, plan, prix, SQL ou clé fournisseur n'est accepté dans ce contrat.
- Le corps JSON UTF-8 plat est borné à 8 192 octets, afin de transporter le curseur A12 de 4 096 caractères. Le parseur partagé refuse les clés dupliquées après décodage, les objets/tableaux imbriqués et les suffixes. La limite A10 d'exécution reste exactement 2 048 octets ; les limites globales ne changent pas.
- La découverte expose seulement IDs source et curseur. La préparation capture le vrai objet proposition, contrôle entreprise/source/CHF/SHA canonique, puis expose les sélecteurs, l'état et les raisons de revue. La capture/SHA sont synchrones après la dernière attente de préparation.
- Les états `busy` et `uncertain` sont distincts ; aucune branche du handler ne relance automatiquement une analyse. Une sortie interne invalide devient une panne conservatrice, jamais une proposition absente. Les erreurs bornées ne divulguent pas exception privée, mail ou secret ; réponses non mises en cache.
- Après authentification de la connexion API Support, `senderEmail`, `senderName` et `senderIdentityAmbiguous` facultatifs rejoignent le véritable `ingest`. E-mail nu unique normalisé, nom littéral de 200 caractères maximum sans troncature ; champs explicitement invalides refusés. Les champs absents restent absents, sans extraction inventée depuis le corps.
- Une identité seule modifiée actualise la source et son analyse ; un rejeu normalisé déduplique. Une identité ambiguë reste refusée par les gardes de planification existantes. Ces métadonnées de connecteur ne prouvent ni propriété de la boîte ni autorisation de l'acteur.

Le contrat détaillé figure dans `lib/action-engine/README.md`. La liste de travail et le résumé `prepared` ne sont ni une permission d'écrire ni une preuve de création/confirmation d'un devis.

## Fichiers

Créés :

- `lib/action-engine/device-flat-json.ts`
- `lib/action-engine/device-work-contract.ts`
- `lib/action-engine/device-work-handler.ts`
- `lib/action-engine/device-work-handler.test.ts`
- `lib/support/api-source.ts`
- `lib/support/api-source.test.ts`

Modifiés :

- `lib/action-engine/device-execution-handler.ts` : extraction du parseur, contrat et plafond A10 conservés.
- `lib/action-engine/device-preparation.integration.test.ts` : huit cas A12 conservés, cinq nouvelles compositions avec le handler réel, fixture étendue aux migrations existantes 0103–0105.
- `lib/support/service.ts` : import et transmission de l'identité, deux lignes additives.
- `lib/support/support.test.ts` : dix cas réels `receiveHook`/`ingest` supplémentaires ; aucun reformatage global.

Documentation : présent rapport, manifeste de preuves, `lib/action-engine/README.md`, `docs/action-engine/STATUS.md` et `EXECUTION-INTEGRATION-PLAN-20261011.md`. Scripts/logs locaux dans `.qa/action-engine-support-work-bridge/` ; le manifeste en conserve les empreintes.

## Migrations et retour arrière

Aucune migration D1, PostgreSQL/Supabase ou native ajoutée/réécrite. Les migrations D1 existantes, dont 0105, sont appliquées à des bases éphémères de test uniquement. Aucun changement de région, de schéma hébergé ou de données de production.

Retour arrière source : retirer le raccord privé et l'extension de l'enveloppe API, en conservant les faits durables existants. Aucun effacement ou restauration de données n'est nécessaire. Les obligations permanentes de publication A4 restent inchangées ; une entreprise déjà gardée ne peut revenir à un ancien transport non coordonné.

## Tests réellement exécutés

| Contrôle | Résultat |
| --- | --- |
| Régression Action Engine | 1 597/1 597, 43 fichiers |
| Régression adjacente Automation/Support/collaboration | 576/576, 20 fichiers |
| Total distinct | **2 173/2 173, 63 fichiers, zéro échec/ignoré** |
| Ciblés A13/A10/A12 | 309/309, 6 fichiers ; inclus dans le total |
| Ajouts par rapport à A12 | 107 : 50 handler, 42 identité API, 10 `receiveHook`, 5 compositions D1 |
| TypeScript sans cache incrémental | Réussi |
| Lint et format des huit fichiers du noyau/fixtures/helper | Réussis |
| Assets et build de production serveur | Réussis, sans déploiement |
| Tests Rust | **136 écrits, zéro exécuté**, aucun ajouté en A13 |

Les cohortes de régression sont disjointes et utilisent quatre workers au maximum ; les ciblés ne sont pas additionnés une seconde fois. Les régressions SQL et le build sont exécutés séquentiellement. `ZENTRA_NATIVE_SOURCE_ROOT` et `PGLITE_MODULE_DIR` sont explicitement renseignés : aucun test de fixture native/PostgreSQL n'est masqué par une variable absente.

Périmètres de preuve :

1. Les 50 tests du nouveau handler exécutent le vrai parseur, les vrais codecs et le SHA ; session, quota, découverte et préparation sont des ports QA mockés. Ils prouvent le protocole, pas une authentification DB réelle.
2. Les 13 compositions de préparation exécutent D1 local Miniflare/workerd, les vrais handler/découverte/préparation/source/fences/intake/ledger. Session/quota/admission commerciale, archive/contexte publié et fournisseur sont explicitement synthétiques. Les cinq ajouts vérifient découverte → résumé fermé sans réservation, ACK de sauvegarde perdu → reprise sans contexte/clé/nouvelle IA, délégation retirée, pause avant analyse et deux préparations concurrentes → un intake/une décision/une proposition.
3. Les tests Support exécutent le vrai `receiveHook` et `ingest` dans la fixture SQLite locale existante. Le transport fournisseur et les frontières compte/auth externes restent simulés ; aucun appel JEV ou fournisseur en ligne.
4. Les autres régressions existantes conservent leur propre périmètre, notamment l'authentificateur réel avec identités/base locales synthétiques dans les tests d'admission/découverte. Elles ne prouvent pas un parcours hébergé ni Rust.

Échecs initiaux conservés : le helper API ne chargeait pas `cloudflare:workers` dans Node ; son mock runtime de test refuse désormais tout accès DB. Le propriétaire de la fixture D1 rapporte un premier échec avant les 13 corps, dû à un commentaire SQL terminé par un point-virgule ; le parseur de fixture ignore désormais les commentaires lors de la détection de fin. Ses deux références `exec` sont identifiées comme transcriptions rapportées, et non comme fichiers bruts inexistants. Les rapports centraux persistants ciblés et complets passent ensuite. Le lint a également signalé le rejet intentionnel des caractères de contrôle dans l'e-mail ; une directive locale documente cette seule expression, sans modifier son comportement après régression. Le premier log lint/check et la relance réussie sont conservés.

Le lint ne prétend pas nettoyer les diagnostics historiques du grand périmètre Support : les deux anciens fichiers conservent leur style et leur diff minimal. Le typecheck global inclut leurs modifications.

## Risques, limites et suite

- Le consommateur natif A11 sait réserver/confirmer, mais ne décode ni n'orchestre encore ce nouveau protocole de découverte/préparation. Aucun caller ne l'utilise.
- La future ronde doit conserver **une seule origine compte/espace/membre/installation** sur toutes les attentes et reprendre d'abord l'outbox locale. Une recapture de contexte au milieu de la ronde est incorrecte. Le lecteur borné des intentions locales reste à ajouter/corroborer.
- Chaque ronde de découverte repart sans curseur après avoir parcouru les pages. Le quota dédié ne prouve ni une cadence de trois secondes ni une capacité de 150 entreprises ; mesure de charge encore nécessaire.
- Les intakes incertains nécessitent un rapprochement supervisé explicite. Une clé manquante après démarrage ne devient jamais un retry automatique. Les propositions non réservées peuvent être conservativement périmées par une autre publication ; aucun rebase silencieux.
- L'activité/notification doit suivre confirmation canonique **et ACK local durable**, avec une clé stable entreprise/proposition. Un résumé de préparation, un ACK transport ou chaque rejeu du consommateur ne doit pas produire une notification de réussite.
- Windows App Control 4551 bloque toujours la compilation avant le projet. Aucun Cargo, test/build/app natif, émulateur ou contournement tenté en A13. La compilation native, les 136 tests, l'interopérabilité d'une vraie archive synthétique Rust → TypeScript et le staging PostgreSQL multi-connexions restent des prérequis à l'exposition/activation.

Terminé : contrat serveur privé, réponses minimales, conservation de l'identité API et validations locales décrites. Expérimental/inactif : boucle native complète, création de devis réelle de bout en bout, supervision et notification utilisateur. L'objectif global reste actif et non atteint.
