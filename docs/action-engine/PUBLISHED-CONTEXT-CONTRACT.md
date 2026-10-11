# Contexte Gestion publié — raccords privés A3 et A4

## État réel

Le desktop 1.90.15, schéma 61, publie des archives .zentra par /api/account/collaboration, avec têtes/révisions Supabase. A3 ajoute des sources natives schéma 62 et un lecteur serveur. A4 ajoute la coordination privée du transport publié et compose ses gardes avec celles de la source Support et de l'admission D1. Aucun endpoint Action Engine, commande IPC, interface ou déclencheur Support n'est activé ; aucune migration hébergée ni mise en production n'est effectuée dans ce lot. Le consentement spécifique est désactivé par défaut et le pilote `ACTION_ENGINE_PUBLICATION_ORGANIZATIONS` refuse les nouvelles préparations si sa configuration est absente ou sa liste vide.

La compilation Rust est bloquée avant les modules projet par Windows App Control (erreur 4551). Les tests natifs et l'interopérabilité d'une archive effectivement produite par Rust restent à exécuter. Les contrôles A4 sont consignés dans `PUBLICATION-VALIDATION-20261011.md` et son manifeste de preuves.

Ne jamais utiliser le protocole D1 business_sync_* du desktop ancien 1.46.1 embarqué dans la copie serveur pour cette intégration.

## Export natif codé

create_collaboration_backup_at capture le snapshot en attente et sa révision de base. L'export lit seulement la copie SQLite figée créée par snapshot_database. Si les faits ne respectent pas le contrat, l'archive métier reste produite sans projection : la synchronisation continue, et Action Engine refuse ce contexte. Aucune troncature, base alternative ou valeur fiscale inventée.

Deux positions ZIP réservées, sans compression :

1. manifest.json, avec descripteur optionnel action_engine_resources : format, version, chemin fixe, SHA-256 exact, taille, nombres de clients/articles.
2. automation/resources.v1.json, si l'export est disponible.

Le manifeste de transport strict cloud_backup::Manifest ne change pas. Les sauvegardes manuelles gardent le format précédent sans sidecar. La fusion intermédiaire retire le descripteur du sidecar distant absent ; la republication exporte les ressources du résultat fusionné.

| Données | Champs exportés |
| --- | --- |
| Entreprise | CH/CHF, onboarding, assujettissement TVA, taux configuré par défaut, délais de paiement/validité, updated_at |
| Clients | ID, nom, e-mail nullable, archive, updated_at |
| Articles | ID, type, SKU nullable, nom, description, unité, prix de vente en cents, taux configuré, archive, updated_at |

Pas de prix d'achat, notes privées, coordonnées bancaires, stocks, pièces jointes, secrets ou identité de session. Les clients archivés restent présents afin d'empêcher leur recréation silencieuse.

Bornes : 4 MiB UTF-8, 5 000 clients et 5 000 articles, noms 200 UTF-16, descriptions 1 000, SKU 100, unités 40, prix entiers 0…1 000 000 000 cents, taux 0…10 000 points de base, délais 0…365 jours. Les valeurs SQLite REAL ne sont pas arrondies en cents : elles sont refusées.

## Contrat et empreintes

L'enveloppe fermée contient format, version, schemaVersion:62, organizationId, snapshotId, baseRevision, resources et resourcesHash. Les listes sont ordonnées par ID ASCII binaire et uniques. Chaînes et nulls restent inchangés, sans normalisation.

Le hash des ressources porte sur le tuple JSON compact :

~~~text
[1,
 [country,currency,onboardingComplete,vatRegistered,defaultVatBp,paymentTermsDays,quoteValidityDays,updatedAt],
 customers.map([id,name,email,archived,updatedAt]),
 articles.map([id,kind,sku,name,description,unit,unitPriceCents,taxRateBp,archived,updatedAt])]
~~~

Révision client = SHA-256 de ["customer",…tupleClient] ; article = ["article",…tupleArticle]. Inclure updated_at est nécessaire : le digest métier existant l'ignore. Le hash du sidecar porte sur ses octets exacts. Le préparateur reçoit un taux effectif zéro pour une entreprise non assujettie, tandis que l'empreinte de l'article conserve son taux brut.

## Lecture serveur codée

