# Preuve fiscale publique — correctif additif du 8 octobre 2026

Travail local sur `D:/Codex-Zentra-Temporary/2026-10-08/international-site`. Aucun appel de production, aucun accès à des données clients et aucun déploiement de migration. Les données et taux utilisés dans les tests sont fictifs et ne constituent pas une détermination fiscale.

## Modification

Fichier créé : `supabase/migrations/20261008013200_international_tax_proof_allowlist.sql`.

Le helper `zentra_us_erp_tax_proof_valid(jsonb,text)` valide le contrat public de preuve : exactement onze champs de preuve et exactement quatre champs par ligne, avec les champs obligatoires présents. Il lie l'organisation à la ligne, impose US/USD et les sources US existantes, vérifie les types et conserve la représentation exacte des montants en unités mineures. Il ne calcule aucun taux et ne détermine ni nexus, ni exemption, ni confiance dans un prestataire.

La fonction est `SECURITY INVOKER`, immuable, avec `search_path=''`. Son exécution est réservée à `service_role` ; aucun nouveau droit client ou table n'est ajouté. La RLS existante reste activée.

Une contrainte `CHECK ... NOT VALID` est ajoutée aux factures de `zentra_us_erp_records`. Les nouvelles insertions et mises à jour doivent respecter le contrat ; les lignes historiques ne sont pas scannées, réécrites ou supprimées à l'application. Ce comportement repose sur le contrat documenté de PostgreSQL et a été vérifié sur la pile locale. [Documentation PostgreSQL — ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html).

Les anciennes migrations sont inchangées. Aucun backfill ou validation globale n'est exécuté. Les anciennes factures contenant des champs supplémentaires restent physiquement présentes avec leurs reçus et événements. Le lecteur applicatif strict doit refuser ces états et demander une revue administrative explicite. Une projection publique en secours retire les champs de prestataire bruts sans modifier le stockage privé ; elle ne remplace pas le refus du lecteur.

Une conséquence volontaire : l'ajout d'un paiement à une ancienne facture hors contrat est lui aussi refusé par le CHECK. Les champs historiques figés ne peuvent pas être corrigés silencieusement par UPDATE. Il faut une procédure d'archive et de revue séparée, approuvée, qui conserve le document, sa preuve, ses reçus et son historique.

## Tests exécutés

Nouveau fichier : `lib/international/runtime-tax-proof-postgres.test.ts`.

```powershell
$env:PGLITE_MODULE_DIR='D:/Codex-Zentra-Temporary/2026-10-07/international/postgres-tests/node_modules/@electric-sql/pglite'
node node_modules/vitest/vitest.mjs run lib/international/runtime-tax-proof-postgres.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit --pretty false
```

Résultat à 01:29 heure locale : **9 tests réussis**, PGlite **0.5.8**, pile de quatre migrations précédentes et correctif. TypeScript : succès sans diagnostic. `git diff --check` : succès ; avertissements ordinaires LF/CRLF sur des sources éditées par d'autres agents, aucune erreur d'espacement.

Preuves couvertes :

- Preuve propre issue du véritable moteur : persistée, reçu idempotent réutilisable, reconstruction exacte du cache public par delta, autre entreprise inchangée.
- Champs supplémentaires `provider`, `providerDebug`, `credential` ou champ privé de ligne : refus SQL `23514`. Le head, les compteurs, la facture, le journal, le reçu et les événements restent exactement à leur état antérieur.
- Chaque champ obligatoire de preuve et de ligne retiré séparément : refus. Null, tableaux ou objets incorrects, révision non entière, organisation étrangère, preuve CH et montants décimaux : refus.
- Fonctions invoker, immuables, search path vide et droits service-only vérifiés dans le catalogue ; appels anon/authenticated refusés `42501`, RLS conservée.
- Avant le correctif : une vraie facture du flux local est volontairement enrichie de métadonnées privées fictives au niveau SQL. Après le correctif : `payload::text`, état brut, reçu et delta sont inchangés ; `convalidated=false`, helper false, lecteur runtime refusé `invalid_stored_state` / 503 ; projections sans le marqueur privé ; paiement ultérieur refusé sans mutation.
- Aucun UPDATE, DELETE, TRUNCATE ou VALIDATE CONSTRAINT dans la migration.

## Empreintes de la pile testée

| Migration | SHA-256 |
| --- | --- |
| `20261007194528_international_workspace_country_config.sql` | `097bcc42c4e2cd8835a62b240152038711d9b3e2d88dda8cc4da9cb8d151cae9` |
| `20261007222349_international_us_erp_persistence.sql` | `80a2fae2ddf7e59d64d2ffb49c51ba61842c02f57700f3f013fa4a877a5bf68c` |
| `20261007224820_international_us_erp_delta_stream.sql` | `3df54310c2da0012d9065886df86a6524963ab594a1f314d10d45fac551af345` |
| `20261007225725_international_us_erp_seller_snapshot.sql` | `119e0c850c04c6772c0b002384c2cf86c8ab3427ec24586eb77f73a2a314f4f9` |
| `20261008013200_international_tax_proof_allowlist.sql` | `7f2d18ba19defb35dc3352624b18f951a26f806b86eb19d2c10c0c2bf4f977d8` |

## Déploiement et limites

Ce correctif reste proposé pour staging. Avant production : inventorier les preuves historiques hors contrat, conserver leurs archives, examiner leur chemin de traitement, tester le prestataire réel en sandbox et obtenir l'accord de déploiement. `ADD CHECK ... NOT VALID` prend un verrou DDL ; prévoir un court créneau et un timeout de verrou en staging, sans prétendre qu'il n'y aura aucun blocage opérationnel.

La validation NOT VALID ne certifie pas toutes les lignes anciennes. Ne pas lancer VALIDATE CONSTRAINT tant que la revue historique n'est pas achevée. Un retour arrière DDL serait possible en retirant la contrainte puis le helper, mais il rouvre l'admission des champs bruts : couper les fonctionnalités US, conserver les protections applicatives et ne l'exécuter qu'après décision explicite. Aucun retour arrière n'a été exécuté.

Ces tests n'établissent pas une conformité fiscale, un prestataire effectif, un déploiement Supabase réel, une transaction D1/PostgreSQL distribuée, une course entre plusieurs connexions, un parcours natif ou une certification comptable.
