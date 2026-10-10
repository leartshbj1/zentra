# Zentra US — fondation privée PostgreSQL TEST du livre V5

10 octobre 2026. Cette phase poursuit le même ERP, sans modifier les contrats publics ERP1–4. Elle ne constitue pas encore une persistance complète des nouvelles opérations financières.

**Suite livrée localement le même jour :** `US-FINANCIAL-TEST-SETTLEMENT-V5-20261010.md` ajoute une capacité distincte pour les avoirs et encaissements, avec reconstruction SQL indépendante. Ce document conserve l'état historique de la fondation ; son propre append reste fermé par PF010. Dès qu'un événement settlement existe, ses anciennes lectures/promotion refusent explicitement la capacité insuffisante, plutôt que de servir un livre figé comme courant.

## 1. Modifications

Une migration additive conserve la baseline ERP4 réelle, sa politique TEST, la provenance de promotion, les empreintes et les anciens reçus dans PostgreSQL. La promotion compare le snapshot exact sous verrou ; un rejeu doit conserver le même corps, la même clé et la même provenance. Les clés de tous les anciens reçus sont réservées, même celles qui ne figurent pas dans le journal financier de la baseline.

Le marqueur de promotion ferme les anciennes écritures et les anciennes projections « courantes » du tenant : snapshots, révisions, deltas, reçus, sources commandes/fournisseurs/banque/fiscalité et suivi des changements. Les données historiques restent en place. Les fonctions existantes sont gardées en place, sans alias non protégé de leur ancienne implémentation.

L'adaptateur séparé `postgres-test-foundation-v5` peut lire, retrouver un reçu et promouvoir un livre vide d'événements. Il ne fournit ni `commit`, ni `append`, ni version ERP publique 5. L'append SQL et les insertions directes d'événements/reçus financiers refusent toujours `PF010`. Le prochain jalon doit fournir des gardes SQL indépendantes des effets métier avant d'ouvrir ces écritures.

## 2. Fichiers créés

- `lib/international/us-financial-test-foundation.ts` : adaptateur RPC privé, capture immuable, validation du livre et corroboration des reçus.
- `lib/international/us-financial-test-foundation.test.ts` : tests d'autorité, projections, reprise, erreurs et mutations asynchrones.
- `lib/international/us-financial-test-foundation.postgres.test.ts` : chaîne PostgreSQL réelle locale, données exclusivement fictives.
- `supabase/migrations/20261010075840_international_us_financial_test_foundation_v5.sql` : migration créée avec la CLI Supabase, sans réécriture d'une migration historique.
- Cette livraison et `docs/evidence/us-financial-foundation-v5-20261010.json` : périmètre et preuves de validation.

## 3. Fichiers modifiés

`STATUS-20261009.md` et `US-FINANCIAL-PERSISTENCE-V5-20261010.md` distinguent désormais cette fondation livrée localement du raccord financier complet encore à construire. Aucun composant, moteur CH, abonnement, route publique ou source native n'est modifié par ce jalon.

## 4. Migration et retour arrière

Quatre tables privées sont ajoutées : grants TEST, heads, events et receipts. RLS est activée et les accès PUBLIC/anon/authenticated sont révoqués. Un grant TEST vivant, versionné et provisionné par le propriétaire de la base est obligatoire ; le rôle serveur ne peut pas s'en créer un. Le rôle NOLOGIN d'admission existant reçoit seulement l'accès au marqueur `organization_id` et au gardien nécessaires pour ne pas contourner le gel dans ses triggers ; il ne reçoit pas le livre, les grants ou les reçus.

Verrous de promotion : workspace, configuration, head ERP4, grant, puis head financier. Les anciennes mutations, changements de configuration et suppressions/troncatures sont gardés. Les entreprises CH explicitement confirmées conservent leur juridiction immuable ; aucun pays n'est inféré pour les anciennes entreprises non confirmées.

Installation locale uniquement. Aucune migration hébergée, donnée existante, région, offre Stripe ou distribution native n'est modifiée. Avant tout déploiement, réconcilier la chaîne réellement appliquée, capturer les définitions/ACL des fonctions remplacées et faire approuver la migration et son plan opérationnel.

Retour arrière opérationnel : ne plus provisionner de grants, puis les révoquer avec une version supérieure. Sans promotion, les anciens livres restent leur autorité. Après promotion, conserver le marqueur et l'historique ; ne pas supprimer le head V5 pour rouvrir ERP4. Préférer une correction additive et un éventuel parcours de migration explicitement vérifié. Aucun script de suppression ou retour arrière de données n'est exécuté ni annoncé comme testé. Une erreur de promotion doit annuler sa transaction entière et laisser ERP4 utilisable.

## 5. Validation exécutée

Les résultats définitifs, les commandes, les fichiers couverts et les empreintes sont consignés dans la preuve JSON de cette phase. Les tests de l'adaptateur utilisent des réponses RPC fictives ; les tests PostgreSQL exécutent réellement les migrations et les RPC avec PGlite local. Ces deux niveaux sont identifiés séparément.

