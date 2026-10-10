# Avoirs clients US — noyau préparatoire, 10 octobre 2026

Base : `04f8325f7b89c18da9dc267676212dcbc83b91dc`, branche locale `codex/international-runtime`. Cette livraison est une étape interne de développement de la phase C/D. **Elle ne rend pas encore disponible l'émission d'avoirs financiers US.** Aucune fonctionnalité de production, base hébergée ou distribution native n'est activée.

## 1. Résumé des modifications

Une préparation interne peut désormais partir d'une facture US réellement émise et validée par le moteur ERP. Elle sélectionne des quantités dans les lignes originales et calcule des montants candidats nets et fiscaux. Elle conserve l'empreinte de la facture immuable, lie séparément les encaissements et la révision du livre, et relit l'état et les droits avant de restituer le résultat. La référence de preuve par ligne est remplacée par une empreinte SHA-256 : les identifiants privés du calculateur ne sont pas recopiés dans la préparation.

Les calculs utilisent des entiers exacts, les unités et l'échelle d'origine, le net après remise et la taxe historique. L'arrondi cumulatif garantit que des sélections partielles puis la totalité reprennent exactement les derniers centimes. Les historiques mathématiques sont reconstruits ligne par ligne avant utilisation ; leurs totaux, quantités, ordre, identités et empreintes ne sont pas crus sur parole. Ils préparent les invariants de la future capacité et ne représentent pas des avoirs déjà enregistrés dans l'ERP actuel.

Le service admet owner/admin/accountant avec Gestion dans leur entreprise US/USD, sans nouveau droit pour un membre commercial. Il ne possède aucun port d'écriture, de reçu ERP, de calcul fiscal, de banque ou d'e-mail. Son résultat conserve `canIssue: false`, `financialState: unchanged` et `taxStatus: historical_candidate_only`. Les aperçus de créance/excédent ne deviennent jamais des soldes applicatifs ou des crédits remboursables.

## 2. Fichiers créés

| Groupe | Fichiers |
| --- | --- |
| Contrats internes | `lib/international/us-customer-credit-types.ts` |
| Calcul et historique | `lib/international/us-customer-credit-allocation.ts` |
| Préparation et fraîcheur | `lib/international/us-customer-credit-preparation.ts` |
| Tests | `lib/international/us-customer-credit-allocation.test.ts`, `lib/international/us-customer-credit-preparation.test.ts` |
| Plan et recherches | `docs/internationalization/US-CUSTOMER-CREDIT-PLAN-20261010.md`, `US-CUSTOMER-CREDIT-RESEARCH-20261010.md`, `US-CUSTOMER-CREDIT-CAPABILITY-20261010.md` |
| Livraison et preuves | Ce document et `docs/evidence/us-customer-credit-20261010.json` |

Les rapports et sélections bruts de recette sont dans `.qa/us-customer-credit/`, ignoré par Git ; le manifeste conserve leurs empreintes et les résultats normalisés.

## 3. Fichiers modifiés

Seul le document de suivi `docs/internationalization/STATUS-20261009.md` est actualisé. Aucun fichier applicatif existant, composant, API, format natif, règle CH ou migration historique n'est modifié. Le noyau est importé uniquement par ses tests ; il ne s'installe pas silencieusement dans le parcours de facturation.

## 4. Migrations proposées

Aucune migration : cette étape ne persiste aucune préparation et ne change aucun schéma ERP. Aucun prix, compte marchand, droit, flag hébergé ou paramètre fiscal n'est créé. Le retour arrière consiste à retirer les nouveaux modules internes non exposés ; aucun historique financier conservé ne dépend d'eux.

La future capacité financière nécessitera une promotion explicite et additive, un plan de comptes versionné compatible, des sources d'avoirs/allocations/remboursements, des gardes SQL et un replay complet. Le document de capacité inventorie les dépendances plutôt que de prétendre qu'un simple registre annexe suffit.

## 5. Tests exécutés et résultats

La passe ciblée du noyau et du service a passé **175 tests dans deux fichiers**, sans échec ni test ignoré. Les scénarios de service construisent des livres par les vraies commandes ERP, appliquent les vrais deltas et exécutent la reconstruction des sources et du ledger. La persistance, Auth et les calculs fiscaux sont fictifs ; aucun appel de prestataire réel n'a lieu.

La régression finale élargie passe **4 430 tests dans 135 fichiers**, sans échec, skip ou todo. Elle conserve les 133 fichiers du jalon commandes (4 255 tests) et ajoute les deux fichiers du noyau (175 tests, déjà inclus dans le total). Les suites PostgreSQL locales précédentes passent également : 19 tests de commandes et 14 tests de recherche de document fournisseur, avec le module PGlite explicitement configuré. Cela ne constitue pas une recette Supabase hébergée ni une validation fiscale réelle.

