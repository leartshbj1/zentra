# Rapprochement bancaire V5 — persistance privée US TEST, étape 1

## 1. Résumé des modifications

Le pilote financier cumulatif V5 possède un registre privé de rapprochement des relevés manuels. L'import, l'approbation de groupes de lignes/mouvements, la finalisation et l'annulation d'un relevé inutilisé conservent un historique distinct du livre comptable. Ces opérations de revue ne créent aucun journal, ne modifient aucun solde et n'envoient aucun fonds.

Périmètre **privé local TEST**, US/USD/accrual. Cette étape livre le domaine, les projections publiques bornées, les factories HTTP et l'adaptateur PostgreSQL. **Aucune route n'est montée et aucune interface bancaire n'est ajoutée à cette étape.** Le [plan préalable](US-FINANCIAL-PILOT-BANK-PLAN-20261010.md) a été commité avant l'implémentation ; ses précisions portent le nom de migration exact, les budgets et le protocole.

Implémentation : `1112da34d6a30a12a67924f414da0e345b905acf`. Preuve : [us-financial-pilot-bank-20261010.json](../evidence/us-financial-pilot-bank-20261010.json), SHA-256 `77ffae11c5560711ee69ae751afdb162916952442b3df07c716d59789151c42c`. Arbre de **3620 fichiers**, SHA-256 `03a138b0ad1e8767e1f5a22778463fef7832a5983a4b85f7d44610764229152a`. Les documents de livraison ajoutés ensuite sont hors de cet arbre testé.

## 2. Fichiers créés

**Douze sources nouvelles**, sans modification des sources antérieures :

- `lib/international/us-financial-pilot-bank-bindings.test.ts`
- `lib/international/us-financial-pilot-bank-bindings.ts`
- `lib/international/us-financial-pilot-bank-projection.test.ts`
- `lib/international/us-financial-pilot-bank-projection.ts`
- `lib/international/us-financial-pilot-bank-server.test.ts`
- `lib/international/us-financial-pilot-bank-server.ts`
- `lib/international/us-financial-pilot-bank-store.test.ts`
- `lib/international/us-financial-pilot-bank-store.ts`
- `lib/international/us-financial-pilot-bank.postgres.test.ts`
- `lib/international/us-financial-pilot-bank.test.ts`
- `lib/international/us-financial-pilot-bank.ts`
- `supabase/migrations/20261010155848_international_us_financial_pilot_bank_test_v1.sql`

Documents de livraison ajoutés séparément : ce rapport et la preuve JSON. Les recettes et sorties brutes ignorées sous `.qa/us-pilot-bank/` sont référencées avec leurs empreintes dans la preuve.

## 3. Fichiers modifiés

**Aucun fichier d'implémentation préexistant.** Actualisation documentaire séparée : ajout en tête de `docs/internationalization/STATUS-20261009.md`, historique conservé. Aucun fichier métier CH, package/dépendance, abonnement ou Price ID Stripe, région, déploiement, binaire natif, `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` ou surface UI n'est modifié.

## 4. Migration proposée et retour arrière

Une migration additive locale : `supabase/migrations/20261010155848_international_us_financial_pilot_bank_test_v1.sql`, réellement générée avec la CLI Supabase 2.120.0. Les 33 migrations antérieures et cette 34e migration sont éprouvées dans PGlite local. **Aucune migration hébergée ou de production n'a été exécutée.**

Quatre tables privées stockent records de rapprochement, reçus, audit et claims uniques de mouvements. Les RLS sont activées ; les droits clients PUBLIC/anon/authenticated sont révoqués, sans nouvelle politique client. Les fonctions invoker ont un search_path fermé et réutilisent l'admission versionnée, les verrous et le curseur financier existants. Les guards contrôlent les transitions et la corrélation atomique des tables ; l'historique ne peut pas être mis à jour, supprimé ou tronqué. Les rapprochements ERP4 restent gelés et réservés dans l'union des origines, sans dégel ni fallback.

La gate serveur supplémentaire `ZENTRA_US_FINANCIAL_BANK_TEST_INSTALLED` exige la valeur exacte `true`, en plus des flags financiers, de l'environnement exact TEST, de l'Auth/D1 effectif, de US/USD/accrual et des grant/opt-in/policy vivants. Gate absente : fermé. Gate présente mais RPC absent/invalide : erreur bornée, pas de fausse banque vide. Le client ne choisit ni acteur, policy, source privée, ledger ID ou autorité.

Retour arrière : fermer la gate et l'admission ; conserver migration, données, preuves et lecteur compatible. Aucun reset, suppression, migration descendante ou retour au livre ERP4 figé. La migration reste proposée pour staging uniquement jusqu'à validation explicite d'une installation hébergée.

## 5. Tests exécutés et résultats

| Vérification sur sources figées | Résultat réel |
| --- | --- |
| Régression finale | **6498 / 6498**, 201 fichiers ; zéro échec/pending/todo ; les 195 fichiers précédents sont conservés. |
| Domaine et projection ciblés | **55/55**, deux fichiers. |
| HTTP et bindings ciblés | **67/67**, deux fichiers. |
| Store ciblé | **30/30**, un fichier. |
| PostgreSQL ciblé | **12/12**, un fichier ; 34 migrations, fermeture/réouverture NodeFS propre. |
| TypeScript global | Sortie 0, `tsc --noEmit --incremental false`. |
| Lint typé | Les onze fichiers TypeScript ajoutés, `--type-aware --deny-warnings`, sortie 0. |
| Marque et build production | Sorties 0 ; aucune promesse d'absence d'avertissements hérités. |
| Revue indépendante | Acceptation limitée aux sources et preuves backend local TEST. |
| Contrôle d'index | Whitespace sortie 0 ; douze ajouts exactement. |

