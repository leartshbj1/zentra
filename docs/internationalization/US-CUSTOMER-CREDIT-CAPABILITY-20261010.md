# Avoirs clients US — inventaire de la future capacité financière

Revue du 10 octobre 2026, base `04f8325f7b89c18da9dc267676212dcbc83b91dc`. Périmètre : code et migrations locaux de ce repository. Aucune base hébergée, donnée client, migration historique ou application suisse n'a été modifiée pour cette revue. Aucun test d'exécution n'est revendiqué par ce document.

## Décision pour l'étape actuelle

Suivre [le plan de préparation](US-CUSTOMER-CREDIT-PLAN-20261010.md) : calcul interne et validation des sources uniquement. **La préparation n'est pas un avoir émis et ne modifie aucun solde.** Elle ne dispose d'aucune route, interface publique, persistance, numérotation financière, écriture comptable, transaction fiscale ou remboursement. Les allocations mathématiques antérieures utilisées par le noyau ne sont pas des avoirs enregistrés dans les schémas ERP actuels.

Un avoir ayant un effet financier exige une évolution cohérente du contrat ERP. Un registre financier indépendant, une facture négative, un paiement négatif ou une contrepassation manuelle de créance ne constituent pas une migration sûre. Ne pas annoncer une capacité5 tant que les dépendances ci-dessous ne sont pas adaptées et validées ensemble.

## Invariants constatés dans l'existant

| Domaine | Preuve dans les sources | Conséquence pour un avoir financier |
| --- | --- | --- |
| Protocole | `lib/international/erp-schema-capability.ts:6`, `runtime-types.ts:10`, `runtime-types.ts:30` | Seuls les schémas1–4 existent. Aucun registre, compteur, type de record ou commande d'avoir n'est admis. |
| Facture et solde | `lib/international/invoicing.ts:25`, `invoicing.ts:179`, `invoicing.ts:191` | Le solde est le total original moins les encaissements. Une facture ne contient aucun avoir. Le paiement est positif et limité à ce solde. |
| Immutabilité SQL | `supabase/migrations/20261007222349_international_us_erp_persistence.sql:120` | Le journal validé est immuable ; les factures ne peuvent être modifiées que par ajout d'encaissements, sans altérer leurs faits d'origine. |
| Reconstruction | `lib/international/runtime-validation.ts:62`, `runtime-validation.ts:79`, `runtime-validation.ts:98` | Les factures sont reconstruites depuis leurs devis et preuves historiques ; les journaux depuis leurs opérations sources. Une écriture simplement équilibrée, sans source reconnue, est refusée. |
| Comptabilité d'engagement | `lib/international/accounting/postings.ts:18` | L'émission comptabilise créance, ventes et taxe. Un avoir doit porter une source propre et un ajustement déterministe distinct. |
| Comptabilité de trésorerie | `lib/international/accounting/postings.ts:27`, `postings.ts:39` | Le revenu et la taxe des paiements sont répartis cumulativement sur le montant et la ventilation originaux. Diminuer seulement le solde casserait cette cohérence. |
| Journaux manuels | `lib/international/accounting/us-journal.ts:24`, `us-journal.ts:80` | Créances, dettes, taxe et acomptes sont exclus des journaux manuels ; la contrepassation manuelle ne concerne que les journaux manuels. |
| Plan comptable | `lib/international/runtime-validation.ts:26` | Le plan de comptes attendu est vérifié exactement. Ajouter globalement un compte de retours ou de crédit client invaliderait les historiques existants. |

## Plus petite évolution financière cohérente à préparer

Le périmètre ci-dessous décrit une future capacité, **pas une fonctionnalité terminée**. Sa première activation doit rester limitée aux cas dont les règles comptables et fiscales ont été validées.

