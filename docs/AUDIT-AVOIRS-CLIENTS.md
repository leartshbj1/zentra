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

## Deuxième lot local : règlements datés et consultation

Le défaut reproduit après le premier lot réduisait la TVA due de 8,10 CHF à 4,05 CHF dès l'émission d'un avoir de moitié après encaissement intégral, sans remboursement bancaire. Le second lot conserve désormais les 8,10 CHF dus jusqu'au règlement de l'avoir. Un remboursement partiel de 27,03 CHF libère 2,03 CHF de TVA à sa propre date ; son extourne reprend exactement ces mêmes centimes.

L'émission du document et le mouvement d'argent doivent avoir leurs propres preuves. L'[AFC distingue les méthodes convenue/reçue et inclut les compensations de créances dans son contrôle](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva). À titre de référence de fonctionnement, [Odoo distingue également l'avoir et l'enregistrement d'un remboursement](https://www.odoo.com/documentation/19.0/applications/finance/accounting/customer_invoices/credit_notes.html).

La migration additive 53 distingue les nouveaux avoirs des historiques. Le registre conserve les déductions, remboursements et extournes, leurs dates, un solde commun, les ventilations par ligne et une preuve du journal. L'émission d'un nouvel avoir déduit uniquement le solde encore ouvert de sa facture d'origine. Son reliquat reste disponible pour un remboursement ou une autre facture du même client et de la même devise. Les remboursements ne sont jamais inventés lors de l'émission.

Les soldes de factures, candidats bancaires et relances utilisent les mouvements du registre. La comptabilité et le décompte reçu partagent les mêmes centimes par ligne. Les extournes reprennent les comptes et les montants du journal d'origine. Les événements déjà saisis peuvent être comptabilisés lors d'une activation ultérieure, sans déplacer leurs dates. Les avoirs historiques sans dates documentées restent bloqués pour le décompte reçu et la nouvelle saisie de règlement.

La consultation présente le disponible, les montants déduits/remboursés et l'historique lié. Les détails du document émis sont dépliables. Les formulaires s'adaptent à 320–1440 px, respectent la lecture seule et les animations réduites, et restaurent le focus après une opération. Une demande dont la réponse a été interrompue est conservée localement avec le même identifiant, y compris après fermeture du dossier. Une reprise ne doit pas devenir un second remboursement.

Preuves du second lot :

- Quinze tests métier passent dans `.qa/customer-credit-delivery-native.log` : cas initiaux, paiement intégral/partiel, déduction et paiement ultérieur, remboursements, reprises, extournes exactes, plusieurs taux, invariance trimestrielle, activation comptable ultérieure, échec tardif atomique, détection d'un journal altéré et migration depuis 52. Ce dernier cas a révélé puis corrigé une borne oubliée dans l'aiguillage des migrations ; les journaux historiques sont ensuite comparés intégralement avant/après, les nouveaux registres restent vides et le blocage TVA historique est conservé.
- La suite native complète a exécuté 571 tests en 649,78 s : 568 réussites, deux fixtures anciennes à adapter au schéma 53, un test déjà ignoré. Les deux fixtures corrigées passent séparément (`customer-credit-fixture-guard.log`, `customer-credit-fixture-migration.log`). Le test de panne tardive est supplémentaire à cette exécution complète.
- 706 tests UI passent et la construction TypeScript/Vite réussit. Voir `.qa/customer-credit-final-all-ui.log`, `.qa/customer-credit-release-candidate-build.log` et les journaux Clippy sur toutes les cibles natives.
- Douze cas compilés Edge/WebKit passent : huit parcours à 320, 390, 768 et 1440 px couvrent remboursement, réponse perdue, fermeture/réouverture, reprise identique, correction et déduction ; quatre autres vérifient la lecture seule avec animations réduites. Les assertions vérifient aussi l'absence de débordement horizontal et le retour du montant disponible dans la zone visible après enregistrement. Les captures finales mobile et ordinateur sont inspectées. Les données du navigateur sont simulées ; les effets financiers sont vérifiés séparément en SQLite/Rust. Rapports et captures : `.qa/customer-credit-settlement-edge/` et `.qa/customer-credit-settlement-webkit/`.

## Limites de ce lot non publié

Il reste à terminer la reprise documentée des avoirs historiques, les justificatifs, les liens aux débits bancaires et leur dissociation, l'index des preuves dans le dossier de clôture, ainsi que la recette de sauvegarde/restauration et d'export du nouveau registre. Les tables figurent déjà dans la liste CSV, mais cela ne constitue pas une vérification complète du dossier exporté. Les changements de méthode TVA restent bloqués lorsqu'un avoir lié exige un rapprochement.

Compléter les essais de concurrence des règlements, les dates closes/futures, les bases signées d'acompte avec règlement/extourne et le rapprochement des anciennes ventilations par ligne. Aucune publication, aucun paquet signé ni mise à jour distante n'est effectué pour ce lot. La version distribuée reste 1.37.0.
