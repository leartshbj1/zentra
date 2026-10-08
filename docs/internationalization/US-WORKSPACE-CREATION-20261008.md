# Création d'un nouvel espace US — fondation du 8 octobre 2026

Cette étape suit le [plan audité](NEW-US-WORKSPACE-ADMISSION.md), au checkpoint documentaire `2d2c8d3b136c5d22ba543dad79c813afd651573d`. Elle ajoute une réservation serveur et une admission PostgreSQL durable dans le clone de fonctionnalité. **Elle ne livre pas encore une entreprise US utilisable.** Aucun code, migration, réglage, abonnement ou donnée de production n'est changé par cette étape.

## Comportement livré dans les sources

Le parcours `POST /api/international/workspaces` utilise le même compte Auth que les entreprises CH existantes. Il alloue deux UUID côté serveur : organisation et création. Le client ne peut fournir ni organisation existante, ni acteur, rôle, abonnement, empreinte ou droit. Il confirme explicitement la version 1 du choix US/USD, avec nom, adresse, fuseau, langue, méthode comptable et préfixe. Le choix national ne vérifie pas un EIN et ne configure pas la sales tax.

La route accepte uniquement la session navigateur vérifiée, sans accès offert réclamé implicitement. Une autorisation d'appareil CH ne donne pas le droit de créer une nouvelle entreprise. L'origine, la taille du corps, la fréquence, les champs et l'identité sont contrôlés. Le même compte est revalidé avant réservation, avant PG, avant confirmation D1 et avant réponse. Le GET de reprise recherche uniquement le couple acteur authentifié/requestId.

| Étape durable | Garantie et limite |
| --- | --- |
| D1 `reserved` | Couple acteur/requestId unique, identité et configuration immuables ; refus d'une organisation ou trace legacy attribuable préexistante. Aucun `organizations`, membership, abonnement ou accès appareil n'est créé. |
| Admission PG | Dans une transaction PG : parent neuf strict, preuve immuable et reçu national initial. Un parent préexistant, même vide, est refusé. La reprise exacte conserve la preuve et le reçu initial. |
| D1 `postgres_confirmed` | Vérification de tous les champs du reçu puis CAS. Une réponse PG ou D1 perdue reprend le même espace, sans second reçu initial. Cet état expose seulement `us_subscription_required`. |
| `ready` | **Interdit par trigger.** Aucun finaliseur ni catalogue d'abonnement US n'est installé. Il faudra une migration distincte, les droits propres de l'espace et le routage de compte/appareil avant ouverture. |

L'empreinte SHA256 est calculée côté serveur sur le contenu JSON canonique, incluant nom et version de confirmation. Les chaînes UTF-16 invalides sont refusées avant toute réservation. PG lie indépendamment les UUID, l'empreinte opaque et l'égalité JSONB de la configuration. Aucun algorithme de hachage approximatif ou comparaison de JSON avec un ordre de clés différent n'est utilisé.

Les données privées, dont l'EIN facultatif et le reçu de création complet, restent dans les stores serveur. Les réponses publiques utilisent la projection nationale sans EIN. Les diagnostics d'échec n'enregistrent que l'opération, le code et le statut ; aucun corps, jeton ou erreur brute du prestataire.

## Migrations proposées et sécurité

Toutes sont additives et générées par les CLI du dépôt. L'historique antérieur reste inchangé.

| Fichier | Contenu |
| --- | --- |
| `drizzle/0085_international_workspace_creation_intents.sql` | Intention durable, contraintes JSON sans contournement par NULL, identité/reçu immuables, refus de DELETE/REPLACE et de READY ; contrôle des traces métier directes et des quatre namespaces d'objets attribuables. |
| `drizzle/0086_international_legacy_country_guards.sql` | 114 triggers couvrant les mutations de 38 tables actuelles, OLD/NEW, liens parent/source, collisions de toutes les clés uniques sous REPLACE et namespaces exacts. Voir [inventaire et limites](LEGACY-D1-COUNTRY-GUARDS.md). |
| `supabase/migrations/20261008001726_new_us_workspace_admission.sql` | Preuve RLS réservée au serveur, rôle propriétaire NOLOGIN restreint, helper privé DEFINER et wrapper public INVOKER ; admission atomique, gardes sur les tables legacy et wrappers des cinq RPC historiques. |

