# Zentra US — journaux et périodes PostgreSQL privés TEST V5

10 octobre 2026. **Livraison locale privée TEST validée.** Base `416a917`, implémentation `05cd853`. Le livre financier unique poursuit la continuité fournisseurs/commerciale ; aucune donnée, migration ou capacité hébergée n'est modifiée. Preuve : `docs/evidence/us-financial-accounting-v5-20261010.json`.

## 1. Modifications

La capacité privée `postgres-test-accounting-v5` ajoute journal manuel, contrepassation manuelle, ouverture et clôture de période aux six commandes ERP et aux avoirs/encaissements du lot achats. Le périmètre reste fermé US/USD/accrual/TEST, owner/admin/accountant sous grant versionné vivant. Le domaine existant est l'oracle de parité, sans réécriture ni certification comptable.

La projection reconstruit les périodes et le vrai ledger à chaque préfixe. Toute opération ajoute une révision métier ; une opération comptable ajoute un audit, même sans journal pour une période. Le header ERP compact retire uniquement les audits/écritures d'avoirs clients et garde les périodes courantes. Les règlements sont reconstruits depuis le vrai ledger explicite et les allocations historiques, sans baseline synthétique ni comptage artificiel d'événements. Les révisions des journaux peuvent comporter des intervalles correspondant aux audits de périodes.

Les journaux manuels excluent les comptes de contrôle, exigent équilibre exact et catégorie de trésorerie si nécessaire. La contrepassation conserve l'original et inverse exactement un journal manuel une seule fois. Les périodes suivent les règles existantes : append sans chevauchement après toutes les fins, fermeture de la plus ancienne ouverte, maximum 100, pas de réouverture. Les nouvelles écritures dans une période clôturée sont refusées sans invalider le replay des anciennes ; le travail commercial et les périodes ultérieures restent disponibles.

Deux défauts concrets ont été corrigés avant validation : le helper SQL POSIX refusait des caractères Unicode C1 autorisés par le domaine ; une réservation confondait clé brute d'opération et clé générée de journal. Le nouveau helper réutilise le validateur ASCII/UTF16/espaces existant et conserve le refus C0/DEL. Les réservations brutes et collisions de journaux sont désormais contrôlées séparément, sans modifier le domaine ni l'historique des migrations.

## 2. Fichiers créés

- `lib/international/us-financial-test-accounting.ts` : entrée nommée privée.
- `lib/international/us-financial-test-accounting.test.ts` : 60 tests moteur réel avec RPC fictives.
- `lib/international/us-financial-test-accounting.postgres.test.ts` : 39 tests PostgreSQL locaux.
- `supabase/migrations/20261010093930_international_us_financial_test_accounting_v5.sql` : créée réellement avec la CLI, validée localement.
- Cette livraison et `docs/evidence/us-financial-accounting-v5-20261010.json` ; le plan était déjà committé avant implémentation.

## 3. Fichiers modifiés

- `us-financial-kernel-runtime.ts` : capacité et allowlist cumulative fermée, refus avant IO.
- `us-financial-test-store.ts` : quatrième profil SQL constant et factory nommée ; capture et autorité revalidées conservées.
- Documents statut/persistance, plan et suite achats : résultat courant et limites ; les relevés historiques restent conservés.

Le domaine comptable et les contrats publics ERP1–4, anciennes migrations, données CH, tarifs, routes, UI et sources natives ne sont pas modifiés.

## 4. Migration et retour arrière

La nouvelle migration prévalide les livres existants, plans, curseurs et reçus sous verrous avant remplacement, sans réécriture. Elle les valide à nouveau avec le nouveau replay sous les mêmes verrous avant COMMIT ; toute divergence annule l'installation. Elle conserve les mêmes tables, grants, CAS et complétude événement/reçu/curseur. Tous les nouveaux appends et INSERT directs partagent le même replay et les mêmes règles. Les anciennes capacités purchasing et commercial refusent une queue comptable avant replay, y compris sans achat antérieur ; settlement/foundation restent fermées.