Les suites ciblées recoupent la régression : **ne pas additionner leurs totaux**. Les tentatives échouées restent archivées ; les résultats finaux sont liés aux octets et à l'inventaire figés. Le recorder strict est exécuté après commit de code propre. Aucun test UI, détecteur ou capture n'est requis ou revendiqué pour cette étape backend sans route montée.

Le contrôle de whitespace a relevé deux fins de fichier superflues. Seules ces séquences finales ont été normalisées ; les préfixes binaires et les dix autres sources sont inchangés. Les originaux et les résultats précédents restent archivés. Store, PostgreSQL, qualité et régression ont ensuite été exécutés à nouveau sur les octets définitifs. Les ciblages domaine/projection et HTTP/bindings avaient testé leurs mêmes sources inchangées ; leurs tests sont aussi inclus dans la régression finale.

La recette PostgreSQL utilise les vrais handlers financiers sur une entreprise synthétique promue : facture, avoir, encaissement, achat/règlement, journal et contrepassation, clôture et ouverture de période. Elle importe le relevé puis approuve un groupe de mouvements et le finalise. Les rapports et les cinq snapshots financiers destinés au CSV restent identiques après la revue bancaire. Cette recette ne rend pas les octets CSV ; les tests du renderer dans la régression vérifient ceux-ci séparément. Une écriture ultérieure distingue les écarts courants de la completion historique ; les reprises des cinq demandes conservées (import, match, completion, autre import puis annulation) ne créent pas de nouvel effet. Une nouvelle instance rouvre le même répertoire NodeFS et retrouve livre, registre, preuves, rapports, snapshots CSV et reçus exacts.

Les rejets SQL ciblent une fabrication cohérente record/reçu/audit/claims, le préfixe F/SHA/L, une entrée créée après la source, l'horloge, des champs inconnus, des attentes F/B/R périmées, des séquences ou claims altérés, et les budgets combinés Unicode. Les anciennes origines completed/pending/voided restent gelées avec collisions d'identité/contenu, overlap, claims et blocker. Un autre acteur autorisé peut lire l'historique de l'ancien approbateur révoqué. Les réponses perdues/409 tardifs après commit sont reprises sans deuxième effet. Les garde-fous HTTP couvrent les retraits d'autorité pendant succès et erreurs d'attentes, la gate, le protocole navigateur, les méthodes/query/origines et les erreurs hostiles bornées.

Les sorties des premières passes restent conservées : imports, assertions et types de fixtures corrigés, conventions de reçu plat et signe d'écart alignées, puis durcissement de la capture des sorties du port avant les attentes d'admission. La suite antérieure de comptabilité réécrit un alias de recette ; le runner archive la nouvelle recette séparément et restaure exactement les octets de preuve antérieurs, sans modification de source ni de résultat.

Le reçu est recherché avant les contrôles d'éligibilité et de révision courants. La reprise exacte conserve UUID, requête canonique, utilisateur, attentes F/B/R et horodatage de preuve ; elle n'invente pas une nouvelle opération. Les preuves reconstruisent le préfixe source du livre, son SHA et son vrai ledger. Les révisions financières F, du ledger L, du registre bancaire B et du relevé R sont distinctes. Les DTO ne révèlent ni hash privé, ni policy, ni idempotency key.

## 6. Risques identifiés

PGlite est sérialisé dans un processus avec Auth/D1 et observations fiscales synthétiques. Fermeture/réouverture **propre** d'une nouvelle instance NodeFS ne démontre pas crash recovery, multiconnexion PostgreSQL, charge, hébergement, Realtime, appareils natifs ou SLA. Les fences Auth/D1/PostgreSQL ne constituent pas une transaction distribuée ; une réponse peut être incertaine après commit et exige une reprise identique.

Capacité volontairement limitée : 100 relevés toutes origines/états inclus, 1 000 lignes par relevé et 1 000 opérations au total par entreprise, sous budgets complets de texte/nœuds/sérialisation. Les preuves et wrappers consomment aussi le budget ; la limite effective peut donc être atteinte avant ces plafonds. La pagination ne crée pas de capacité supplémentaire.

La provenance manuelle ne prouve pas l'authenticité d'un relevé bancaire. Le domaine exige un rapprochement exact ; frais non comptabilisés, chèques/dépôts en transit et échéanciers nécessitent un traitement métier distinct. Aucun flux bancaire réel, paiement, conformité fiscale, certification US GAAP ou résidence/certification de données n'est annoncé. Les [sources officielles et hypothèses](US-FINANCIAL-PILOT-BANK-PLAN-20261010.md) restent applicables.

## 7. Fonctionnalités terminées

Contrat fermé, montants minor units exacts, import manuel, match groupé, completion et annulation inutilisée ; source financière historique prouvée et reprise prioritaire ; registre durable séparé à séquences B/R et claims uniques ; projections paginées tenant/F/B/origine avec vrai ledger L ; protocole HTTP et bindings fermés par défaut ; tests, qualité et revue indépendante terminés **au périmètre local privé TEST de l'étape 1**.

## 8. Fonctionnalités expérimentales et prochaine phase

Le rapprochement V5 reste privé local TEST. Routes, import CSV navigateur, revue humaine à l'écran, polling F/B, verrou de mutation partagé, demande incertaine conservée en RAM et export complet après rendu restent à raccorder dans l'étape 2 prévue. Aucun bouton bancaire utilisable en production n'est livré par ces seules factories.

Le pilote US global reste en développement : provisioning/admission hébergés, prestataire fiscal réel, cash basis, clôture annuelle complète, originaux/Support/Automation, devises étrangères, commandes/projets avancés, charge et distribution native restent ouverts. Les clients, données, abonnements et règles suisses restent intacts. L'objectif international demeure actif.
