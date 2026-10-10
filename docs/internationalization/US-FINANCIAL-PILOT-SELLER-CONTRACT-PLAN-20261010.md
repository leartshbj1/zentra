# Préalable B0 — contrat de présentation vendeur US V5

10 octobre 2026. Base de départ `fb1e0b8dbb1630ca49c8fb6c28bf966ed3a96e0d`. Plan arrêté avant toute implémentation de ce jalon.

## Résultat et limite du jalon

Préparer le contrat pur, typé et testable nécessaire à la correction du nom commercial imprimé et des contacts vendeur après promotion V5. Ce jalon ajoute des validateurs, une proposition de changement et un reçu structurel. Il ne rend aucune modification accessible dans le produit. Il ne crée ni route, store, session, UI, RPC, migration, table, permission ou activation. Aucune source existante n'est modifiée.

La future intégration B1 devra raccorder ensemble devis et factures, admission fraîche Auth/D1/PG, comparaison humaine, stockage atomique, reprise durable et observation composite F/B/S. Elle reste un lot distinct à planifier avec son inventaire exact avant code. Un hash ou un rôle présent dans un objet ne prouve ni autorisation, ni provenance DB, ni approbation humaine. B0 ne fournit aucun mécanisme d'exécution, même en mémoire.

## Contrats fermés

- Requête publique : `consumer:'financial-pilot'`, `schemaVersion:1`, UUID canonique `requestId`, `expectedRevision:F`, `expectedSellerRevision:S`, commande `update_seller_presentation` avec `displayName`, `contactEmail:string|null`, `contactPhone:string|null`. Null retire un contact ; absence n'est pas un substitut. Les champs adresse, identité légale, pays, EIN, devise, fiscalité, binding et marchand sont refusés.
- Profil imprimable : réutiliser le validateur vendeur existant (nom256, email254, téléphone80), en exigeant la forme canonique exacte. Aucune normalisation silencieuse ni traduction des données saisies. Le profil historique peut omettre les contacts.
- Présentation : `origin:'legacy-frozen'|'financial-v5'`, `baseSellerRevision`, `sellerRevision`, `changeCount`, `profile`, `updatedBy`, `updatedAt`, `changeSha256:string|null`. Source legacy : S=S0, count0, hashnull. Source V5 : count1..1000, S=S0+count, hash64hex. Sommes sûres, aucune saturation. Horodatage historique PostgreSQL conservé jusqu'aux microsecondes, avec offset explicite.
- Head composite : `consumer/schemaVersion/organizationId/revision/bankRevision/sellerRevision`. F positif, B non négatif, S positif. Il s'agit d'une observation structurelle, pas d'une transaction ou d'une autorité. Lecture : objet exact `head,presentation`, S corrélé.
- Preuve de proposition : `schemaVersion/organizationId/request/actor/commandHash/before/after/sellerRevision/changeIndex/changedAt/changeSha256`. Acteur structurel propriétaire avec droits Gestion et même tenant. F source reste celui de la requête, S résultat vaut S précédent+1. `before` conserve la présentation d'origine ; `after` est exactement le profil de la commande. Compteur et horloge monotones, dont précision microseconde. Aucun livre, ledger ou registre bancaire n'est admis dans ce contrat.
- Hash de commande : SHA256 du JSON canonique `["zentra:us:financial-pilot:seller:v1", organizationId, actorId, requête entière]`. Hash de changement : SHA256 du payload canonique complet excluant uniquement `changeSha256`. Ni l'un ni l'autre n'est une signature ou un sceau d'autorité.
- Reçu : `consumer/schemaVersion/organizationId/requestId/actorId/action/sourceRevision/sellerRevision/commandHash/changeSha256/changedAt/replayed`. `sourceRevision` est F historique ; aucun champ `revision` ne peut le faire adopter comme head courant. Corrélation optionnelle requête+acteur ; projection depuis la preuve validée. Aucun replay effectif ou décision CAS fourni par ce contrat.

## Capture, limites et erreurs

