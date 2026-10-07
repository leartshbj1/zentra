# Finance CH / US : contrats expérimentaux

Ce moteur est une bibliothèque additive, pas un remplacement des commandes Rust/SQLite actuelles. Les fonctions produisent des états immuables en mémoire. Aucun journal client, solde, document historique ou réglage fiscal n'a été modifié. Les autorisations passées aux fonctions doivent provenir d'un serveur vérifié ; un objet JavaScript n'est jamais une preuve d'identité.

## Périmètre implémenté

| Fichier | Fonction |
| --- | --- |
| `lib/international/invoicing.ts` | Contact particulier/entreprise, adresses de facturation/livraison, contact, conditions de paiement, devis, détermination fiscale liée aux entrées, facture émise et paiements partiels |
| `accounting/ledger.ts` | Plan de comptes, périodes, journal équilibré, révision, idempotence, contrepassation liée, clôture et trace d'acteur |
| `accounting/postings.ts` | Préparation des écritures de ventes, encaissements, achats et paiements fournisseurs ; méthodes cash/accrual séparées |
| `accounting/reports.ts` | Grand livre, balance de vérification, résultat, bilan et flux de trésorerie directs |
| `accounting/reconciliation.ts` | Relevé synthétique, correspondances exactes approuvées, restes à rapprocher et clôture liée à la révision du journal |
| `countries/{ch,us}/accounting.ts` | Plans de comptes de départ, sans prétention normative ou certification |

Les plans sont des exemples extensibles ; les identifiants de comptes utilisés par les écritures standards doivent rester explicitement mappés. Le plan CH expérimental ne remplace pas le plan ni la fiscalité suisses natifs.

## Montants, arrondis et dates

Les montants utilisent `Money { currency, minorUnits: string }`, avec BigInt interne. Les champs du journal acceptent des unités mineures positives canoniques limitées à 36 chiffres ; aucune addition ne passe par un flottant. Les quantités sont des entiers avec une échelle explicite, les remises des points de base. L'arrondi monétaire du socle est au cent, à la moitié en s'éloignant de zéro. L'allocation cash des paiements partiels utilise la différence entre deux allocations cumulées : elle ne multiplie pas une erreur d'arrondi par le nombre de versements.

CHF et USD ne sont jamais mélangés ou convertis implicitement. Le journal impose débit = crédit, au moins deux lignes non nulles, des comptes connus, une période ouverte et une date comptable comprise dans cette période. Les dates civiles ont le format `YYYY-MM-DD`, avec contrôle du calendrier. Transaction, comptabilisation et paiement restent des champs distincts. Les horodatages d'audit sont des instants UTC explicites, également contrôlés par `parseInstant` ; les preuves fiscales acceptent un offset explicite. Les numéros et révisions sont vérifiés avant incrément pour éviter de dépasser l'entier sûr JavaScript.

## Méthodes comptables : hypothèses limitées

- **Accrual** : l'adaptateur de facture suppose que le revenu facturé est acquis à la date comptable revue. Il débite les créances et crédite ventes et taxes à payer. L'encaissement débite la trésorerie et solde les créances. Ce n'est pas un moteur de reconnaissance de revenus, d'obligations contractuelles ou de revenus différés.
- **Cash** : émettre une facture ne reconnaît pas un revenu dans le journal. La créance reste suivie opérationnellement. Les encaissements alimentent ventes et taxes à payer selon l'allocation exacte définie. Cette allocation comptable expérimentale ne décide pas quand une juridiction exige la déclaration ou le versement de sales tax.
- **Achats US** : la facture fournisseur standard inclut sa taxe dans le coût, sans inventer de crédit TVA. Selon la nature du bien, une immobilisation, un stock, une taxe d'usage ou un autre traitement peut être nécessaire. Le compte doit être choisi et revu ; ce modèle n'effectue pas cette détermination réglementaire.
- **Achats CH** : la récupération de TVA reste dans le moteur natif existant. Ces écritures génériques ne doivent pas être branchées à sa place.