1. Introduire une promotion explicite4→5, par entreprise US uniquement, conservant tous les historiques1–4. Ajouter les registres et compteurs requis sans réécrire les factures ni les anciens reçus. La promotion elle-même possède un événement et un reçu atomiques ; elle n'est pas déclenchée par une simple lecture ou un en-tête navigateur.
2. Enregistrer un avoir immuable distinct, lié à une facture source exacte et à son identité publique figée. La facture actuelle n'a pas de champ de révision propre : utiliser l'empreinte canonique de ses faits immuables et lier séparément la révision ERP et l'état des paiements, plutôt que d'inventer une `invoiceRevision`. Les choix par ligne ne peuvent pas fournir de prix, taxe, client ou compte faisant autorité.
3. Séparer le document d'avoir, son application à la créance et un éventuel remboursement. La première verticale peut interdire crédits disponibles non affectés, remboursements, factures déjà réglées et méthode cash jusqu'à validation de leurs règles ; ces cas ne doivent jamais être acceptés par défaut. Même le cas d'engagement impayé exige la validation de l'ajustement fiscal applicable.
4. Calculer allocations, limites et reliquats en quantités entières et centimes, cumulativement. Définir un contrat central de règlement : total d'origine, encaissements réels, crédits appliqués et montant restant. Un avoir de montant nul, excédentaire ou déjà appliqué est refusé. Un crédit n'est jamais compté comme un encaissement.
5. Émettre uniquement dans une transaction CAS qui enregistre ensemble compteur/numéro, avoir, allocations, journal, audit, événement delta et reçu idempotent. L'autorité et les preuves sont produites côté serveur ; une reprise exacte retrouve le reçu avant de rejeter une révision devenue ancienne. Une opération fiscale externe ambiguë ne doit pas être rejouée aveuglément.
6. Reconstruire les avoirs et toutes leurs conséquences lors de chaque validation complète/replay. Les périodes, dates d'opération, dates comptables et corrections restent explicites. Les documents validés ne sont pas supprimés ni modifiés pour corriger une erreur.

Cette verticale ne peut pas être réduite à l'ajout de `creditMemos: []` et d'un nouveau bouton. Le service préparatoire actuel permet de fixer et tester la partie arithmétique sans créer cette dette de compatibilité.

## Dépendances à adapter avant promotion ou activation

### Contrat, runtime, persistance et synchronisation

- `lib/international/runtime-types.ts` : état/version, registre, compteur, types de records et commandes ; contrat d'application et de correction si ces opérations sont autorisées.
- `erp-request.ts`, `erp-contract.ts`, `runtime.ts` : champs exacts, permissions financières, dérivation de source, fraîcheur, reprise idempotente, calcul et commit atomique. Les conditions exactes `schemaVersion === 4` des écritures, périodes et projets doivent être remplacées par une capacité centrale compatible, sans permettre de rétrograder5→3 (`runtime.ts:154`).
- `runtime-validation.ts` : schéma exact, factures et paiements historiques, sources de journaux, allocations et replay complet. Le validateur ne peut pas tolérer des sources inconnues sous prétexte que leur journal est équilibré.
- `runtime-store.ts:27`, `runtime-store.ts:31`, `runtime-sync-store.ts:18` : RPC de lecture, reçu, révision et delta par capacité ; conserver le refus des anciens clients sur une entreprise promue.
- `runtime-sync.ts:42`, `runtime-sync.ts:62`, `runtime-sync.ts:91` : liste des actions/kinds, forme des compteurs, transitions de version, changements autorisés, invariants d'audit et reconstruction du candidat. `browser-erp-session.ts`, `browser-us-workspace-sync-session.ts` et leurs validateurs doivent comprendre5 avant qu'il soit annoncé.
- `erp-schema-capability.ts`, `runtime-bindings.ts`, `runtime-sync-server.ts` : admission et drapeau serveur indépendants du protocole, capacité capturée puis relue après attente, pays, rôle, abonnement et entreprise toujours contrôlés.

### Migrations PostgreSQL

Créer de nouvelles migrations additives avec le CLI ; ne modifier aucun fichier historique.

- La migration `20261008161118_international_us_journal_periods_v4.sql` contient les contraintes explicites1–4 (`:7`, `:10`), la validation v4 (`:45`), le commit commun (`:335`), les sources financières (`:623`), les gardes de complétude et les RPCv4 (`:845` et suivantes). **Le garde v4 retourne sans vérifier si le schéma n'est pas4** : simplement autoriser5 dans les contraintes ferait sauter cette protection. Une validation v5 équivalente ou plus stricte est indispensable avant tout record5.
- Étendre de façon cohérente les CHECK de header/événement et de kind, compteurs, numéros uniques par entreprise, champs exacts, actions, sources, gardes d'immuabilité et gardes différés de complétude. Un avoir validé doit être protégé aussi contre les écritures directes contournant le RPC.
- Conserver les FKs d'entreprise, RLS, accès privés `service_role`, fonctions `security invoker` à `search_path` fermé, reçu et événement obligatoires. Les permissions financières d'un nouveau workflow ne découlent pas du rôle commercial autorisé aux commandes clients.
- Prévoir RPCv5 read/receipt/revision/delta et un commit adapté. Les entrées archivées1–4 conservent leur schéma original et restent validables ; les RPC anciens continuent à refuser les têtes plus récentes.
- Tester la chaîne entière des migrations et les appels SQL directs hostiles, pas seulement le code TypeScript ou un helper SQL isolé. Après émission5, le retour arrière sûr consiste à fermer les nouvelles écritures et garder un lecteur5 ; rétrograder les têtes ou retirer le nouveau registre perdrait de l'information financière.

