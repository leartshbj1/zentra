# Contexte Gestion publié — raccord A3 privé

## État réel

Le desktop 1.90.15, schéma 61, publie des archives .zentra par /api/account/collaboration, avec têtes/révisions Supabase. A3 ajoute des sources natives schéma 62 et un lecteur serveur ; aucun endpoint Action Engine, migration distante ou déploiement n'est activé. La compilation Rust est bloquée avant les modules projet par Windows App Control (erreur 4551). Les tests natifs et l'interopérabilité d'une archive effectivement produite par Rust restent à exécuter.

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

loadDeviceQuotePlanningContext utilise l'identité appareil et l'admission A2, puis la délégation Support/Gestion actuelle. Il exige un ticket durable de la même entreprise, une connexion active, un délégant propriétaire/admin encore autorisé et une source non fermée/non incomplète. L'identité vient de l'enveloppe, jamais du corps ou du modèle. Les conversations signalées multi-expéditeurs sont refusées.

Les helpers authentifiés collaborationHead, collaborationSnapshot et downloadCollaborationChunk restent utilisés. Le chargeur exige une révision publiée cohérente, vérifie la longueur/SHA du premier chunk et lit au maximum 8 MiB. Le codec vérifie les deux en-têtes locaux positionnels, chemins exacts, flags, CRC, tailles, SHA, JSON sans champs/clefs dupliqués, UTF-8 strict, bornes et hashes des faits.

La révision du contexte lie entreprise, snapshot, révision finale/base, SHA archive déclaré, SHA du chunk vérifié, SHA sidecar, hash ressources et source. La révision finale est attribuée après publication, pas préinscrite dans le ZIP. Source, tête et admission sont relues après les attentes.

## Ce qui n'est pas prouvé

- Le codec valide un compartiment de deux positions, pas tout le ZIP, son annuaire central ou les doublons dans sa queue opaque. Les positions ne sont pas sélectionnées par recherche de nom.
- Le premier chunk est vérifié ; le hash de toute l'archive n'est pas recalculé. Le SHA complet vient du manifeste de publication existant.
- Un hash de sidecar ne prouve pas son égalité avec SQLite face à un producteur malveillant. Le writer natif recorroborera ses faits locaux avant commit ; la confirmation distante devra corroborer les faits métier publiés.
- Le sidecar actuel ne contient pas de projection des devis/reçus créés. Il ne peut pas confirmer une création dans D1.
- Une relecture Supabase puis un batch D1 ne constituent pas une transaction distribuée. Barrière de publication/source et réconciliation restent requises avant activation.

Les reçus natifs prévus sont partagés et immuables ; l'outbox est privée à l'installation, purgée des archives et conservée lors d'une réception ordinaire. Rejoindre une autre entreprise la vide. Une copie reçue qui perd ou modifie un reçu local est refusée avec restauration des données précédentes ; aucun devis n'est recréé pour résoudre cette situation.
