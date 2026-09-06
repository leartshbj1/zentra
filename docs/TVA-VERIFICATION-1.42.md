# Contrôle du système TVA — 6 septembre 2026

Références consultées :

- [AFC — taux actuellement en vigueur](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse) : taux normal 8,1 %, réduit 2,6 %, hébergement 3,8 %.
- [Portail PME de la Confédération — fonctionnement de la TVA](https://www.kmu.admin.ch/fr/taxe-sur-la-valeur-ajoutee-tva-fonctionnement) : déduction de l’impôt préalable dans le cadre de l’activité, exclusions et corrections de l’affectation mixte, numéro TVA sur les factures.
- [AFC — taux de la dette fiscale nette et taux forfaitaires](https://www.estv.admin.ch/fr/tva-taux-de-la-dette-fiscale-nette-et-taux-forfaitaires) : distinction entre taux légal facturé et méthode de décompte simplifiée, sans déduction séparée de l’impôt préalable.

Les tests du moteur portent sur les montants entiers en centimes et les taux en points de base, les factures à plusieurs taux, les achats de marchandises, investissements et coûts non déductibles, les entreprises non assujetties, les contre-prestations convenues et reçues, les paiements partiels, les avoirs, remboursements et corrections de TVA. Ils rapprochent les comptes du journal, le décompte et les instantanés conservés après clôture ou restauration.

Cas couverts notamment dans `input_vat_tests.rs`, `vat_reporting.rs`, `vat_received_credit_tests.rs`, `customer_credit_recovery_vat_tests.rs` et les tests de rapprochement bancaire. Le moteur bloque les périodes ou classifications incomplètes au lieu de les présenter comme un décompte final. Les tests de présentation vérifient en outre l’exemple 500,00 CHF HT + 40,50 CHF TVA = 540,50 CHF TTC.

Les réglages graphiques ne modifient aucun calcul fiscal. Le taux applicable et le droit à déduction dépendent toujours de la prestation, des justificatifs et du profil TVA choisi par l’entreprise. Une exportation du logiciel n’est pas une preuve de dépôt accepté sur le portail AFC.
