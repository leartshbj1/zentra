# Zentra US — préparation fiscale et émission dans le pilote financier V5

10 octobre 2026. Développement et recette locale terminés, revue indépendante « ship » dans ce périmètre. Pilote privé TEST uniquement. Plan préalable : [US-FINANCIAL-PILOT-INVOICING-PLAN-20261010.md](US-FINANCIAL-PILOT-INVOICING-PLAN-20261010.md), commit `581900a`. Implémentation : `bf4ea9f45fc31b993d9e6b24658cb7f92fb3bd51`. Preuve : [us-financial-pilot-invoicing-20261010.json](../evidence/us-financial-pilot-invoicing-20261010.json).

## 1. Résumé des modifications

Le parcours accepté → préparation fiscale → revue exacte → confirmation d'émission est raccordé au même livre V5. La préparation conserve l'observation privée et sa référence de revue, sans numéro de facture, facture ni journal. Seule la confirmation distincte exécute le noyau financier existant, avec numéro serveur, écriture équilibrée, snapshots, CAS et reçu historique. Aucun second livre, moteur fiscal ou registre d'opérations n'est créé.

Le DTO public fermé lie le requestId, les révisions du livre/devis, les dates de facture/comptabilité/échéance, la période ouverte, la destination choisie, l'instant fiscal résolu et les classifications ordonnées. L'émission ajoute la référence de revue. Les IDs `pilot-invoice:<requestId>` et `pilot:invoice:<requestId>` sont dérivés côté serveur ; le navigateur ne fournit ni total, rôle, policy, compte marchand, preuve privée ou numéro. Le hash financier historique ne couvrant pas les choix fiscaux du navigateur, ceux-ci sont comparés explicitement à chaque lecture/réservation/enregistrement et après le noyau.

Les quatre langues FR/DE/IT/EN, les thèmes et le mobile utilisent le même composant. Le catalogue fiscal canonique passe par une route du pilote et accepte la pagination. Les dates civiles, date comptable et instant dans le fuseau de l'entreprise restent distincts ; les instants ambigus de changement d'heure demandent un choix explicite. Les brouillons restent présents pendant le polling et une révision modifiée impose la lecture puis l'acceptation explicite de la source courante. Paiements, commerce et émission partagent un seul verrou de mutation.

Un résultat HTTP inconnu conserve en mémoire la requête et la revue exactes. Un HTTP 409 peut survenir après le commit : les erreurs tardives d'autorité, configuration, marchand ou préparation ne sont donc pas interprétées comme une absence certaine de facture. La reprise exacte retrouve le reçu sans nouvelle facture/calcul, y compris avec marchand ou catalogue courant indisponible. Elle exige encore l'autorité, le grant/opt-in et la configuration actuels. Le brouillon en attente n'est pas un journal durable intersession : il ne faut pas fermer/recharger une demande incertaine en supposant sa reprise automatique.

## 2. Fichiers créés

17 nouveaux fichiers de code, test et migration :

- `app/api/international/workspaces/[organizationId]/financial-pilot/invoices/issue/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/invoices/prepare/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/tax-codes/route.ts`
- `components/account/us-financial-pilot-invoice.css`
- `components/account/us-financial-pilot-invoice.tsx`
- `lib/international/browser-us-financial-pilot-invoice-copy.ts`
- `lib/international/browser-us-financial-pilot-invoice.test.ts`
- `lib/international/us-financial-pilot-invoice-bindings.test.ts`
- `lib/international/us-financial-pilot-invoice-bindings.ts`
- `lib/international/us-financial-pilot-invoice-server.test.ts`
- `lib/international/us-financial-pilot-invoice-server.ts`
- `lib/international/us-financial-pilot-invoice-store.postgres.test.ts`
- `lib/international/us-financial-pilot-invoice-store.test.ts`
- `lib/international/us-financial-pilot-invoice-store.ts`
- `lib/international/us-financial-pilot-invoice.test.ts`
- `lib/international/us-financial-pilot-invoice.ts`
- `supabase/migrations/20261010131903_international_us_financial_pilot_invoice_dto1.sql`

La preuve et les documents de livraison sont séparés du commit d'implémentation. Les recettes `.qa` et PNG `.impeccable/review/financial-invoicing/` sont des preuves locales ignorées, pas des modules de production.

## 3. Fichiers modifiés

- `components/account/us-financial-pilot-commercial.tsx`
- `components/account/us-financial-pilot.tsx`
- `lib/international/browser-us-financial-pilot-session.ts`

