# Revue du démarrage national — 8 octobre 2026

Revue locale du clone SITE `D:/Codex-Zentra-Temporary/2026-10-08/international-site`, après le checkpoint `0bd4ef05254f16a5623cf227d083670aa3d357a2`. Ce document fournit des contrôles et scénarios à implémenter ou vérifier ; il ne prétend pas que tout le parcours UI/native est déjà livré. Aucune source concurrente, donnée client, migration déployée ou production n'a été modifiée par cette revue.

## Ce qui existe et a été vérifié

`country-config.ts` impose explicitement CH ou US, la devise correspondante, une langue disponible, une adresse nationale valide, un fuseau autorisé, une méthode comptable et un préfixe de facture. L'EIN est **facultatif**, accepté seulement pour US au format `NN-NNNNNNN`. Le validateur n'invente pas de pays pour un espace historique.

`workspace-server.ts` contrôle l'utilisateur, l'entreprise exacte et le rôle propriétaire pour PUT, puis la même origine pour le navigateur et la taille du JSON. `workspace-service.ts` filtre les champs, lie l'organisation au contexte authentifié, utilise une révision attendue et un requestId opaque, et vérifie le reçu retourné par PostgreSQL.

La migration `20261007194528_international_workspace_country_config.sql` est additive, n'effectue aucun backfill national, conserve les reçus dans un historique append-only, sérialise les modifications par le verrou de workspace et bloque le changement ultérieur de pays, devise et méthode comptable. Ses tables et RPC restent réservées au serveur avec RLS activée.

Ces protections sont nécessaires, mais ne prouvent pas qu'un workspace sans configuration nationale est neuf.

## Protections finales et conditions du parcours US réel

### 1. Ne pas confondre « pays inconnu » et « nouvel espace »

Le service conserve `country: unknown`, `preserveLegacyBehavior: true` et `requiresAdministrativeReview: true` pour un espace historique sans configuration. Le transport national appelle désormais un port d'admission serveur avant une première configuration US. Son binding réel refuse toujours avec `409 legacy_review_required` ; seuls les tests fictifs injectent une attestation. Un booléen fourni par le client ne peut pas ouvrir ce chemin.

Ce refus ferme le risque d'admission implicite dans le transport actuel. Le RPC ne prouve toujours pas, seul, l'absence d'un livre historique ou d'une publication en cours. L'attestation d'une création réellement nouvelle et le verrou partagé avec les publications anciennes ne sont **pas branchés** ; une ouverture US réelle attend ces protections. Aucune conversion ou suppression de livre CH n'a été effectuée.

Contrat recommandé :

- Créer **un nouvel organizationId** lorsque le propriétaire choisit « Nouvelle entreprise aux États-Unis ». Une autre entreprise CH appartenant au même compte reste indépendante et accessible.
- La première confirmation US requiert une attestation **serveur** de ce démarrage explicite. Une absence de configuration, une langue anglaise, un ZIP, un EIN ou un booléen fourni par le client ne constitue jamais cette preuve.
- Sans preuve exploitable, conserver le parcours historique et refuser la première écriture US avec un conflit compréhensible, par exemple `legacy_review_required`. Ne jamais tenter de reconstruire ou convertir automatiquement un ancien livre.
- Vérifier les autorités métier existantes : notamment les anciennes publications D1 (`business_sync_spaces`, transferts et données métier) et les anciens snapshots Supabase (`zentra_workspaces.revision`, `snapshot_id`, `zentra_workspace_snapshots` et contenus préparés). Un transfert en préparation compte aussi ; un head à zéro ne prouve pas l'absence de données hors ligne ou d'upload en cours.
- Le contrôle et la confirmation doivent partager un verrou ou un mécanisme d'admission durable avec les publications historiques. Un contrôle de vacuité suivi plus tard d'un PUT permettrait une course. D1 et PostgreSQL sont deux autorités distinctes : ne pas revendiquer une transaction distribuée inexistante.
- Une fois US confirmé, une publication d'un livre CH vers cet identifiant doit être refusée. La preuve d'initialisation US n'autorise pas les transports historiques à publier des règles suisses dans ce nouvel espace.
- Une véritable migration d'un espace ancien nécessite une procédure séparée, explicitement approuvée, avec plan de correspondance et conservation de l'historique. Elle n'appartient pas à ce formulaire.