La [Publication 538 de l'IRS](https://www.irs.gov/publications/p538) distingue les méthodes cash et accrual et leurs conditions d'utilisation. Elle ne rend pas cette bibliothèque conforme automatiquement à l'impôt américain ou à US GAAP. Le choix de méthode, les exceptions, stocks, revenus différés, amortissements et clôtures fiscales exigent une revue professionnelle avant production.

## Corrections, rapports et rapprochement

Une écriture validée est conservée. Sa correction passe par une contrepassation exacte, identifiée et liée, qui ne peut être répétée silencieusement. Le rejeu exige la même identité et le même contenu et recontrôle l'autorité. La clôture interdit les nouvelles écritures dans la période ; elle ne crée pas une écriture de transfert de résultat fictive. Le bilan présente séparément les résultats cumulés non clôturés. Les rapports se basent sur la date comptable ; les mouvements de rapprochement utilisent la date de paiement, ou de transaction si aucun paiement n'est indiqué.

Le tableau de flux est direct, avec catégories operating/investing/financing explicites. Il calcule ouverture, mouvements et clôture. Il ne présente pas un tableau indirect certifié, des effets de change ou une consolidation multi-entreprises.

Le rapprochement exige un relevé équilibré, une entreprise/devise/compte de trésorerie compatibles et des correspondances exactes approuvées. Une ligne ou écriture déjà associée ne peut être associée de nouveau. Aucun frais ou écart n'est comptabilisé par rapprochement flou. La clôture exige que tous les éléments et soldes concordent ; un changement ultérieur du journal invalide la conclusion de clôture pour cette révision. Les références bancaires sont opaques : aucun identifiant ACH, numéro de compte, mandat ou secret n'est ajouté à ce contrat.

## Fiscalité et documents

Une facture nécessite une détermination liée à l'entreprise, pays, devise, révision, date, client, localisation, lignes et montants actuels. Les preuves expirées, d'une autre entreprise ou d'une ancienne révision sont refusées. US refuse la source `swiss-vat`. Sans configuration et prestataire fiable, l'émission est bloquée ; aucun taux national ou table prétendument exhaustive n'est fourni. Une exemption est une preuve approuvée et documentée, pas une règle par défaut.

La facture archive une copie validée de la configuration d'émission. Modifier ensuite langue, adresse ou statut fiscal ne modifie pas le document historique et n'empêche pas sa prévisualisation. Le contexte courant doit toujours appartenir à la même entreprise et juridiction. Le nom et les coordonnées publiques du vendeur doivent encore être archivés atomiquement par le futur adaptateur documentaire. Voir [DOCUMENTS.md](DOCUMENTS.md) pour les numéros, PDF et limites du rendu CH générique.

## Frontière serveur et persistance restant à construire

Le futur adaptateur doit vérifier à nouveau session, appartenance, rôle, module payé et workflow, puis enregistrer **ensemble** état métier, écriture, révision, numéro réservé et reçu d'idempotence dans une transaction. Il doit valider les états restaurés, ne pas faire confiance à un journal ou une facture envoyé par le navigateur, et gérer refus, retries et effets incertains. Les gardes CAS en mémoire ne remplacent pas une transaction PostgreSQL/SQLite/D1.

Les commandes natives CH refusant USD, les contrats de synchronisation et les CHECK de SQLite ne sont pas déverrouillés. Aucun remboursement, émission complète d'avoir, dépôt, récurrence, commande/livraison, consolidation, moteur d'immobilisations US, clôture fiscale ou import bancaire live n'est déclaré terminé dans ce socle. Les modèles clients/fournisseurs existants ne sont pas remplacés et ne deviennent pas automatiquement des CRUD US persistants.

## Tests réellement exécutés

`finance.test.ts` : 56 tests ; `accounting/reconciliation.test.ts` : 11 tests. Ces nombres sont inclus dans les 307 tests du dossier international, pas à additionner une seconde fois. Couverture : équilibre, droits et entreprise, devise, idempotence/conflits, révocation, contrepassation, périodes, cash/accrual, arrondis, preuves fiscales, historique et paiements partiels, rapports et rapprochement. Ils ne prouvent pas une recette bancaire, fiscale, native ou multi-appareils. Le dossier [DELIVERY.md](DELIVERY.md) conserve la portée exacte des autres vérifications.