TypeScript global, lint typé avec refus des avertissements sur cinq fichiers, vérification des assets de marque et build production ont réussi pour le noyau avec la protection des références privées. Le build conserve les notices existantes Vinext de convention middleware, temps de plugins, taille de chunk et classification de routes. La première passe ciblée a révélé une fixture CH contenant une propriété EIN `undefined`, refusée correctement par la capture JSON : la fixture a été corrigée en omettant le champ. Une première régression élargie a été arrêtée volontairement pour remplacer les références privées par leurs empreintes ; seul le rapport final complet est compté.

Couverture du nouveau lot : impayé/partiellement payé/payé × sélection partielle/totale × cash/accrual ; ligne remisée, quantité fractionnaire, lignes mixtes taxables/exemptes ; suites cumulatives, centime final et gros entiers ; données falsifiées/getters/prototypes ; droits et autre entreprise ; changement de compte à chacune des cinq frontières d'autorité ; changement de configuration/capacité/horloge ; nouvelle révision après encaissement ; contenu changé à révision identique ; périodes fermées et correction dans une période ultérieure ouverte ; absence d'écriture, de nouveau reçu et d'appel fiscal.

Commandes :

```text
node node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1 <selection-final.json> --reporter=json --outputFile=.qa/us-customer-credit/regression-final.json
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/oxlint/bin/oxlint --type-aware --deny-warnings <cinq fichiers TypeScript créés>
node scripts/check-brand-assets.mjs
node node_modules/vinext/dist/cli.js build
```

La sélection et la commande PostgreSQL utilisent `PGLITE_MODULE_DIR` vers le runtime local existant ; sans ce paramètre, certains tests historiques peuvent être ignorés. Aucun nouveau test SQL n'est créé puisqu'aucune migration ne fait partie de ce lot. Aucun nouveau contrôle navigateur n'est annoncé : il n'y a pas d'écran ou de route ajoutés. Les contrôles visuels du jalon commandes précédent restent leurs propres preuves, pas de nouveaux essais du noyau d'avoirs.

## 6. Risques identifiés

Une allocation fiscale proportionnelle historique n'établit pas le montant légal à ajuster. Les conditions varient selon juridiction et opération. Un calcul Stripe TEST ne constitue pas une transaction fiscale réversible ; aucune transaction d'origine ou reversal n'est fabriqué à partir de son identifiant. Les politiques cash, de crédit client reporté, de restitution et de période doivent encore être validées. Le produit n'est pas certifié US GAAP.

La préparation est éphémère et ne réserve aucun plafond financier. Une action concurrente après la dernière lecture peut rendre son aperçu périmé ; seul un futur commit atomique/CAS pourra autoriser une émission. La double lecture et les empreintes protègent la cohérence du résultat observé, sans revendiquer de verrou distribué ou d'approbation financière durable.

Les données source et historiques mathématiques sont soumises au budget défensif existant `snapshotPrivateJson` (50 000 nœuds, 2 097 152 caractères), en plus des plafonds de 1 000 lignes et 1 000 lots. Cela ne promet pas 1 000 lots de 1 000 lignes simultanément. Le service actuel relit le livre deux fois lors d'une préparation explicite ; ce n'est pas une solution de polling haute charge et aucun objectif de latence multi-tenant n'est annoncé pour ce noyau.

## 7. Fonctionnalités terminées

Contrats de préparation stricts et détachés ; allocation cumulative exacte ; vérification d'historiques mathématiques ; reliquat par ligne ; source réellement émise et reconstruite ; autorité fraîche et droits financiers ; liaison séparée facture/encaissements/livre ; dates et périodes distinctes ; refus d'un résultat périmé ; protection des identifiants fiscaux privés ; résultat explicitement non émis et sans effet financier. Le code CH et les anciens formats restent inchangés.

## 8. Fonctionnalités expérimentales et restantes

Tout le noyau de préparation demeure interne et expérimental. Restent l'émission d'avoirs numérotés, leur application aux créances, les crédits clients disponibles, les remboursements, la politique cash/accrual validée, les ajustements fiscaux, les opérations atomiques SQL, les journaux/replays/rapports/banques compatibles, les PDF et écrans, les capacités natives et les essais sandbox/staging approuvés. Ces éléments doivent être livrés ensemble pour le premier cas financier effectivement activé.

Les autres verticales du cycle commercial — acomptes, récurrence, livraisons et paiements clients — restent également ouvertes. L'objectif d'ERP US complet n'est pas marqué terminé par cette étape. Aucune suppression, publication, modification de production, abonnement CHF, région ou donnée client n'a eu lieu.