loadDeviceQuotePlanningContext utilise l'identité appareil et l'admission A2, puis `readSupportQuoteSource` sous la délégation Support/Gestion actuelle. Il exige un ticket durable de la même entreprise, une connexion active, un délégant propriétaire/admin encore autorisé et une source non fermée/non incomplète. L'identité vient de l'enveloppe, jamais du corps ou du modèle. Les conversations signalées multi-expéditeurs sont refusées. Le lecteur capture les faits avant leur hash et retourne une capacité source privée ; un acteur, une autorisation ou un prédicat SQL ne sont jamais acceptés dans un body HTTP.

Les helpers authentifiés collaborationHead, collaborationSnapshot et downloadCollaborationChunk restent utilisés. Le chargeur exige une révision publiée cohérente, vérifie la longueur/SHA du premier chunk et lit au maximum 8 MiB. Le codec vérifie les deux en-têtes locaux positionnels, chemins exacts, flags, CRC, tailles, SHA, JSON sans champs/clefs dupliqués, UTF-8 strict, bornes et hashes des faits.

La révision du contexte lie entreprise, snapshot, révision finale/base, SHA archive déclaré, SHA du manifeste de transport normalisé, SHA du chunk vérifié, SHA sidecar, hash ressources et source. `manifestSha256` est le SHA-256 de `JSON.stringify(backupManifest(manifest))`, pas celui du manifeste interne ZIP. La révision finale est attribuée après publication, pas préinscrite dans le ZIP. Source, tête et admission sont relues après les attentes.

## Publication coordonnée A4

Le raccord privé `publication-gateway.ts` se branche dans le chemin existant de commit collaboration pour les entreprises explicitement admises. Les migrations additives proposées sont D1 `0102_action_engine_publication_ledger.sql` et PostgreSQL `20261011011348_action_engine_publication_coordination.sql`. Cette dernière exige le schéma de collaboration historique réconcilié et son garde pays existant ; elle ne déplace aucune donnée et n'active aucune entreprise.

L'ordre imposé est le suivant :

1. Activer le garde PostgreSQL sous le verrou de tête. Il est permanent : les anciens commits ne peuvent plus avancer cette tête hors du protocole coordonné. Les métadonnées du candidat deviennent immuables.
2. Inscrire une tentative D1 `pending` immuable pour l'entreprise, le snapshot, l'installation, l'acteur, la révision de base, les SHA archive/manifeste et la taille. Une seule tentative peut rester `pending` par entreprise. Cette barrière précède le CAS PostgreSQL.
3. Appeler `zentra_commit_workspace_v2` avec la même identité d'opération. PostgreSQL reprend le CAS et les contrôles des parties du transport existants sous verrou ; il conserve le premier résultat et son identité.
4. Lire `zentra_action_publication_fact_v1` et vérifier son fait exact avant la clôture D1 : opération, entreprise, snapshot, installation, acteur, base et résultat terminal. Un commit doit aussi corroborer la taille et le manifeste normalisé, son SHA et le SHA archive, et présenter une version de contenu admissible. Ensuite seulement D1 devient `committed` ou `cancelled`, et le caller peut annoncer le résultat ou purger les copies de transport.

Le fait PostgreSQL est une preuve de **publication de transport**, pas une preuve du contenu SQLite ou de l'existence du devis. La fonction de confirmation du registre Action Engine retourne encore le prédicat `sql: '0'` ; le sidecar clients/articles ne permet pas de lever ce refus.

### Réponse perdue et fermeture

Un timeout ou une réponse incertaine conserve la barrière D1. Le rejeu garde le même ID d'opération et retrouve son fait d'origine. Quand une autre tentative rencontre une barrière vieille d'au moins 120 secondes, le serveur peut appeler explicitement `zentra_close_action_publication_v1`. Cet appel se sérialise avec un commit retardé sous le même verrou de tête : il retrouve le commit déjà fait ou inscrit un tombstone d'annulation permanent, y compris si le candidat n'existe plus. `close` ne publie jamais un candidat.

Le délai seul ne libère rien et ne prouve jamais l'absence de commit. D1 n'est clôturé qu'après vérification du fait terminal PostgreSQL ; une erreur laisse la barrière intacte. Aucune expiration de bail ni attribution automatique d'un commit incertain à une autre installation n'est fournie.

Les faits terminaux PostgreSQL et D1 permettent de rejouer un commit après purge de sa copie de transport sans faire avancer une tête plus récente ni reconstruire un ancien témoin de catalogue courant. A5 ajoute le parcours de reprise avant fusion/préparation décrit ci-dessous. Ses sources natives sont écrites, mais leur compilation et leur exécution restent à valider ; le rejeu serveur seul ne prouve pas la reprise complète sur l'appareil.

