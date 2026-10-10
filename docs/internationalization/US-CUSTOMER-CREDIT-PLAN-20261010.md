# Avoirs clients US — étape de préparation, 10 octobre 2026

Base de travail : `04f8325f7b89c18da9dc267676212dcbc83b91dc`. Cette étape suit les commandes clients. Elle prépare le prochain contrat financier sans modifier les schémas ERP 1–4, les livres suisses ou une base hébergée.

## Décision d'architecture avant développement

Un avoir n'est ni un paiement négatif, ni une facture modifiée, ni un remboursement bancaire. Le runtime actuel reconstruit factures, encaissements et journaux depuis leurs sources ; un registre indépendant d'avoirs financiers rendrait `invoiceBalance`, les encaissements cash, les rapports et le replay incohérents. Les comptes du plan actuel sont également validés exactement : ajouter un compte global invaliderait les historiques.

Le gateway fiscal US existant produit des calculs TEST. Il ne crée pas de transaction fiscale d'origine permettant un reversal. Une taxe calculée ne prouve donc pas le droit ou l'exécution d'un ajustement fiscal. Même une facture à taxe nulle ne dispense pas de versionner ensemble le solde, le livre, les allocations et les remboursements.

Cette étape implémente un **noyau interne de préparation sans effet financier**, avec une frontière volontairement explicite. Aucun numéro d'avoir, reçu d'émission, journal, allocation à une facture, paiement, remboursement, diminution de solde ou document fiscal n'est créé. Aucun menu client ni route publique ne présente cette préparation comme une émission disponible. Le service est raccordable au futur contrat financier, mais n'est pas une nouvelle fonctionnalité de production.

## Contrat de calcul

La source est dérivée côté service d'une facture réellement présente dans un état ERP US validé. Son empreinte SHA-256 fige tous les faits immuables de la facture, à l'exclusion des encaissements. Les encaissements observés et la révision ERP sont liés séparément à la préparation : une nouvelle opération rend la préparation précédente périmée.

Les références historiques de preuve peuvent contenir des identifiants privés du calculateur. Le service n'en conserve dans la préparation qu'une empreinte SHA-256 préfixée ; les références originales restent dans la facture. Cette empreinte ne remplace jamais la lecture et la validation de la preuve d'origine par un futur port fiscal.

Les sélections utilisent les identifiants et unités de quantité de la facture d'origine. Aucun prix, remise, taux, total, fournisseur fiscal, client, rôle ou journal fourni par l'appelant ne fait autorité. Les montants nets après remise et les taxes historiques sont alloués par ligne, par arrondi cumulatif entier à mi-valeur en s'éloignant de zéro. Le dernier avoir complet reprend exactement le reliquat de centimes. La taxe allouée est seulement un **montant candidat à vérifier**, jamais un ajustement fiscal autorisé. Le détail historique de remise demeure dans la facture ; on ne fabrique pas des remises négatives en arrondissant indépendamment prix brut et remise.

Le noyau vérifie aussi une suite d'allocations antérieures pour préparer la future capacité : identités uniques, même source, sommes et quantités reconstruites, limites par ligne. Le service ERP actuel n'accepte aucune allocation antérieure de l'appelant : les schémas 1–4 n'en possèdent pas. Ces objets mathématiques ne constituent pas des avoirs déjà émis.

## Autorité et fraîcheur

Seuls owner/admin/accountant avec Gestion peuvent préparer dans leur entreprise US/USD. La configuration, le compte, le rôle et les droits sont relus après chaque attente privée. La demande et les données privées sont détachées avant toute attente. Une seconde lecture de l'état ERP après calcul et une dernière vérification d'autorité refusent une nouvelle révision ou une altération de source pendant l'opération. La préparation ne consomme pas de numéro et n'appelle aucune méthode d'écriture ou prestataire.

Dates d'opération et de comptabilisation restent distinctes. La date d'opération ne précède pas la facture. La période choisie doit être ouverte et contenir la date comptable. Une période historique fermée n'est pas rouverte. Le résultat décrit un aperçu arithmétique de réduction de créance et d'excédent éventuel ; il ne crée aucun crédit client disponible.

## Blocages explicites et étapes suivantes

L'émission reste toujours bloquée par l'absence de capacité financière compatible. Une taxe historique positive ajoute l'absence d'ajustement fiscal vérifié. La méthode cash ajoute une politique de reconnaissance à définir ; un crédit dépassant le solde impayé ajoute une politique de crédit client à valider. Aucun booléen de l'appelant ne lève ces blocages.

Étape suivante : versionner ensemble le contrat financier, le plan comptable, les sources d'avoir/allocation/remboursement, le replay intégral, les contrôles SQL/RLS/CAS, les événements delta, les balances/rapports/banques, les documents et les capacités natives. Intégrer ensuite le port de transactions et ajustements fiscaux et les politiques validées cash/accrual. Le remboursement enregistré ou déclenché sera un événement distinct ; il ne réduira pas une seconde fois le revenu.

## Validation prévue

Tests exacts de quantités et centimes, remises, lignes mixtes et taxes historiques ; avoirs partiels successifs puis total, ordre de sélection, limites, sources et historiques falsifiés. Tests du service sur des livres réellement construits par le runtime : cash/accrual, impayé/partiellement payé/payé, dates/périodes, droits, autre entreprise, changement de compte/configuration/révision et absence totale d'écriture/appel externe. Régression existante, TypeScript, lint typé, marque et build production. Aucun contrôle UI nouveau n'est annoncé puisque cette étape n'ajoute pas d'écran.

## Migration et retour arrière

Aucune migration n'est nécessaire pour des calculs internes sans persistance. Les migrations historiques ne sont pas modifiées. Aucun schéma5 incomplet n'est annoncé aux clients. Retirer ce noyau non exposé n'affecte aucun document conservé ; lors du futur raccordement, une migration additive, un plan de retour compatible et une recette staging approuvée seront nécessaires.