Le transport navigateur/natif et son refus par défaut sont codés et testés localement. Ils revalident l'identité exacte, le rôle, l'entreprise, le siège et les droits Gestion après les lectures et avant l'écriture CAS. L'authentification native refusée ne revient jamais aux cookies. Les tests ne constituent pas un déploiement ou une preuve de transaction distribuée entre D1 et PostgreSQL. Le parcours réel de création US attestée reste à développer.

### 2. Minimiser l'EIN dans les réponses et copies locales

Les réponses GET/PUT nationales utilisent désormais une projection publique sans EIN pour tous les rôles admis, y compris `read_only`. La projection ERP retire également l'EIN des configurations courantes, historiques de facture et de chaque événement delta. Le contexte stocké privé est conservé et les réponses n'en partagent pas les tableaux mutables. Les handlers ERP état/head/delta recontrôlent l'accès après la lecture, avant réponse ; les probes indépendants sur des données déjà remplies ont confirmé un 403 sans payload lorsque l'accès est révoqué pendant l'attente.

Lors d'une modification US depuis un DTO public, omission d'EIN signifie désormais conservation de la valeur privée issue de l'historique immuable de **l'entreprise et de l'expectedRevision exacts**. Le service ne récupère pas le head courant. Cela maintient un retry idempotent même si une modification privée ultérieure a changé l'EIN. Baseline absente : conflit explicite. Une nouvelle requête de révision zéro n'invente aucun EIN ; aucune opération publique de suppression n'est exposée. Le callback serveur final revalide l'autorité après cette lecture de baseline et avant le RPC.

Contrat recommandé :

- L'EIN reste facultatif pour ouvrir l'entreprise, créer des clients ou des devis. Ne demander aucune donnée réelle d'identification dans les démos.
- Séparer la configuration opérationnelle publique de la lecture des identifiants fiscaux. Par défaut, les réponses, événements, snapshots clients, exports de diagnostic et documents commerciaux ne contiennent pas l'EIN complet.
- Si un écran fiscal a réellement besoin de l'EIN, utiliser un accès dédié, lié à l'entreprise et au rôle autorisé. Une politique explicite propriétaire/comptable est une base à confirmer ; ne pas exposer la valeur à tous les collaborateurs simplement parce qu'ils ont un siège.
- Une projection d'état peut indiquer `hasEin` sans recopier la valeur. Un masque d'affichage éventuel ne remplace pas le filtrage serveur.
- Le backend peut conserver les données nécessaires dans le stockage protégé. Le DTO réseau ne doit pas prétendre être le même objet que le contexte privé utilisé pour reconstruire un document ou calculer une empreinte.
- Ne pas supprimer ou réécrire silencieusement les configurations historiques déjà persistées. Toute séparation de stockage ou évolution de contrat est additive et versionnée.

Cette recommandation relève de la minimisation et des permissions produit. Elle ne prétend pas que tout EIN d'entreprise est légalement secret ni imposer une nouvelle règle réglementaire universelle.

Une fuite distincte de métadonnées fiscales brutes a été reproduite pendant la revue : des clés supplémentaires du prestataire pouvaient être recopiées. Le moteur et les projections utilisent maintenant une preuve fiscale à champs explicitement sélectionnés. La migration corrective additive `20261008013200_international_tax_proof_allowlist.sql` bloque ces clés dans les nouvelles factures, sans réécrire l'historique ; le lecteur strict bloque les états anciens hors contrat. Voir [preuves et limites du correctif](./TAX-PROOF-MIGRATION-20261008.md). Un identifiant placé volontairement dans un champ public prévu reste de la responsabilité du port fournisseur ; aucun filtre ne prétend reconnaître arbitrairement tout secret.

## Checklist du parcours propriétaire

