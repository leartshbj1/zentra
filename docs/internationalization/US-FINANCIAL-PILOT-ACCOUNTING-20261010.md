# Journaux, contrepassations et périodes — pilote financier US privé TEST

## 1. Résumé des modifications

Le navigateur du pilote financier cumulatif V5 permet désormais de préparer, relire et confirmer une écriture manuelle équilibrée, de contrepasser exactement une écriture manuelle, d'ouvrir une nouvelle période et de verrouiller la plus ancienne période ouverte. Les dates de transaction et de comptabilisation restent distinctes. Les lignes et descriptions d'origine sont conservées, les montants sont exacts et les rapports lisent le même livre que ventes, achats, encaissements et avoirs.

Périmètre **privé local TEST**, USD et accrual. Ce raccord n'est ni un nouvel ERP indépendant, ni une clôture fiscale annuelle, ni une certification comptable. Le [plan préalable](US-FINANCIAL-PILOT-ACCOUNTING-PLAN-20261010.md) a été commité avant les changements majeurs.

Implémentation : `a0b0cae47f173ac1c7b7a4686f5f5e1e240b0438`. Preuve : [us-financial-pilot-accounting-20261010.json](../evidence/us-financial-pilot-accounting-20261010.json), SHA-256 `ed04bbb79a5111f2164cdf5ac706db6635ea35b23357f679094f8c059f08fc02`. Arbre de **3604 fichiers**, SHA-256 `14cd0fe85903cd2166d35c47173c358b2582a752a8529b09bbf1d676c066d5ae`. Les documents de livraison ultérieurs ne font pas partie de cet arbre testé.

## 2. Fichiers créés

**19 sources** :

- `app/api/international/workspaces/[organizationId]/financial-pilot/accounting/context/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/accounting/operations/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/journals/[journalRevision]/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/periods/[periodId]/route.ts`
- `components/account/us-financial-pilot-accounting.css`
- `components/account/us-financial-pilot-accounting.tsx`
- `lib/international/browser-us-financial-pilot-accounting-copy.ts`
- `lib/international/browser-us-financial-pilot-accounting-input.test.ts`
- `lib/international/browser-us-financial-pilot-accounting-input.ts`
- `lib/international/browser-us-financial-pilot-accounting.test.ts`
- `lib/international/us-financial-pilot-accounting-bindings.test.ts`
- `lib/international/us-financial-pilot-accounting-bindings.ts`
- `lib/international/us-financial-pilot-accounting-projection.test.ts`
- `lib/international/us-financial-pilot-accounting-projection.ts`
- `lib/international/us-financial-pilot-accounting-server.test.ts`
- `lib/international/us-financial-pilot-accounting-server.ts`
- `lib/international/us-financial-pilot-accounting.postgres.test.ts`
- `lib/international/us-financial-pilot-accounting.test.ts`
- `lib/international/us-financial-pilot-accounting.ts`

Documents ajoutés séparément : ce rapport, [notes réglementaires](US-FINANCIAL-PILOT-ACCOUNTING-REGULATORY-20261010.md) et preuve JSON. Recettes, sorties brutes, scripts et captures locales ignorées sous `.qa/` et `.impeccable/review/` sont référencés avec leurs empreintes dans la preuve.

## 3. Fichiers modifiés

- `components/account/us-financial-pilot.tsx`
- `lib/international/browser-us-financial-pilot-session.ts`

Le premier raccorde les nouveaux contrôles au pilote existant ; la session commune ajoute lecture, intentions, verrou partagé et reprise exacte. Actualisation documentaire séparée : `docs/internationalization/STATUS-20261009.md` et ajout à `.impeccable/surfaces/financial-pilot.md`, historique conservé.

Aucun fichier métier suisse, abonnement/Price ID Stripe, package, dépendance, région, déploiement ou binaire natif n'est modifié. `PRODUCT.md`, `DESIGN.md` et `.impeccable/design.json` restent identiques.

## 4. Migrations proposées et retour arrière

**Aucune nouvelle migration SQL et aucune migration hébergée appliquée.** Les 33 migrations existantes ont été exécutées dans la recette PostgreSQL locale. Les quatre commandes existent déjà dans le domaine et l'append cumulatif V5 ; les routes privées les réutilisent sans deuxième livre ni ouverture de l'ancien port ERP4 pour un tenant promu.