Capture JSON propre détachée avant la première attente, sans exécuter d'accessor ; objets exacts, symboles, prototypes étrangers, getters, cycles, fonctions, NUL, UTF-16 invalide et nombres non sûrs refusés. Budget requête4096octets UTF-8 ; lecture/preuve/reçu64KiB UTF-8. Ces bornes après capture s'ajoutent aux budgets structurels existants ; elles ne sont pas annoncées comme une borne d'allocation préalable. Toutes les sorties sont gelées récursivement.

Les erreurs publiques de requête valent422 et les projections privées invalides503, avec codes stables sans contenu source. Conflit F/S, limite1000 et horloge inversée valent409 lors de la construction/application d'une proposition. Les comparaisons et hashes restent déterministes. Toute entrée caller-owned, y compris les valeurs conservées par une fonction async et les attentes optionnelles, doit être capturée synchroniquement.

## Algorithmes purs à livrer

1. Validation requête, head, présentation et lecture.
2. Conversion commande vers profil exact, identité de commande canonique et hash namespacé.
3. Construction d'une proposition depuis une lecture et un acteur capturés : égalité F/S, owner structurel, capacité, horloge ; construction et validation des deux hashes. Ce n'est pas une admission serveur.
4. Validation historique d'une preuve indépendante du head actuel : formes, corrélations, budget, profil, temps, hashes. Elle ne reconstruit pas la chaîne complète et ne prouve pas la provenance du contexte fiscal.
5. Application pure de la preuve à sa lecture exacte : avant identique, F/S identiques, S seul avance ; F/B restent exactement identiques. L'appel répété contre un autre head refuse, sans décision de replay.
6. Projection/validation du reçu, sourceF historique explicite et aucune conversion vers un reçu financier générique.

## Frontière future de reprise facture

B1 ne devra pas bloquer indéfiniment la correction S à cause d'une préparation expirée : le schéma actuel ne possède pas de statut abandon/cancel. Les nouvelles préparations et premières réservations devront exiger S courant sous les verrous réels. Une opération déjà réservée conservera sa préparation, S, hashes et providerKey originaux ; droits, F/source, marchand et TTL resteront contrôlés. Un reçu commis restera rejouable avant les nouvelles préconditions. Aucune extension fiscale/TTL ou annulation implicite.

La future UI devra distinguer un `invoice_prepare` repris (vendeur enregistré affiché avant approbation) d'un `invoice_issue` incertain (body/reviewId approuvés conservés exactement). Un simple aperçu local sans pending peut être invalidé sur S ; cela ne supprime aucune opération durable. Les écritures seller futures devront garder leur propre reçu/pending et rester exclues des branches génériques qui effacent pending sur409/422.

## Inventaire exact B0 — deux fichiers nouveaux

| Fichier | Rôle |
| --- | --- |
| `lib/international/us-financial-pilot-seller.ts` | Contrats/validateurs/proposition/application/reçu purs. |
| `lib/international/us-financial-pilot-seller.test.ts` | Tests discriminants et adversariaux du contrat, sans port fictif présenté comme serveur. |

Le présent plan et le dossier de livraison/preuve sont documentaires et seront committés séparément du code. Aucun des32 chemins envisagés pour B1 hors ces deux fichiers n'est autorisé à être édité par B0. Toute nécessité d'un autre fichier impose un amendement préalable.

## Vérifications et rollback

Exécuter une fois la sélection ciblée des deux nouveaux fichiers et du profil/capture/hash existants, puis typecheck global, lint typé des deux fichiers, build production et contrôles de marque. Une sélection de compatibilité CH/US/Auth pertinente est distincte et ses limites seront déclarées. Les contrôles sont sérialisés ; les sorties historiques éventuellement régénérées sont préservées. Pas de prétention de recette PostgreSQL, navigateur, provider, native ou production pour un contrat non raccordé.

Une contrelecture indépendante doit vérifier namespaces, absence de référence mutable après await, monotonicité à la microseconde, corrélations S0/count et F/B, distinction validation/autorisation et impossibilité de champs fiscaux. Les tests doivent démontrer les refus et la conservation des entrées, pas seulement reproduire l'implémentation.

Rollback : retirer les deux fichiers non raccordés. Aucun changement de données, schéma, abonnement, configuration, région, pays ou document existant n'a lieu. B1 (SQL/application/UI) et le reste de l'ERP US demeurent à réaliser et ne sont pas annoncés terminés.