L'API PG est `zentra_admit_new_us_workspace_v1(uuid,uuid,uuid,uuid,jsonb,text)`. Codes stables : PA001 entrée invalide, PA002 conflit, PA003 parent préexistant, PA004 ancien transport interdit, PA005 preuve/reçu incohérent, PA006 preuve immuable. `42501` refuse les droits SQL. Le rôle serveur ordinaire ne peut écrire la preuve ni devenir son propriétaire ; l'administrateur de migration conserve nécessairement son pouvoir d'administration.

Les fonctions historiques sont déplacées sans réécriture de leurs corps vers un schéma privé puis enveloppées par des gardes publiques. Leurs noms d'arguments et le comportement CH sont conservés. Les snapshots, fragments, blobs, numéros et reçus nationaux CH préexistants sont testés comme inchangés. Les guards US ne réétiquettent ni les anciennes configurations manquantes ni les entreprises suisses.

Ces migrations ne sont **pas appliquées en production**. Le schéma Supabase live doit être réconcilié avant toute application : ordre complet collaboration/contenu/pays/ERP/deltas/vendeur/admission/preuve fiscale, rôles, privilèges et contraintes. D1 doit disposer de la chaîne 0000–0086. Le rôle et le schéma privé nouveaux exigent une vérification de disponibilité ; aucun DROP ou contournement silencieux d'un nom déjà présent.

## Activation, reprise et retour opérationnel

`INTERNATIONAL_CORE_ENABLED` et `INTERNATIONAL_US_CREATION_ENABLED` doivent tous deux être exactement `true`. Les bindings sont absents/non activés dans les réglages de production ; la route fermée renvoie 404 avant l'authentification et les accès stockage. Aucune configuration de déploiement n'est modifiée. Le moteur fiscal réel reste absent ; aucun Price ID CHF, licence CH, siège ou souscription suisse n'est copié.

D1 et PG sont deux transactions différentes. Une panne conserve une intention réservée et son identité : on reprend, on ne supprime ni ne recycle cette identité. Une revalidation d'autorité ne constitue pas une transaction distribuée face à une révocation simultanée. Aucun effet financier ou ouverture de droits n'appartient à cette étape.

Le retour opérationnel ferme les flags ; les intentions et preuves restent conservées. Ne pas désinstaller leurs gardes après des admissions. Une correction, rétention ou suppression administrative future exige une procédure revue, incluant historique et données privées, plutôt qu'une suppression de table pour contourner une erreur.

## Fichiers créés et modifiés

Créés :

- `app/api/international/workspaces/route.ts`.
- `lib/international/workspace-creation.ts`, `workspace-creation-d1.ts`, `workspace-creation-server.ts` et leurs tests `workspace-creation.test.ts`, `workspace-creation-d1.test.ts`, `workspace-creation-review.test.ts`, `workspace-creation.integration.test.ts`.
- `lib/international/legacy-country-guard.ts`, `legacy-country-guard.test.ts`, `legacy-country-guard.migrations.test.ts`.
- `lib/international/new-us-workspace-admission.postgres.test.ts`.
- Les trois migrations ci-dessus, `drizzle/meta/0085_snapshot.json`, `0086_snapshot.json` et les documents de cette phase.

Modifié : `drizzle/meta/_journal.json`, par ajout des deux nouvelles entrées. Aucun fichier métier CH existant n'est changé par ce lot de code.

## Validation

Le [rapport consolidé](evidence/us-workspace-creation-20261008.json) conserve les empreintes des sources, commandes et résultats. Les sorties détaillées restent dans `.qa/us-workspace-admission/` du clone. Validation finale réellement exécutée :

