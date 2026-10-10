# Zentra US — achats PostgreSQL privés TEST V5

10 octobre 2026. **Livraison locale privée TEST validée.** Base `c6202a1`, implémentation `46052ab9eaa8e250ff7c548758308ccf98176c26`. Ce jalon poursuit le même ERP international et son livre unique. Aucune migration hébergée, activation fournisseur, route publique, UI ou version native n'est publiée. Preuve : `docs/evidence/us-financial-purchasing-v5-20261010.json`.

Suite additive validée : `US-FINANCIAL-TEST-ACCOUNTING-V5-20261010.md` ajoute journaux et périodes au même livre et préserve les résultats/histoires de cette livraison. Le port purchasing refuse désormais par PF008 une queue comptable avant replay ; il ne sert pas une projection partielle comme état courant.

## 1. Modifications

Le port privé `postgres-test-purchasing-v5` ajoute fournisseur, facture fournisseur approuvée manuellement et paiements enregistrés, aux clients/devis/acceptations/avoirs/encaissements déjà admis. Les commandes restent exactes, fermées et liées à un grant TEST vivant. Les nouveaux achats doivent produire les mêmes records, journaux et audits que le domaine existant, reconstruits indépendamment en PostgreSQL.

Le vrai ledger inclut tous les avoirs et effets ERP d'achat. La révision métier compte chaque événement ; la révision comptable compte les audits réels. La compatibilité ERP4 éphémère retire seulement les avoirs et renumérote son propre ledger ; elle ne devient jamais un état courant stocké ou public. La baseline, les snapshots de factures, l'approbation et les reçus restent conservés.

Ce périmètre manuel USD/accrual/TEST utilise `purchases` contre `payables` pour la facture, puis `payables` contre `cash` pour le paiement. La taxe d'achat fournie est incluse dans le coût, sans crédit de TVA suisse ou détermination de fiscalité américaine. Un paiement enregistré n'exécute aucun virement. Stocks, investissements, use tax, avoirs fournisseurs et validation comptable professionnelle restent hors de ce lot.

## 2. Fichiers créés

- `lib/international/us-financial-test-purchasing.ts` : entrée nommée privée.
- `lib/international/us-financial-test-purchasing.test.ts` : moteur réel, transport RPC fictif.
- `lib/international/us-financial-test-purchasing.postgres.test.ts` : chaîne SQL locale et données fictives.
- `supabase/migrations/20261010091729_international_us_financial_test_purchasing_v5.sql` : nouvelle migration créée avec la CLI, validée sur PostgreSQL local.
- Plan `US-FINANCIAL-PURCHASING-PERSISTENCE-V5-20261010.md`, cette livraison et `docs/evidence/us-financial-purchasing-v5-20261010.json`.

## 3. Fichiers modifiés

- `lib/international/us-financial-kernel-runtime.ts` : capacité supplémentaire, allowlist cumulative fermée ; droits financiers TEST conservés.
- `lib/international/us-financial-test-store.ts` : troisième profil interne constant et factory nommée, validation/corroboration communes sans API générique publique.
- `lib/international/runtime.ts` : corrige l'enregistrement d'un fournisseur inchangé en émettant son snapshot unique exigé par le contrat SQL/sync existant, sans élargir ce contrat.
- `lib/international/purchasing-runtime.test.ts` : deux cas cash/accrual du vrai moteur et applyDelta, ordre des fournisseurs, ancienne facture et reprise exacte sans second commit.
- Documents de statut/persistance et suite commerciale, après validation finale.

Le domaine comptable et le pont mémoire V5 restent inchangés. Le correctif du constructeur de commit ERP est limité au snapshot fournisseur déjà exigé par les contrats publics ERP1–4 ; leur schéma/permission n'est pas élargi. Les anciennes migrations, CH, tarifs, UI et applications natives restent inchangés.

## 4. Migration et retour arrière

Le projet conserve les mêmes tables baseline/événements/reçus/curseurs/grants/plans. La nouvelle migration prévalide les livres présents avant ses remplacements, sans réécriture. Tous les chemins d'append et d'INSERT direct utilisent le même replay complet et la complétude différée. Les ports précédents refusent PF008 avant toute projection hors de leur capacité, notamment commercial après une queue fournisseur.

RLS et ACL privées, invoker/search_path vide, grants versionnés protégés, capture/revalidation avant/après attentes, horloges et CAS de révision/hash restent obligatoires. Le rôle serveur est de confiance, pas une frontière d'isolation entre ses propres lectures ; il ne doit pas pouvoir provisionner ses grants/plans. PO008 reste une admission des nouvelles mutations de source, jamais une condition réinterprétant le replay historique.