Retirer une entreprise de l'allowlist ferme ses nouvelles préparations Action Engine dans le contexte runtime qui fournit ce réglage, sans retirer son garde permanent. Le préparateur le relit aussi avant l'autorisation fournisseur ; un ancien déploiement peut conserver ses propres bindings, tandis que le CAS D1 vérifie les consentements et droits persistants actuels. Le transport d'une entreprise déjà gardée reste coordonné ; le wrapper legacy prend le verrou de tête et refuse `PA103` avant tout retour, même historique. Seul ce refus définitif permet de changer de chemin, jamais un timeout ambigu. Les entreprises non gardées conservent le chemin de collaboration existant.

### Reprise avant fusion A5

Le POST collaboration existant accepte une action fermée `recover-publication` avec `id`, `baseRevision` et `manifest`. L'entreprise, l'acteur, le rôle et l'installation viennent exclusivement de la session appareil. Les valeurs sont copiées avant toute attente ; le serveur compare les SHA du manifeste normalisé et de l'archive, sa taille, sa base et l'identité complète avec la tentative D1 immuable. Cette sonde ne modifie pas les contrats `prepare`/`prepare-content` et ne prétend pas prouver le digest des entrées, absent du registre PG après purge.

- `{known:false}` : absence réelle de tentative D1 pour cette entreprise et ce snapshot. Aucun appel PG ni écriture ; le pending local reste intact et conserve son parcours existant.
- `{known:true,pending:true}` : tentative D1 pending et fait PG absent, ou annulation PG corroborée pas encore settled. La sonde ne libère rien. Le client reprend **le commit existant du même ID**, sans préparation, upload, nouvel ID ou clôture, avant toute fusion. Cela permet de résoudre un crash entre réservation D1 et premier appel PG.
- `{known:true,committed:true,revision,snapshotId}` : fait PG exact committed corroboré ; si nécessaire, settlement D1 réussi avant réponse. La révision est celle d'origine, exactement base + 1, même si une tête plus récente existe et si l'ancienne archive serveur a été purgée.
- `{known:true,committed:false,revision,snapshotId}` : annulation terminale D1/PG concordante. Ce résultat ne confirme aucune archive et ne nettoie pas le pending local ; le client relit la tête avant son parcours de résolution existant.

Les pannes, schémas absents, faits malformés et contradictions ne deviennent jamais `known:false`. Un état PG pending durable avec résultat null est un défaut de protocole (503) : les RPC A4 normaux terminent cet état dans leur transaction. La sonde n'appelle ni `enableGuard`, `begin`, `commit`, `close`, stockage, annonce ou purge. Elle ignore l'allowlist pour permettre une reprise historique après retrait du pilote ; les droits transport et le garde pays actuels restent nécessaires.

Le code natif A5 utilise sa propre archive figée comme référence après confirmation, sans réimporter ses données métier. Le `base_clock` vient du snapshot d'origine ; les modifications locales ultérieures restent à publier. La génération du compte, l'origine entreprise, le pending et les octets locaux sont revérifiés avant reprise du commit et avant confirmation. Après résultat connu, préférences et tête sont relues avant toute décision de fusion. Lecture seule et acceptation explicite d'une version distante gardent leur voie existante ; ce lot ne résout pas les limites préexistantes d'un premier partage jamais publié, sans référence historique.

Déployer les schémas A4 et le serveur A5 avant ce client est un prérequis obligatoire. Aucun schéma manquant ou ancien serveur ne doit être interprété comme une preuve négative autorisant une nouvelle publication. Aucun déploiement de ce lot n'a été fait.

## Gardes D1 composées

`preflightCas` capture l'admission D1 et les valeurs exactes de son `revision_json`. `createPublishedQuoteFences` compose trois prédicats privés pour la progression de l'intake et du registre :

- L'autorité actuelle appareil, entreprise, rôle, siège, paiement et consentements, avec la génération d'admission capturée inchangée.
- Les faits bruts exacts ayant produit la révision source : ticket, workspace, connexion, identifiant externe, objet, corps, JSON d'enveloppe, fingerprint, révision, délégant et dates du lien/de la connexion, fournisseur du connecteur. Les permissions de délégation sont relues par le SQL.
- Le témoin D1 de publication `committed` attendu : entreprise, snapshot, base/révision, SHA archive et SHA manifeste. Toute tentative `pending` ou publication plus récente de cette entreprise bloque la progression.