ACL/RLS, invoker/search_path vide, grants/plans réservés au DB-owner, autorité vivante, horloges et PO008 pour nouvelles mutations uniquement sont conservés. Rollback de livraison non exécuté : fermer les admissions par grants versionnés, conserver l'historique et un lecteur compatible, réparer par migration additive. Aucun retrait de queue ni retour silencieux au ledger4 figé. L'annulation atomique d'une écriture refusée est testée ; elle ne signifie pas qu'un append déjà committé peut être annulé. Toute adoption hébergée attend approbation explicite.

## 5. Tests réellement exécutés

- Régression finale réellement exécutée : **5 070 / 5 070 tests dans 150 fichiers**, aucun échec, skip ou todo ; les 148 fichiers précédents sont conservés.
- Les **60 tests adaptateur** et **39 tests PostgreSQL** nouveaux sont inclus dans ce total, pas ajoutés une seconde fois. La recette ciblée précédente de 173 tests/4 fichiers recoupe la régression finale.
- TypeScript global sans cache incrémental, lint typé des cinq fichiers TS concernés, contrôle des assets de marque et build de production : sorties 0. Le build porte sur les sources runtime/store/factory finales ; seuls SQL et tests ont ensuite été finalisés. Les notices vinext existantes de classification des routes/plugin/middleware/chunk ne constituent pas un échec ou un déploiement.
- PostgreSQL réel local WASM : **29 migrations antérieures**, puis nouvelle migration sur une queue achats mixte existante, y compris une clé brute préfixée valide. Installation additive, vrais effets et périodes, contrepassation, limites de montants par ligne, caractères, anciennes capacités, autorité, CAS, refus de falsifications et atomicité des écritures refusées vérifiés.
- Fermeture/réouverture propre NodeFS avec journaux, périodes, reçus et reprise exacte vérifiées. Répertoire ciblé conservé : `D:/Codex-Zentra-Temporary/2026-10-08/native-admission-temp/zentra-accounting-test-v5-1n9yOH`. Cela ne prouve ni crash recovery ni concurrence multiconnexion.
- Revue indépendante readonly sans défaut concret restant. Les journaux JSON/logs de recette sont hachés dans la preuve. Lint CLI Supabase local non relancé : la tentative antérieure échouait faute de serveur sur `127.0.0.1:54322`, sans Docker disponible. Aucun résultat hébergé ne remplace ce contrôle.

Le premier run PostgreSQL ciblé passe 39/39 ; le retrait d'un helper de test inutilisé et des annotations de types ont précédé la régression finale. Les deux défauts de parité ci-dessus ont été identifiés avant les résultats définitifs, pas masqués par une réduction de la sélection.

## 6. Risques et limites

PGlite/NodeFS est local et sérialisé, sans preuve de concurrence multiconnexion, crash recovery, SLA ou charge de 150 entreprises. Le replay/snapshots restent bornés ; périodes et journaux ne sont pas une clôture annuelle fiscale certifiée. D1/Auth/Stripe/PG ne partagent pas de transaction ; une erreur après append ne prouve pas son annulation. Legacy/sidecars restent gelés après promotion. Aucune opération fiscale, bancaire ou email réelle n'est exécutée.

Les contraintes héritées restent applicables : l'interdiction administrative TRUNCATE couvre aussi les tables CH/non promues et doit être examinée avant hébergement ; le garde READ COMMITTED US/pays inconnu et le comportement CH confirmé restent distincts. Promotion et premier append ne forment pas une transaction unique. Le rôle serveur est de confiance ; les grants privés TEST ne remplacent pas l'autorité d'abonnement/membership transactionnelle de production. Aucun de ces points n'est présenté comme résolu par les tests locaux.

## 7. Terminé

Journaux manuels, contrepassations et périodes sont durables dans le même livre privé TEST que ventes et achats. Le vrai ledger et ses audits sont reconstruits indépendamment en SQL ; la fermeture ne réécrit pas l'histoire. Les reprises exactes, anciens ports et contrôles de sources actuelles sont vérifiés localement.

## 8. Expérimental et suite

Le lot reste privé/local/TEST. Raccorder ensuite nouvelle émission client et préparation fiscale V5/PO011, puis DTO bornés sans faits privés, rapports/exports, HTTP/synchronisation et vrai consommateur pilote. Les flux Support/Automation/originaux, recettes sandbox/staging approuvées, cash basis, acomptes/récurrence/livraisons/remboursements et validation professionnelle restent ouverts. L'objectif ERP US complet demeure actif.