1. Vérifier la session et le siège de l'utilisateur, son rôle owner et l'organizationId cible côté serveur. Recontrôler cette autorité au moment de la confirmation définitive.
2. Montrer les entreprises existantes et offrir séparément « Nouvelle entreprise ». Un compte avec plusieurs espaces CH/US choisit son espace ; aucune fusion de livres par e-mail commun.
3. Distinguer espace historique inconnu, espace CH confirmé, nouvel espace en création US attestée, espace US confirmé et situation à examiner. Ces états doivent être explicites côté serveur.
4. Ne pas présélectionner puis confirmer silencieusement US. Demander le choix du pays de l'entreprise ; utiliser la langue du navigateur seulement comme aide de présentation.
5. Présenter avant validation un résumé court : nom de l'entreprise, États-Unis, USD, fuseau, adresse, méthode cash/accrual et préfixe des documents. Indiquer clairement que pays/devise/méthode ne sont pas une préférence modifiable librement après confirmation.
6. Faire de « Confirmer cette entreprise aux États-Unis » une action explicite, avec une version de confirmation et une trace acteur/date/configuration ou son empreinte. Ne pas inventer cette trace à partir d'un simple GET. Une évolution du reçu passe par un contrat et une migration versionnés.
7. Dériver USD du pays et valider les sous-divisions, ZIP et fuseaux côté serveur. La langue d'interface reste indépendante ; ne jamais traduire noms et données utilisateur.
8. Demander cash ou accrual explicitement avec une explication produit courte. Ce choix ne certifie pas qu'une méthode est fiscalement autorisée pour cette entreprise.
9. Laisser les taxes à `unconfigured` jusqu'au parcours fiscal réel. Une case remplie par le propriétaire ne prouve ni nexus, ni registrations, ni taux applicable. En absence de prestataire vérifié, l'émission nécessitant cette détermination reste bloquée avec une action utile.
10. Capturer un requestId pour la confirmation et réutiliser exactement le même contenu après timeout. En conflit de révision, relire et faire revoir le choix ; ne jamais écraser le choix effectué sur un autre appareil.
11. Ne marquer le parcours terminé qu'après reçu durable. Traiter proprement absence de workspace, rejet legacy, droits révoqués et service indisponible ; ne pas remplacer ces erreurs par une entreprise vide.
12. Lier le nom public du vendeur au profil autorisé de l'entreprise. Le pays seul ne remplit pas le vendeur ; avant émission, vérifier le snapshot public obligatoire sans nom de secours inventé.
13. Séparer choix d'édition et abonnement. Le choix US ne transforme aucun Price ID CHF existant en USD et n'active aucun module gratuitement. Les offres US non configurées restent indisponibles.
14. Pour mobile, afficher les champs utiles à l'étape, garder le résumé et la confirmation accessibles avec clavier/safe areas, et prévoir les mêmes validations dans les quatre langues. Les choix validés côté serveur restent identiques sur Windows, macOS, iOS et Android.

## Scénarios opérationnels à exécuter

| Scénario | Résultat exigé |
| --- | --- |
| Nouveau compte, nouvel organizationId, création US explicitement attestée, owner actif | Configuration US/USD persistée avec reçu ; ouverture du livre US distinct. Aucun appel fiscal inventé. |
| Workspace sans country config mais avec ancien livre CH ou snapshot | Refus `legacy_review_required` ; empreintes, nombres de documents, solde, historique et accès CH inchangés. |
| Workspace apparemment vide sans preuve serveur de création US | Refus par défaut ; l'absence d'historique réseau n'est pas une attestation. |
| Publication CH et confirmation US concurrentes | Une seule admission cohérente ; jamais un workspace US contenant un livre suisse admis entre vérification et commit. À tester avec de vraies connexions concurrentes en staging. |
| Ancien PC hors ligne qui revient après création d'un nouvel espace US | L'ancien livre conserve son organizationId CH ; aucun rattachement automatique au nouvel espace US. |
| US confirmé puis upload legacy/CH vers le même identifiant | Refus avant publication ; aucun document/numéro/livre modifié. |
| Même compte propriétaire de CH et US sur deux appareils | Sélecteur d'espace cohérent ; caches, abonnements, seller et numéros séparés par organizationId/édition. |
| Collaborateur, admin, comptable ou read_only tente de confirmer le pays | Refus avant accès privilégié en écriture ; rôle fourni dans le JSON ignoré/refusé. |
| Owner révoqué pendant le parcours | La confirmation finale échoue ; aucun reçu national créé. |
| Path de A avec configuration ou preuve destinée à B | Refus ; aucun accès, reçu ni disclosure de B. |
| Timeout après commit puis retry exact | Même reçu durable ; une seule révision et un seul événement de confirmation. |
| Deux appareils confirment deux choix avec expectedRevision 0 | Un seul succès ; le second reçoit un conflit explicite et relit le choix confirmé. |
| Modifier pays/devise/cash-accrual après confirmation | Refus du verrou national ; modification ordinaire de langue/adresse/fuseau autorisée uniquement avec audit et respect des règles historiques. |
| US sans EIN | Compte/entreprise/client/devis accessibles selon abonnement ; aucun EIN fictif demandé ou généré. |
| EIN réel présent, lecture member/read_only | Aucun EIN complet dans GET, delta, snapshot de cache, télémétrie ou document PDF commercial. Vérifier aussi les configurations historiques embarquées. |
| Lecture fiscale explicitement autorisée | Valeur disponible uniquement à l'entreprise et au rôle prévus, avec réponse non cachée et aucune journalisation de la valeur. |
| Adresse US, ZIP ou fuseau invalide ; USD déclaré pour CH | Refus déterministe sans écriture ni pays de secours. |
| Tax status configuré sans prestataire réel | Émission de facture nécessitant une décision fiscale bloquée ; la configuration nationale reste valide et le message dirige vers la configuration fiscale. |
| Drapeaux international absents/désactivés | Routes nouvelles fermées ; clients et écrans CH actuels continuent de fonctionner. |
| Enchaînement complet en staging et sur chaque appareil | Compte → nouvel espace US → client → devis → facture avec prestataire sandbox → encaissement ; aucun QR CH/TVA suisse ; protections fiscales/abonnements respectées. Ce parcours reste un test à faire. |