L'inventaire figé compte 20 fichiers, dont 18 TS/TSX, une feuille CSS et une migration SQL. Aucun module métier CH, abonnement Stripe, Price ID, dépendance, déploiement ou région n'est modifié. La capture de 3 558 fichiers porte le SHA-256 `891eb9873b6e0a5845c539da10532d6f4ab2354f2972c9b1fdb3e21e97b2014d`. Les documents ajoutés après validation ne sont pas inclus dans cet arbre testé.

## 4. Migration proposée et retour arrière

`supabase/migrations/20261010131903_international_us_financial_pilot_invoice_dto1.sql` ajoute cinq wrappers privés : contexte, lecture, preflight, réservation et enregistrement de la préparation. Chacun effectue l'admission du pilote et son opération V5 dans la même transaction. Ils restent VOLATILE, SECURITY INVOKER, avec search_path vide, EXECUTE réservé au service. Aucune nouvelle table, purge, réécriture d'historique, désactivation RLS ou capacité de provisioning public n'est introduite. Le contexte fiscal reste une responsabilité administrative DB-owner séparée.

La chaîne de 33 migrations a été exécutée localement. **Aucune migration hébergée n'a été appliquée.** Les flags sont fermés par défaut. L'accès exige le compte attendu, le scope du pilote, Auth/D1, abonnement Gestion effectif, rôle autorisé, espace US/USD/accrual, opt-in/grant TEST versionnés, contexte frais et marchand TEST dédié. Les clés des abonnements SaaS ne servent pas de repli. Les routes refusent les credentials natifs et Authorization et exigent same-origin/cookies/origine autorisée. Les erreurs publiques sont bornées et les diagnostics n'exposent pas les messages privés.

Retour arrière : fermer les flags et retirer le consommateur, conserver les opérations, reçus, événements et marqueurs V5. Ne pas rétrograder un espace promu vers sa baseline ERP4 figée. Une éventuelle suppression des wrappers doit être précédée d'un inventaire de leurs consommateurs ; aucun rollback destructif n'est exécuté.

## 5. Tests exécutés et résultats

| Contrôle local | Résultat réel |
| --- | --- |
| Régression finale de phase | **5 950/5 950**, 181 fichiers, dont les 175 précédents conservés ; échec/skip/todo : 0. |
| Contrat public | 33 tests dans le fichier, inclus dans la régression. |
| Serveur/bindings/store unitaires | 45/45 ; revue indépendante sur les mêmes sources figées. |
| PostgreSQL local | 8/8 nouveaux scénarios, 33 migrations ; NodeFS fermé/réouvert et reçu historique rejoué. Avec les trois suites unitaires : 53/53. |
| Transport navigateur de facturation | 45/45 ; les suites session et commerce existantes restent sélectionnées. |
| TypeScript global | Sortie 0, non incrémental. |
| Lint typé | 18 fichiers TS/TSX, deny-warnings, sortie 0. |
| Marque et build production | Sortie 0 chacun ; un build n'est pas un déploiement. |
| Inspection navigateur | 30 captures finales, quatre langues, deux thèmes, largeurs demandées 320/390/1 440 px ; aucun débordement du body ou des nouveaux contrôles mesurés. Deux groupes d'inspection au maximum. |
| Détecteur UI | Une seule exécution, résultat `[]`. |
| Finition indépendante | Avis **ship**, limité au raccord privé TEST ; 30 PNG ouverts et empreintes contrôlées, aucun correctif bloquant. |
| Enregistrement des preuves | Recorder strict, sources/rapports/captures et preuves ciblées liés au commit d'implémentation. |

Ces nombres se recoupent : les suites ciblées ne s'ajoutent pas au total 5 950. La sélection de phase n'est pas l'intégralité des tests de toutes les applications natives. Le rapport global, ses empreintes, commandes et sélection exacte figurent dans la preuve JSON.

Les tests couvrent DTO/getters/prototypes, capture immutable avant attentes, montants exacts, source/période/revue modifiée, catalogue ou marchand fermé, choix fiscaux altérés malgré hash financier identique, refus d'autorité/opt-in/grant, rotation de credential, reprise après vrai append suivi d'un HTTP 409 et historique après encaissement intermédiaire. La revue backend a fait corriger la capture trop tardive du résultat catalogue, la lecture d'un getter avant validation et la capture du contexte acteur avant attente. Les identités marchand sont aussi revérifiées dans les fences privées.