### Taxe et préparation d'émission

- `us-tax-invoice.ts`, `us-tax-operation-store.ts`, `us-tax-invoice-preparation-store.ts`, `us-tax-prepared-operation-store.ts`, `us-tax-readiness.ts` et transports : capacités autorisées et revalidations compatibles5 afin que les émissions de factures existantes ne cessent pas de fonctionner après promotion.
- `20261008172520_international_us_tax_invoice_capability_v2.sql:15` et `20261009224607_international_us_tax_invoice_preparation.sql:85` refusent actuellement les schémas au-delà de4. Leurs contrats et wrappers préparés doivent être adaptés en conservant le replay exact des anciens reçus, snapshots et preuves.
- Les opérations existantes sont des **calculs de taxe d'émission TEST**, liés à `issue_invoice`. Elles ne prouvent ni une transaction fiscale d'origine ni un reversal. Introduire un port distinct pour transaction/ajustement fiscal, sa preuve source, son lien avec la facture, son idempotence et son rapprochement. Ne pas recycler une preuve de calcul comme preuve d'annulation, inventer un taux ou accepter une approbation fiscale fournie par le navigateur.
- Définir et faire valider reconnaissance cash, ajustements sur paiements partiels, taxe, dates/périodes, crédit client disponible et remboursement. La taxe historique allouée par le noyau préparatoire reste un candidat arithmétique, jamais une autorisation fiscale.

### Banques, rapports et documents

- `invoicing.ts:179`, `accounting/postings.ts:27`, tous les appels à `invoiceBalance` : introduire le règlement tenant compte des crédits pour limite d'encaissement, créances et présentation. Ne pas recalculer rétroactivement les encaissements historiques à partir d'une facture nette modifiée.
- `accounting/reports.ts` : les rapports sont calculés depuis les journaux ; les écritures d'avoir admises par le replay peuvent y entrer naturellement, mais il faut vérifier bilan, résultat, balance, grand livre et clôture sur les nouvelles sources et corrections. Un ajustement non monétaire ne crée pas de flux de trésorerie.
- `export-snapshot.ts:191`, `export-snapshot.ts:193` : le rapport projet déduit actuellement les sommes reçues par `invoicedTotal - outstanding`. Après avoir, cette formule compterait le crédit comme de l'argent encaissé. Ajouter des agrégats distincts et adapter le validateur strict, les libellés et tous les formats exportés.
- `us-bank-store.ts:53`, `us-bank-server.ts:46`, `20261008184605_international_us_bank_reconciliation.sql:242` : admission exacte4 à adapter ; préserver les rapprochements historiques et leurs preuves. `accounting/reconciliation.ts` rapproche les mouvements de cash : un avoir sans remboursement n'en est pas un. Les remboursements autorisés nécessitent une opération séparée et ne doivent pas diminuer une seconde fois le revenu.
- `documents.ts:50` contient déjà un `CreditMemoDocument`, **explicitement limité à une projection**. À `:214` il emploie l'identité courante du vendeur pour le crédit et à `:263` il valide une preuve historique de calcul de taxe comme pour une émission. Il ne constitue pas un record d'avoir autorisé et immuable. Réutiliser la présentation seulement après adaptation des snapshots, de la provenance fiscale, des statuts et de la numérotation.
- `export-snapshot.ts:17` et `:70` ne proposent pas de sélecteur d'avoir persistant. Ajouter un DTO public strict sans EIN ni preuves privées et des exports depuis le record validé, jamais depuis un formulaire client arbitraire.
- `components/account/us-erp-workbench.tsx:133` : solde nul signifie actuellement « payé ». Distinguer paiement, crédit total, règlement mixte et remboursement ; adapter aussi formulaire d'encaissement, projets et navigation documentaire, avec les langues et le thème existants.