L'admission conserve les cookies et l'origine admis, l'utilisateur attendu, Auth en lecture seule, le membership et les droits Gestion D1 effectifs, les rôles owner/admin/accountant, US/USD/accrual, les flags fermés par défaut, l'environnement exact TEST et les grant/opt-in PostgreSQL versionnés vivants. Actor, policy, clés métier et source de contrepassation sont résolus côté serveur. Les credentials natifs et Authorization sont refusés. L'autorité est relue après les attentes et lors des erreurs ; le head est contrôlé avant succès. Après exception, le contrat impose l'admission fraîche avant l'erreur publique bornée, sans promettre un contrôle de head supplémentaire impossible après un échec de lecture.

Retour arrière : fermer l'admission/les flags et conserver les événements, reçus, périodes, marqueurs V5 et lecteur compatible. Aucun reset, suppression, migration descendante ou retour ERP4 figé n'est exécuté. Les données et abonnements hébergés actuels restent intacts.

## 5. Tests exécutés et résultats

| Vérification sur sources figées | Résultat réel |
| --- | --- |
| Régression finale | **6 334 / 6 334**, 195 fichiers, zéro échec/pending/todo ; les 188 fichiers précédents sont tous conservés. |
| Contrat et projection ciblés | **71/71** : contrat 61, projection 10. |
| Backend ciblé | **71/71** : mémoire 31, bindings 26, PostgreSQL 14. |
| Transport, saisie et session navigateur ciblés | **256/256**, sept fichiers, dont 56 nouveaux tests comptables. |
| TypeScript global | `tsc --noEmit --incremental false`, sortie 0. |
| Lint typé final | Les 20 fichiers TS/TSX de l'implémentation, `--type-aware --deny-warnings`, sortie 0. |
| Vérification de marque et build production | Sorties 0 ; aucune affirmation de build sans avertissement hérité. |
| Revues indépendantes contrat et backend | Acceptation au périmètre local TEST, inventaires et preuves vérifiés. |
| Détecteur UI | Une seule exécution, sortie 0 ; zéro résultat principal, une remarque consultative de taille de label à 13px, jugée non bloquante. |
| Recette navigateur et revue finale | 15 assertions de comportement vraies, 29 PNG validés, verdict **ship** limité aux nouveaux contrôles privés TEST. |
| Enregistrement final | Recorder strict exécuté après commit de code propre ; inventaire, arbre, sources et preuves concordants. |

Les suites ciblées recoupent la régression : **ne pas additionner leurs totaux**. Les commandes exactes, sorties brutes et hashes sont liés dans la preuve JSON. Les vérifications antérieures réellement échouées restent conservées : helper de test typé, fixture de flag et unions de test, puis refs/effect/role/types UI corrigés avant les passes finales. Aucun échec initial n'est présenté comme un succès. Le contrôle de whitespace sur l'index signale uniquement une ligne vide supplémentaire en fin du nouveau test PostgreSQL (sortie 2), jugée sans effet exécutable ; les octets validés sont conservés et cette remarque n'est pas présentée comme une sortie 0.

La recette PostgreSQL crée un historique mixte réel : facture V5, avoir, encaissement, achat/règlement, journal manuel, contrepassation, clôture, ouverture suivante et achat/règlement dans la nouvelle période. Elle compare les valeurs attendues de balance de vérification, bilan, résultat, grand livre et trésorerie, ainsi que leurs cinq exports CSV. Les rejets SQL reconstruisent les effets indépendamment, y compris payload privé cohérent mais falsifié et acteur invalide, avec contrôle positif valide ; les snapshots des huit tables privées restent inchangés sur refus. Les limites de périodes, pages au-delà de 25, compte interdit, déséquilibre, période fermée, double contrepassation, rôle/tenant/utilisateur/grant/opt-in, révision/CAS et reprises historiques sont testés. Une nouvelle instance PGlite rouvre réellement le même répertoire NodeFS après fermeture propre et reprend exactement les quatre reçus comptables sans nouvelle mutation.

Le test global PostgreSQL écrit aussi son propre manifeste. Il avait remplacé l'alias de la recette ciblée ; les deux sorties réelles ont été conservées, l'alias ciblé restauré depuis la recette originale retenue, et tous les hashes du manifeste backend recontrôlés. Cette réparation d'archivage ne modifie ni les sources ni les résultats des tests.

La recette navigateur distincte utilise les vrais handlers HTTP avec kernel mémoire V5 et Auth/D1 synthétiques. Deux clients locaux montrent automatiquement le journal puis sa contrepassation, sans navigation ou synchronisation manuelle du second client. Une réponse perdue après append est reprise avec **les mêmes UUID, corps et révision attendue** : un seul journal owner et un journal externe sont ajoutés. Une modification externe invalide la confirmation mais conserve montants, référence et dates du brouillon. La lecture des 28 lignes d'une source paginée conditionne la confirmation de sa contrepassation ; aucune contrepassation de cette source n'est soumise pendant cette inspection. Les 28 périodes existantes permettent de cibler la plus ancienne hors première page et d'ouvrir la 29e ; ces mutations ne changent aucun compteur de facture, achat, paiement ou règlement. La perte d'accès efface les données financières visibles. L'émission nouvelle V5 est prouvée par la recette PostgreSQL ; la facture du harness navigateur venait de l'ERP4 avant promotion, sans confusion entre les deux preuves.