## Preuves locales exécutées

Tests TypeScript/ports locaux :

```powershell
node node_modules/vitest/vitest.mjs run lib/international/core.test.ts lib/international/workspace-service.test.ts lib/international/workspace-server.test.ts --maxWorkers=1
```

Résultat au point de revue initial : **125 tests réussis** (core 82, service 25, HTTP 18). Le service et le transport ont évolué ensuite ; cette quantité initiale ne doit pas être confondue avec le lot final ci-dessous.

Migration nationale sur PostgreSQL WASM isolé :

```powershell
$env:PGLITE_MODULE_DIR='D:/Codex-Zentra-Temporary/2026-10-07/international/postgres-tests/node_modules/@electric-sql/pglite'
node scripts/international/test-country-migration.mjs
```

Résultat : **17 assertions SQL réussies**, PGlite 0.5.8 / PostgreSQL 18.3. Horodatage outil `2026-10-07T23:18:15.380Z` ; SHA-256 migration `097bcc42c4e2cd8835a62b240152038711d9b3e2d88dda8cc4da9cb8d151cae9`.

Le parent du runner SQL est une table fictive ne contenant que organizationId. Ces 17 assertions prouvent les règles CAS/receipt/RLS examinées dans ce contexte ; elles ne prouvent **pas** l'absence d'un livre CH, le partage d'un verrou avec D1, la projection EIN, des connexions concurrentes, un parcours UI/native ou un déploiement réel. Les scénarios de la table ci-dessus ne sont pas annoncés comme réussis simplement parce que ces tests passent.

### Vérification finale du transport national

Le chantier backend a terminé **125/125 tests sans échec ni skip** : HTTP 18, natif 43, bindings de production 18, service 36 et intégration PostgreSQL WASM 10. La revue indépendante a réexécuté ce même lot à 01:32 heure locale : **125 réussis**, durée 11,80 secondes. Le dernier groupe exécute la vraie migration nationale sous `SET LOCAL ROLE service_role` et vérifie notamment l'EIN conservé, le replay ancien après un changement privé ultérieur, une réponse perdue, la baseline absente, la révocation native après une lecture SQL et les refus anon/authenticated. Il utilise une identité fictive et une seule base locale en mémoire.

Rapport JSON vérifié par l'agent backend : `D:/Codex-Zentra-Temporary/2026-10-08/native-country-tests-20261008.json`, SHA-256 `6ed6364227ec764137764f2a90c568fd6668628d31c8861ea30a4d57c8b7f318`. Le backend rapporte TypeScript global, lint des sept fichiers concernés et diff check réussis. Ce résultat concerne les transports et contrats locaux ; aucune activation de production n'est annoncée.

La revue indépendante a aussi exécuté **58 tests** ERP projection/HTTP/delta/bindings avant le dernier correctif fiscal, puis **93 tests** projection/finance/bindings après ce correctif, ainsi que **9 tests** PostgreSQL dédiés sur les cinq migrations et TypeScript global. Ces lots se chevauchent : ne pas les additionner pour annoncer un total général. La preuve détaillée du dernier lot se trouve dans la note fiscale liée ci-dessus.

Restent à livrer ou vérifier séparément : création US explicitement attestée, admission partagée avec les publications historiques, fournisseur fiscal réel en sandbox, configuration des offres USD, parcours complet staging et essais physiques multi-appareils. Les nouvelles protections ne transforment pas ces étapes futures en fonctionnalités acquises.