### Capacités natives et modules reliés

La promotion doit conserver tout l'écosystème de l'entreprise, pas seulement la nouvelle commande financière.

- Les sessions natives sont plafonnées par `us-device-contract.ts:24`, `us-device-server.ts:40`, `runtime-bindings.ts:52`, `us-team-contract.ts:10` et `us-support-workspace-contract.ts:70`. La migration D1 `drizzle/0089_international_us_device_capability_v4.sql:9` impose4 aux sessions de capacité4. Un en-tête envoyé par un client ne doit jamais augmenter la capacité d'un identifiant natif déjà délivré. Vérifier explicitement le contrat livré aux clients, sa mise à jour et sa récupération après incompatibilité avant activation ; les sources de l'application historique se trouvent sous `desktop/`, mais cette revue ne constitue pas une validation des exécutables installés.
- `us-sales-order-store.ts`, `us-sales-order-server.ts`, `20261010054644_international_us_sales_orders.sql:51` : admission exacte4. Adapter lecture/historique/confirmation/annulation et vérifier que les protections de devis déjà liés restent actives après promotion5.
- `us-supplier-document-server.ts:115`, `us-supplier-analysis-server.ts:84`, `us-supplier-analysis-bindings.ts:34`, `us-automation-store.ts`, `us-supplier-store.ts`, `20261008194930_international_us_supplier_proposals.sql:203` et `:320` : livres et commits exacts4. Adapter import, validation humaine, analyse et droits sans autoriser Automation à émettre un avoir.
- `us-workspace-sync-heads-store.ts:26`, `us-workspace-sync-heads-bindings.ts:21` : canaux comptables et têtes ; un état5 ne doit pas cacher banque, fournisseurs ou analyses, ni casser leur rafraîchissement.
- Les contrats Support/équipe D1 utilisent la capacité native4 et des tables de sessions distinctes (`us-support-workspace-d1.ts:48`, `us-team-store.ts:55`, `us-support-worker-server.ts:27`). Décider explicitement compatibilité5 ou nouveau contrat de session ; ne pas faire tomber5 dans la branche des anciennes sessions par défaut.
- L'interface contient plusieurs admissions exactes4 pour banque, fournisseurs, Automation, documents et commandes. Centraliser la compatibilité financière et conserver leurs droits d'abonnement, au lieu d'ajouter des conditions locales5 sans revue.

## Conditions de validation avant une émission disponible

1. Tests arithmétiques exacts : quantités, remises, lignes mixtes, taxe historique, arrondis cumulatifs, avoirs successifs, solde résiduel, doublons et sources falsifiées.
2. Tests runtime/replay : promotion explicite, historiques1–4, facture inchangée, journaux équilibrés, allocations limitées, encaissement après crédit, périodes fermées, reprise exacte et correction non destructive.
3. Tests PostgreSQL sur chaîne réelle : RLS interentreprises, autorité révoquée, rôle insuffisant, CAS concurrent, doublons de numéro/source/reçu, insertions directes incomplètes, mutation/suppression de records validés et rollback de transaction.
4. Tests taxe : preuve de reversal liée à la transaction d'origine, absence/configuration périmée, résultat externe incertain, reprise sans duplication, rejet des assertions fournies par le client. Le mode TEST ne devient pas production par cette évolution.
5. Tests d'intégration : delta5 et ancien client refusé, révision/reçu après commit ambigu, commandes et devis protégés, fournisseurs/Automation/Support/équipe inchangés, capacités natives et droits révoqués après attente.
6. Tests rapports/exports : créance, revenus, taxe et cash restent distincts ; crédit total n'est pas affiché comme paiement ; projet ne gonfle pas les encaissements ; exports et documents utilisent l'identité historique et ne divulguent aucun secret.
7. Régression suisse et abonnements : aucun changement de livre CH, QR-facture, TVA, données, droits ou abonnements CHF ; ni nouveau tarif ni modification de résidence des données implicite.

L'étape préparatoire actuelle n'exécute pas cette migration, ne promet pas son activation et ne remplace pas la validation professionnelle des traitements financiers à venir.