Retour arrière prévu, non exécuté : fermer les nouvelles admissions et révoquer les grants par version supérieure ; conserver le replay compatible et tout l'historique. Après une première opération fournisseur, ne pas retirer sa queue ni rétablir un ancien lecteur commercial qui l'ignore. Corriger par migration additive après inventaire/ACL et approbation explicite de toute adoption hébergée.

## 5. Tests réellement exécutés

Régression finale exécutée sur les sources figées : **4 971 / 4 971 tests, 148 fichiers, zéro échec, skip ou todo**. Les 146 fichiers du lot commercial sont conservés. Le total comprend les 60 nouveaux tests adaptateur (moteur réel, RPC fictives), les 34 nouveaux tests PostgreSQL et les deux cas no-op ajoutés au fichier achats existant. Les relances ciblées se recouvrent et ne s'additionnent pas à ce total.

PostgreSQL WASM charge réellement les 28 migrations antérieures puis la nouvelle migration. Il installe celle-ci sur un livre commercial/settlement déjà peuplé, vérifie facture fournisseur, paiements partiels, snapshots historiques et écritures réelles, puis poursuit clients/devis/encaissements/avoirs. Une baseline contenant déjà audits d'ouverture/clôture et achats/paiement est conservée. Le no-op fournisseur est vérifié dans ERP4 avant promotion puis dans V5. IDs de registres réutilisables et IDs de nouveaux règlements en collision sont distingués. ACL, grants vivants, gardes de source, fraude, CAS, rollback atomique et anciennes capacités sont testés.

Le même stockage NodeFS a été fermé puis réouvert avec livre/reçus/gel conservés ; exemple de run ciblé final : `D:/Codex-Zentra-Temporary/2026-10-08/native-admission-temp/zentra-purchasing-test-v5-WZUJdo`. Cela n'est pas une simulation de crash. Le focus root du no-op passe également 126/126 dans trois fichiers existants, inclus ensuite dans la régression.

TypeScript global non incrémental, lint typé avec refus des warnings sur les sept fichiers TS, contrôle de marque et build production : sortie 0. Le build a été relancé après le correctif runtime final ; seules des modifications SQL/tests ont suivi. Notices vinext existantes, aucune publication. Le lint Supabase CLI local n'est pas revendiqué : l'essai antérieur sans serveur local retournait ECONNREFUSED à 127.0.0.1:54322 ; aucun hébergement n'a été utilisé pour le remplacer.

Les échecs intermédiaires restent documentés : timeout d'une longue verticale et attentes ACL trop strictes (30/32, puis 31/32), puis PF002 correct d'identité réservée attendu à tort PF004 dans un cas ajouté (33/34). Seules les attentes/timeout ont été corrigés, pas le moteur pour faire passer ces tests. La recette ciblée finale est 34/34 puis la régression ci-dessus. Revue indépendante du SQL et du correctif d'origine favorable, en lecture seule.

## 6. Risques et limites

- Le replay est borné, avec snapshots répétés et budgets conservés. Aucune capacité de 150 entreprises ou latence de production démontrée.
- PGlite/NodeFS et conflits CAS séquentiels ne prouvent ni concurrence multiconnexion, ni crash recovery, ni SLA.
- D1/Auth/Stripe/PostgreSQL ne partagent pas de transaction. Un refus après append ne démontre pas l'absence de commit ; résoudre la clé originale avec autorité actuelle.
- Legacy/sidecars restent gelés, dont originaux et import Automation après promotion. `sourceReference` ne prouve pas l'archivage d'un justificatif.
- La restriction administrative globale de TRUNCATE héritée demeure, y compris CH/non promues ; son exploitation doit être examinée avant hébergement.
- Hypothèse de charge achats manuels limitée, sans certification US GAAP ni garantie de conformité fiscale.

## 7. Terminé

Fournisseur → dette → paiements partiels/entiers durables, dans le même historique que clients/devis/acceptations/avoirs/encaissements, avec reconstruction SQL indépendante et autorité courante. Le bug concret de sauvegarde du fournisseur inchangé est corrigé à l'origine : exactement son snapshot requis, sans nouvelle écriture comptable ou second commit au retry. Aucun fallback vers un registre figé.

## 8. Expérimental et suite

Le lot reste privé/local/TEST, sans données client réelles. Restent les journaux/contrepassations/périodes, puis nouvelle émission client avec préparation fiscale et PO011 de source V5. Prévoir ensuite un vrai consommateur V5 : DTO sans faits privés, rapports/exports, HTTP/synchronisation et interface pilote, puis sidecars/Automation et validation hébergée approuvée. Acomptes, récurrence, livraisons, remboursements, cash basis, paiements externes et validation professionnelle demeurent ouverts. L'objectif ERP US complet reste actif.
