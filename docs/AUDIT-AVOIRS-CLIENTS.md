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

## Justificatifs et exports — schéma 54, non publié

Les règlements clients peuvent recevoir des PDF, JPG, PNG ou WebP. Les fichiers sont validés, limités à 25 Mo et dédupliqués par événement et empreinte. Ils restent conservés après une correction. Un échec de transaction après installation du fichier nettoie la copie sans toucher aux montants. La migration 53 vers 54 préserve les événements, leurs écritures et les pièces existantes.

L'historique permet de joindre et d'ouvrir une pièce, y compris en lecture seule pour les pièces existantes. Un fichier déjà enregistré peut être renvoyé après une réponse interrompue sans seconde copie. Dans le dossier du projet, le justificatif porte son origine et donne accès à l'avoir. Une déduction entre deux projets différents ne reçoit aucun projet arbitraire. Le bloc des dossiers de facturation n'apparaît que lorsqu'il contient des documents.

L'export CSV comprend maintenant les quatre registres du modèle client, des règlements, des ventilations et des preuves de comptabilisation. Le dossier de clôture indexe les événements et leurs ventilations, contrôle les empreintes des pièces et conserve aussi les justificatifs des règlements non encore comptabilisés dans un export provisoire. Ce cas reste bloquant pour une clôture définitive. Les périodes sans règlement client conservent leur structure d'index précédente.

Validation de ce troisième lot :

- Six tests natifs ciblés : copie concurrente dédupliquée, migration 53, immutabilité et conservation après extourne, fichier altéré, échec au commit avec nettoyage, absence de projet deviné, dossier de clôture provisoire avec règlement non comptabilisé, contenu CSV et restauration réelle d'une sauvegarde avec comparaison des registres et octets. `.qa/customer-credit-receipt-final-native.log`.
- Dix tests de clôture et douze tests de sauvegarde existants passent : `.qa/customer-credit-closing-regression.log`, `.qa/customer-credit-backup-regression.log`. Clippy sur toutes les cibles passe avec `-D warnings`.
- 709 tests UI passent et la construction TypeScript/Vite réussit. Le pont natif distingue une copie enregistrée suivie d'une lecture interrompue d'un refus de copie. `.qa/customer-credit-receipt-ui.log`, `.qa/customer-credit-receipt-build.log`.
- Edge et WebKit : ajout, réponse interrompue, reprise sans doublon, consultation après correction et accès à l'avoir depuis le projet à 320, 390, 768 et 1440 px ; lecture seule et ouverture des pièces existantes à 320 et 1440 px. Rapports et captures dans `.qa/customer-credit-settlement-edge/` et `.qa/customer-credit-settlement-webkit/`. Ces parcours utilisent des données simulées ; les écritures et les fichiers réels sont vérifiés par les tests natifs.

## Limites des lots non publiés

Il reste à terminer la reprise documentée des avoirs historiques, les liens aux débits bancaires et leur dissociation, ainsi que l'ajout facultatif d'une pièce au moment même d'enregistrer le remboursement. L'ajout séparé à un règlement existant, les exports et la restauration du nouveau registre sont vérifiés ci-dessus. Les changements de méthode TVA restent bloqués lorsqu'un avoir lié exige un rapprochement.

Compléter les essais de concurrence des règlements, les dates closes/futures, les bases signées d'acompte avec règlement/extourne et le rapprochement des anciennes ventilations par ligne. Aucune publication, aucun paquet signé ni mise à jour distante n'est effectué pour ce lot. La version distribuée reste 1.37.0.