| Contrôle | Résultat et portée |
| --- | --- |
| Suite internationale, `PGLITE_MODULE_DIR` défini | **679 passés, 25 fichiers, zéro échec/skip** ; comprend les 533 scénarios du checkpoint précédent et 146 nouveaux tests de création, erreurs, confidentialité et guards. |
| Contrat PG complet | **18 passés**, compris dans les 679 ; schémas réels de collaboration/contenu/pays, RLS et rôles dans PGlite, données CH et corps/signatures des RPC préservés. |
| Intégration service → store → RPC réel | **6 passés**, compris dans les 679 ; 87 migrations D1 dans SQLite Node et les 6 migrations internationales après collaboration/contenu dans PGlite. Réponses perdues PG/D1, reprise après restart et conservation CH. |
| Gardes D1 + précontrôle | **15 passés**, compris dans les 679 ; SQLite et workerd avec la chaîne 0000–0086. Huit réservations, puis huit appels du service concurrent, ne produisent qu'une intention. Le port PG de ce scénario workerd est explicitement simulé. |
| Régressions legacy, six fichiers | **260 passés, 51 scénarios optionnels ignorés**, zéro échec ; bootstrap, publication, fichiers, numéros, copie et sauvegardes. Les cas ignorés ne sont pas des validations réussies. |
| Typecheck global du clone | `tsc --noEmit --incremental false`, exit 0. |
| Lint international et ses routes | `oxlint lib/international app/api/international`, exit 0. |
| Lint global du dépôt | **Exit 1, 118 diagnostics sur des fichiers suivis inchangés depuis la base**. Cette dette préexistante est consignée ; elle n'est pas présentée comme corrigée. |
| Prébuild branding et Vinext production | Exit 0. Avertissements existants : convention middleware dépréciée et classification statique de certaines routes indisponible. |

Ces résultats distinguent services simulés, SQLite Node, runtime workerd/D1 et PostgreSQL WASM. PGlite 0.5.8 utilise PostgreSQL 18.3/WASM et une connexion sérialisée ; la version live observée précédemment était différente. Un test d'intégration local n'est jamais présenté comme une recette de production, une preuve PostgREST ou une course à deux connexions.

## Conditions encore nécessaires avant ouverture US

1. Brancher les précontrôles sur toutes les routes et bibliothèques legacy identifiées, **avant** lectures/replays/uploads R2 ou PG ; les triggers SQL seuls ne prouvent pas l'absence d'octets externes. Le helper existe mais ses appels de production ne sont pas intégrés dans ce lot.
2. Fournir le catalogue et l'autorité de droits US propres à la nouvelle organisation, puis la finalisation D1 owner/abonnement/ready ; aucun prix arbitraire ne peut remplacer cette décision.
3. Adapter les sélecteurs d'entreprise, comptes, invitations, claims et connexion d'appareil à l'édition. Les chemins historiques supposent encore les droits CH. Les intentions restent absentes de leurs listes puisque les lignes d'organisation ne sont pas créées.
4. Ajouter l'onboarding et le rattachement natif US, sans transformer ni importer automatiquement le livre local CH. Le pilote et la bibliothèque comptable ne remplacent pas ce démarrage.
5. Recette staging avec deux connexions PG distinctes, courses D1/PG explicitement orchestrées, interruptions, permissions révoquées, reprise et anciens appareils hors ligne. PGlite sérialise ses requêtes et n'apporte pas cette preuve.
6. Continuer les modules ERP encore incomplets : fournisseurs/achats, commandes/avoirs/récurrence, documents et mail réels, correction comptable, banques et workflows Support/Automation persistés. Prestataire fiscal, paiements, entitlements et conformité restent à valider séparément.

Ni capacité de charge multi-clients, ni conformité US GAAP, ni validité fiscale d'un EIN, ni release native installable n'est annoncée par ce checkpoint.