Résultat final : **4 741 tests réussis dans 142 fichiers**, aucun échec, skip ou todo ; les 140 fichiers du jalon précédent sont conservés. Les **72 tests d'adaptateur** et **44 tests PostgreSQL** sont inclus dans ce total, avec les 195 tests du noyau financier et les 33 tests PostgreSQL de commandes/originaux fournisseurs déjà présents. TypeScript global sans cache incrémental, lint typé des trois nouvelles sources TS avec warnings refusés, contrôle de marque et build production réussis. Les avis existants de compilation sur conventions middleware, taille de chunks et classification de routes ne sont pas présentés comme une publication.

La base PostgreSQL WASM utilise un vrai répertoire NodeFS local. Après fermeture propre puis réouverture du même répertoire, les tests retrouvent le livre exact, le reçu de promotion, les clés legacy et le gel ERP4. Cela ne démontre pas une récupération après crash ni la concurrence de plusieurs connexions PostgreSQL.

Le lint local de la CLI Supabase a été tenté explicitement et échoue sur `127.0.0.1:54322` faute de serveur local/Docker. Il n'est pas annoncé comme réussi. Aucun advisor, `db pull` ou inventaire des migrations hébergées n'est exécuté comme remplacement. Les catalogues RLS/ACL et les comportements SQL sont vérifiés dans la base PGlite ; cela ne remplace pas une recette Supabase complète.

## 6. Risques et limites

- La concurrence multiconnexion, les deadlocks, les crashs et les SLA ne sont pas démontrés par PGlite, qui sérialise ses transactions. Les écritures directes peuvent prendre un verrou de tuple avant le trigger : une recette PostgreSQL multiconnexion reste nécessaire.
- Les anciens chemins US et ceux dont le pays n'est pas confirmé exigent `READ COMMITTED` pour ne pas accepter un marqueur périmé sous un ancien snapshot. Ce refus est explicite ; il ne doit pas être présenté comme une compatibilité avec tous les niveaux d'isolation. CH confirmé est testé séparément.
- `TRUNCATE` est refusé inconditionnellement sur toutes les tables gardées, y compris les tables partagées et les entreprises CH/non promues. Cette contrainte de maintenance globale ferme les courses de suppression de table ; elle est distincte des opérations applicatives CH préservées. Son adoption hébergée doit être évaluée dans le plan d'exploitation approuvé.
- Le grant PostgreSQL est une autorité locale TEST, indépendante de D1/Auth/Stripe. Une revalidation serveur avant/après RPC ne crée pas de transaction distribuée ni de révocation D1 atomique.
- L'acteur de promotion reste sa provenance historique lors d'une reprise ; son timestamp n'est pas une attestation de fraîcheur. L'admission vient de la revalidation et du grant PostgreSQL vivant.
- Les limites SQL de taille sont volontairement conservatrices : 4 Mio de JSONB textuel, profondeur 20, 50 000 valeurs, 1 000 éléments par tableau, 524 288 octets UTF8 par chaîne/clé et 2 097 152 octets cumulés de chaînes/clés. Les octets UTF8 ne sont pas des unités UTF16 ; ce garde est plus strict pour certains textes, sans promesse de parité ou de capacité commerciale.
- La corroboration d'un reçu legacy conserve son index et borne sa révision à la baseline. La baseline ne contient pas toutes les commandes historiques : ce reçu ne peut pas être intégralement régénéré à partir du seul journal financier.

## 7. Terminé dans ce jalon

Promotion contrôlée, provenance et politique immuables, import complet des clés legacy, reprises exactes, accès TEST révocable et versionné, gardiens SQL des anciens ports et adaptateur privé strict. Le livre de départ et son index sont persistés ensemble ; aucune seconde comptabilité « courante » n'est servie après promotion.

## 8. Expérimental et suite obligatoire

Les opérations ERP mixtes/avoirs/encaissements restent exécutables dans le moteur mémoire TEST précédent. Elles ne sont pas encore ajoutables à ce stockage SQL. Il faut reconstruire indépendamment en SQL les effets de chaque commande, les allocations, le solde AR, les périodes et les postes exacts, puis ajouter le CAS/event/receipt sous la même autorité.

Restent ensuite le raccord des sources sidecar au livre courant, la projection publique V5, le navigateur TEST et les transports natifs cohérents ; l'outbox fiscale et les observations prestataire ; les crédits excédentaires/remboursements, acomptes, récurrence, cash basis et livraisons ; la recette hébergée autorisée et l'examen professionnel. Aucun taux national unique, certification US GAAP ou activation commerciale n'est revendiqué. L'objectif ERP international demeure actif.

Références techniques consultées : [fonctions Supabase](https://supabase.com/docs/guides/database/functions), [isolation PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html), [verrouillage PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html). Le [changelog Supabase](https://supabase.com/changelog.md) a été relu le 10 octobre : la dépréciation des bridges `@supabase/server` n'affecte pas le client REST propre au dépôt ; cette migration n'introduit ni anciens chiffrements pgcrypto, ni index ltree/btree_gist concernés par les changements mineurs recensés.