L'assertion CHECK, la mutation et son journal sont dans le **même batch D1**. La composition refuse un dépassement de 64 paramètres ou 16 000 caractères SQL ; chaque chaîne liée est bornée à 65 536 caractères UTF-16. Le JSON source est segmenté sans séparer les deux unités d'un emoji. Les valeurs restent des paramètres, jamais du SQL interpolé.

L'historique utilise les droits commerciaux/appareil et la délégation actuelle du workspace capturé. Il n'exige pas que le ticket soit encore ouvert, que l'ancienne connexion reste active ou que l'ancien catalogue soit courant ; il n'autorise aucune progression. `prepareDeviceSupportQuote` assemble ces capacités avec la réservation durable avant IA et la sauvegarde de proposition, mais n'est appelé par aucune route, UI ou automatisation Support dans ce lot.

## Preuve canonique privée A6

A6 ajoute un autre lecteur, distinct du codec de planification à deux positions : `quote-archive.ts` valide le ZIP complet borné et son SHA, puis `sqlite-reader.ts` lit la vraie SQLite schema 62 en lecture seule. `canonical-quote.ts` recorrobore les vrais client/devis/lignes/reçu/audit contre la réservation liée au contexte initial. Les types de stockage INTEGER et les octets UTF-8 sont contrôlés, sans arrondir un nombre unsafe ou accepter une conversion REAL/TEXT de cents. Un audit/sidecar seul n'est jamais une preuve.

La première preuve exige le brouillon complet inchangé ; modification, émission ou suppression impose une revue, jamais une recréation. La capacité serveur scellée autorise l'append du journal immuable D1 0103. Après preuve durable, `historical-quote-fences.ts` peut confirmer le fait initial sous permissions actuelles, sans catalogue/tête/archive anciens. La provenance initiale est liée à la nouvelle réservation dans le même batch ; aucun backfill legacy.

Ce sont encore des composants privés : pas de route, commande IPC ou orchestration appareil → PG/chunks → preuve → confirmation. `published-fences.ts` refuse toujours la confirmation d'un simple contexte de catalogue. Le futur raccord doit ajouter le garde pays D1, exiger la preuve A6 même sur replay d'un reçu legacy et valider tous les chunks authentifiés. Les limites CPU/mémoire, dépendances et tests exacts sont décrits dans `CANONICAL-QUOTE-VALIDATION-20261011.md`.

## Ce qui n'est pas prouvé par le chargeur de planification

- Le codec valide un compartiment de deux positions, pas tout le ZIP, son annuaire central ou les doublons dans sa queue opaque. Les positions ne sont pas sélectionnées par recherche de nom.
- Le premier chunk est vérifié ; le hash de toute l'archive n'est pas recalculé. Le SHA complet vient du manifeste de publication existant.
- Un hash de sidecar ne prouve pas son égalité avec SQLite face à un producteur malveillant. Le writer natif recorroborera ses faits locaux avant commit ; la confirmation distante devra corroborer les faits métier publiés.
- Le sidecar actuel ne contient pas de projection des devis/reçus créés. Il ne peut pas confirmer une création dans D1.
- Les gardes et le protocole de publication imposent un ordre entre des transactions locales ; ils ne constituent pas une transaction distribuée D1/PostgreSQL/SQLite. Une barrière peut rester durablement `pending` lorsque le rapprochement ne dispose pas d'un résultat certain.
- L'autorité distante, la réservation centrale et la recorroboration du writer natif doivent encore être raccordées à une commande dédiée. A6 fournit les vérificateurs privés du reçu métier publié, mais pas le parcours authentifié complet. Aucune émission ni transmission n'est autorisée.
- Les migrations proposées, le garde permanent et l'allowlist nécessitent un déploiement coordonné explicitement validé avant toute activation ; aucun hôte client ni base hébergée n'a reçu ce lot.

Les reçus natifs prévus sont partagés et immuables ; l'outbox est privée à l'installation, purgée des archives et conservée lors d'une réception ordinaire. Rejoindre une autre entreprise la vide. Une copie reçue qui perd ou modifie un reçu local est refusée avec restauration des données précédentes ; aucun devis n'est recréé pour résoudre cette situation.