Les 29 captures couvrent FR/DE/IT/EN, ordinateur clair 1440px et mobile sombre 390px, 320px allemand, 1280px et états de revue, reprise, brouillon périmé, pagination, périodes et refus. Deux inspections groupées au maximum ont été réalisées. Huit captures initiales visaient le mauvais onglet/viewport : elles sont conservées séparément comme invalides et remplacées par des captures dont les métriques DOM correspondent. Le PNG pleine page exclut parfois la gouttière de défilement de 15px ; sa largeur correspond à la largeur du contenu, sans débordement des contrôles. Tous les PNG ont été décodés intégralement, comparés aux JPEG source par pixels RGB, hashes et dimensions, puis ouverts par la revue indépendante. Le footer anglais de recette n'appartient pas au produit. Une saisie de date native de test a été corrigée avant confirmation pour correspondre à la date affichée, sans modification UI/source.

## 6. Risques identifiés

PGlite s'exécute de façon sérialisée dans un processus. Les sessions, Auth/D1 et observations fiscales sont synthétiques. Ces recettes ne démontrent ni multiconnexion PostgreSQL, charge, hébergement, crash recovery, Realtime hébergé, vrais appareils/comptes natifs ni SLA. La fermeture/réouverture est propre uniquement. Les fences Auth/D1/PostgreSQL ne forment pas une transaction distribuée ; une erreur après append est possible et impose une reprise exacte.

La reprise inconnue reste **en RAM** ; fermer ou recharger le navigateur n'est pas une reprise durable intersession. Le plan de comptes US actuel reste fixe et les écritures manuelles excluent AR/AP, taxes et acomptes : ces sous-registres ne doivent pas être corrigés par contournement manuel. Les sources sont des références déclarées, sans archivage automatique d'un original. Le verrouillage technique de période ne solde pas le résultat annuel et ne choisit pas l'année fiscale. Cash basis, déductibilité, immobilisations détaillées et fiscalité juridictionnelle restent à valider. Voir les [notes réglementaires officielles](US-FINANCIAL-PILOT-ACCOUNTING-REGULATORY-20261010.md).

La revue UI couvre les nouveaux contrôles dans la recette bornée, pas toute l'application. Aucun essai indépendant de lecteur d'écran, appareil tactile natif ou audit de contraste exhaustif n'est revendiqué. Aucune certification US GAAP, SOC 2 ou conformité fiscale globale n'est annoncée.

## 7. Fonctionnalités terminées

Journal manuel exact et équilibré, contexte de comptes/périodes courant, détail paginé, contrepassation exacte à original conservé, ouverture chronologique et verrouillage de la plus ancienne période sont raccordés au même pilote V5. Revue humaine, admission fraîche, révisions/CAS, reçu lié à la demande, reprise historique prioritaire, verrou de mutation partagé, conservation des brouillons, effacement sur refus et actualisation silencieuse entre clients locaux sont vérifiés.

Contrat, PostgreSQL/mémoire, transport/session, quatre langues, thèmes, responsive, régression, qualité, revue indépendante et enregistrement des preuves sont terminés **au périmètre local privé TEST**.

## 8. Fonctionnalités expérimentales et prochaine phase

L'ERP US complet reste en développement. Provisioning/admission hébergés, prestataire fiscal réel, cash basis, clôture annuelle complète, banque V5, originaux/Support/Automation, devises étrangères, commandes/projets avancés, multiconnexion/charge/crash et distribution native restent ouverts. Les abonnements suisses, prix US et paiements réels ne sont pas modifiés implicitement.

Prochaine verticale à cadrer : **rapprochement de relevés bancaires manuels sur le livre cumulatif V5**. Le workflow ERP4 existe mais ses quatre tables sont gelées après promotion ; le réutiliser directement servirait un ancien état. Un plan préalable doit définir une persistance additive privée reliée au head V5, la provenance des relevés, l'unicité des rapprochements, les reprises, la revue humaine, les autorisations et les tests SQL avant toute implémentation. Aucun connecteur bancaire réel, transfert, ancien port dégelé ou second ledger n'est autorisé par cette proposition. L'objectif international demeure actif.