La recette navigateur utilise le vrai composant React, les handlers importés et le kernel mémoire V5, avec Auth/D1, données et observation fiscale fictifs. Elle vérifie préparation sans append, émission, perte volontaire de la réponse après commit puis reprise exacte, second onglet automatiquement mis à jour sans synchronisation manuelle, brouillon/revue courante, erreur fiscale puis reprise, détail de facture et effacement après retrait d'accès. Le montant fictif est $300.00 net, $24.75 de taxe synthétique, $324.75 total ; ce n'est pas un taux prescrit. Les deux clients sont locaux, pas une preuve de Realtime hébergé.

Les 30 PNG sont des conversions de captures navigateur JPEG, avec égalité RGB décodée vérifiée. Les largeurs de raster peuvent être inférieures de 15 px à la largeur demandée en présence de scrollbar. L'outil CUA fill d'un champ date changeait le DOM sans engager l'état React ; la saisie native ArrowUp a confirmé la date conservée lors de la lecture courante/reprise. Ce fill seul n'est pas compté comme saisie réussie. Un défaut du harness encodant un ID contenant `:` a été corrigé dans le harness ignoré ; le détail a ensuite été vérifié. Aucun correctif métier n'est attribué à ce défaut de recette.

## 6. Risques identifiés

PGlite PostgreSQL WASM est sérialisé. La fermeture/réouverture propre démontre la persistance/reprise testée, pas la concurrence multiconnexion, charge, crash, SLA ou admission Supabase hébergée. Les contrôles Auth/D1, environnement marchand et PostgreSQL ne forment pas une transaction distribuée ; une rotation/révocation après le dernier contrôle reste possible. Un échec postflight peut suivre un append réussi, d'où la reprise du même contenu plutôt qu'une nouvelle émission.

Le périmètre fiscal est volontairement fermé : USD/accrual, services taxables, prix hors taxe, quantités entières positives et destination US complète. Les biens, exonérations, quantités fractionnaires, taxes inclusives ou besoins de sourcing non couverts sont refusés. Aucune clé réelle ou requête Stripe Tax réelle n'a été utilisée. La sélection billing/shipping et une classification ne prouvent pas le nexus, la nécessité d'inscription, l'exonération ou la juridiction correcte.

Le libellé générique « Sales tax » ne satisfait pas à lui seul tous les cas documentaires nationaux : la FAQ officielle du Texas impose par exemple « Texas sales and use tax » pour certains vendeurs hors État titulaires du permis concerné. Ce point reste ouvert avant usage réel. Voir [notes réglementaires](US-FINANCIAL-PILOT-INVOICING-REGULATORY-20261010.md). Pas de certification US GAAP, SOC 2, conformité fiscale générale ou étude exhaustive des cinquante États.

La revue de finition note deux limites non bloquantes : « Rechnungssumme » se fragmente dans une colonne de ligne à 320 px allemand, et les selects natifs mobiles abrègent certains longs libellés. Les montants exacts, le total final et les actions restent lisibles. Le texte complet de l’instant et la classification figurent dans la revue. Les contrôles de lecteur d’écran, clavier/tactile natif et contraste instrumenté ne sont pas revendiqués. Aucun nouveau tour de polish n’a été ouvert.

## 7. Fonctionnalités terminées

Dans le pilote local privé TEST : devis accepté → préparation sans écriture → revue exacte → émission avec journal équilibré et reçu ; catalogue canonique ; refus explicites ; reprise exacte ; intégration quatre langues/thèmes/mobile ; verrou partagé et brouillons ; wrappers SQL privés/additifs et leur validation locale. Les quatre contrôles de qualité et la régression réussissent sur les sources figées, avec revues indépendante backend et UI. Aucun état « terminé en production » ne peut être déduit de cette liste.

## 8. Expérimental et prochaine phase

L'ERP US complet demeure en développement. L'admission hébergée/native, provisioning administratif, vrai prestataire fiscal, taxes par juridiction, obligations documentaires, cash basis, marchand client/paiements distincts du SaaS, charge/multiconnexion et validation professionnelle restent ouverts. Les rapports et PDF existants sont conservés, sans validation réglementaire universelle de chaque document issu ici.

Prochaine verticale proposée : fournisseurs et factures fournisseurs avec approbation humaine, règlements partiels et suivi dans ce même pilote V5, en réutilisant les commandes achats déjà validées. Le plan doit vérifier d'abord les commandes/projections réelles et les limites de traitement fiscal. Aucun abonnement, prix US ou accès public ne sera ouvert implicitement. L'objectif international reste actif ; cette livraison est une tranche vérifiée, pas son achèvement.
