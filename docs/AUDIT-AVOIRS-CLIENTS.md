# Avoirs clients — audit en cours

## Corrections locales du 6 septembre 2026

Ces changements sont postérieurs à la version publique 1.37.0. Ils ne sont pas encore distribués et ne constituent pas un parcours terminé de remboursement client.

L'émission contrôlait le plafond TTC global mais pas la répartition des avoirs entre les taux. Une facture de 100 CHF HT à 2,6 % pouvait ainsi recevoir un avoir de 50 CHF HT à 8,1 %. Une facture à plusieurs taux pouvait également être créditée au-delà de sa base d'origine pour l'un de ces taux, tout en restant sous le plafond global. Enfin, le mode convenu permettait une date d'avoir antérieure à celle de sa facture.

Le moteur vérifie désormais la date et les cumuls HT, TVA et TTC pour chaque taux. Le contrôle inclut les avoirs émis précédemment, les lignes signées de déduction d'acompte et la demande en cours, dans la même transaction immédiate que l'émission. Les autres brouillons ne consomment aucun montant. Un refus conserve le brouillon, ses signes et sa numérotation, et ne crée aucune écriture.

Le formulaire propose les taux de la facture d'origine, y compris un taux historique absent des paramètres actuels. Il garde un ancien choix incohérent visible sous « Taux à corriger », sans modifier les valeurs saisies. La date minimale reprend celle de la facture ; une validation applicative couvre aussi les navigateurs dépourvus de contrôle natif de date.

L'inspection sur mobile a révélé qu'une erreur de formulaire pouvait rester hors de l'écran. L'éditeur réutilise maintenant le panneau d'erreur accessible avec défilement vers le message, y compris quand une même erreur se reproduit. Ce correctif bénéficie aussi aux devis et aux autres types de factures.

## Preuves

- Avant correction : trois tests natifs échouent parce que les émissions incohérentes réussissent, tandis que le cas multi-taux valide passe (`.qa/customer-credit-baseline.log`).
- Sept cas natifs couvrent les dates, un taux absent, le cumul par taux, les brouillons concurrents, le changement de paramètres, les documents valides et l'acompte déduit. Ils utilisent des bases SQLite temporaires et vérifient aussi l'absence d'effets partiels, les écritures et l'audit.
- La suite d'interface a passé 703 tests (`.qa/customer-credit-ui-full.log`). La compilation TypeScript et la construction de production sont contrôlées dans `.qa/customer-credit-web-build.log`.
- Le parcours de navigateur compilé couvre 320, 390, 768 et 1440 px sous Edge et WebKit. Il vérifie la conservation des valeurs, le taux historique, le refus de la date, la visibilité de l'erreur répétée, l'enregistrement et la réouverture du brouillon. Les données et l'enregistrement sont simulés ; ces parcours ne prouvent pas le moteur financier natif.
- Rapports et captures : `.qa/customer-credit-edge/` et `.qa/customer-credit-webkit/`, huit parcours réussis. Les captures de l'erreur à 320 px sous WebKit et du formulaire à 390 et 1440 px sous Edge ont été inspectées.
- Suite Rust complète : **564 réussites, aucun échec, un test déjà ignoré**, en 632,98 secondes (`.qa/customer-credit-native-full.log`, session terminée avec le code 0). `cargo clippy --locked --all-targets -- -D warnings`, le formatage des deux nouveaux modules, la compilation TypeScript, la construction de production et les 703 tests UI après la dernière modification réussissent également.

## Travail restant : imputation et remboursement datés

Le défaut de TVA reçue reste présent : le test existant `received_vat_is_deferred_then_reclassified_on_each_payment_and_credit_note` fait passer la TVA due de 8,10 CHF à 4,05 CHF dès l'émission d'un avoir de moitié après encaissement intégral, sans remboursement bancaire. Les corrections ci-dessus sécurisent la base de l'avoir mais ne corrigent pas ce mécanisme.

L'émission du document et le mouvement d'argent doivent avoir leurs propres preuves. L'[AFC distingue les méthodes convenue/reçue et inclut les compensations de créances dans son contrôle](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva). À titre de référence de fonctionnement, [Odoo distingue également l'avoir et l'enregistrement d'un remboursement](https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/credit_notes.html).

La suite doit créer un registre immuable des imputations, remboursements et extournes, avec dates effectives, solde commun et identifiants de reprise. Les nouveaux avoirs devront être distingués des historiques sans inventer de règlements ni réécrire leurs journaux. Les écritures TVA, les soldes des factures, la banque, les relances et le décompte reçu devront tous utiliser ce registre ; une simple suppression du blocage TVA serait incorrecte. Il reste aussi à intégrer les justificatifs, les exports, la sauvegarde/restauration et l'interface d'historique.

Le prochain test à écrire est le cas d'une facture intégralement payée, suivie d'un avoir sans remboursement : sa TVA due ne doit pas être réduite avant l'événement de règlement approprié. Compléter ensuite les remboursements partiels, les imputations à une autre facture du même client, les taux multiples, les passages de trimestre et les extournes. Ne publier ce parcours qu'après sa recette complète.
