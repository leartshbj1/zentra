# Préparer et émettre une facture

## Depuis un devis accepté

Utilisez **Créer la facture**. Vous pouvez préparer une facture complète ou cocher **Créer une facture d’acompte** et indiquer le pourcentage.

L’aperçu indique le montant de l’acompte et celui du solde après déduction. Les deux factures sont créées en brouillon dans le dossier du devis. En cas de refus, le choix et le pourcentage restent présents. Pendant la création, les réglages et la fermeture sont verrouillés.

## Vérifier avant l’émission

Dans la liste des factures ou dans le dossier du devis, choisissez **Émettre**. La fenêtre affiche en premier le total et le fait que l’émission rend le document non modifiable. Vérifiez ensuite le client, les dates, la période de prestation, le montant hors TVA et la TVA. **Relire les prestations** déplie le détail des lignes.

**Revenir sans émettre** ne modifie rien. **Confirmer et émettre** attribue le numéro et émet le document ; ce bouton n’envoie aucun e-mail et n’enregistre aucun paiement.

Dans un dossier avec acompte, émettez l’acompte avant le solde. La déduction sur le solde ne prouve pas que l’acompte est payé : chaque facture garde son propre suivi des encaissements.

## Corriger un point signalé

- **Dates** : le bouton de correction ouvre directement l’étape Conditions du brouillon, ou les dates du document lié. Pour une prestation d’un jour, renseigner le début suffit à proposer la même fin dans l’éditeur.
- **Compte bancaire** : le bouton ouvre la rubrique de facturation dans Paramètres. Renseignez l’IBAN de l’entreprise et utilisez **Enregistrer l’entreprise**.
- **Période fermée** : consultez les exercices. Si la date du brouillon est erronée, **Corriger la date du brouillon** ouvre sa correction. La période clôturée n’est pas rouverte automatiquement.
- **Comptes de liaison** : le bouton ouvre le plan comptable et les liaisons.
- **Acompte ou avoir préalable** : le message dirige vers le dossier ou les factures concernées.

Après avoir enregistré une correction, **Reprendre la facture** revient à la vérification du même document. Les données affichées sont relues depuis l’espace de travail ; l’utilisateur confirme à nouveau l’émission.

Les messages natifs complets restent consultables sous **Voir le message complet**. Les contrôles de préparation ne remplacent pas les validations finales du moteur.

## Si l’actualisation échoue

Quand l’émission a réussi mais que la relecture a échoué, utilisez **Actualiser les données**. Cette reprise ne réémet pas la facture. Les commandes restent bloquées pendant l’enregistrement et sa récupération.

## Validation du lot — non distribué

- 45 tests d’interface dans les deux dossiers : préparation d’émission, conversion, dates, progression du dossier et éditeur.
- 8 parcours Edge/WebKit de facture simple dans chaque dossier : date absente, ouverture directe de Conditions, enregistrement, IBAN, comptes, reprise de la même facture, lecture seule, montant, erreur de relecture après émission et conservation des lignes et notes.
- 8 parcours Edge/WebKit de dossier avec acompte dans chaque dossier : conversion refusée puis reprise, verrouillage, confirmation annulée, période fermée, retour depuis les exercices, double clic, paiements partiels, avoir affecté et reprise après erreur.
- 8 parcours existants dans Edge sur la base de livraison, couvrant notamment le solde d’un ancien acompte, les notes et les dates conservées, l’accès depuis le projet et la lecture seule.
- 2 tests natifs dans chaque dossier. Ils couvrent plusieurs pourcentages, les arrondis, la déduction de l’acompte, les numéros distincts, les paiements, les exports PDF, les écritures, les deux modes de comptabilisation de TVA déjà implémentés et la restauration du dossier. Aucun calcul fiscal ni schéma natif n’a été modifié.
- TypeScript et Vite compilent. Les captures des formats mobiles et ordinateur ont été inspectées.

Recettes : `desktop/tests/invoice-issue-journey.mjs`, `desktop/tests/quote-folder-payment-journey.mjs` et `desktop/tests/quote-pair-journey.mjs`. Les données utilisées sont synthétiques.

Aucun nouvel installateur ni IPA n’a été publié dans ce lot. Cette recette ne prouve pas une installation sur téléphone physique, la synchronisation entre appareils, ni une certification fiscale.

## Enregistrer l’argent reçu d’un client

Depuis **Factures**, ouvrez **Enregistrer un paiement** sur la facture concernée. Le même parcours reste accessible depuis le dossier d’un devis, pour l’acompte ou le solde.

1. Recopiez le montant réellement reçu et sa date. Le montant commence vide. **Tout le solde est reçu** remplit ce champ lorsque le client a tout payé ; ce bouton n’enregistre rien.
2. Indiquez le moyen de paiement. La référence et la note sont facultatives, dans une rubrique à ouvrir si nécessaire.
3. Choisissez **Vérifier le paiement**. Relisez le compte d’encaissement, le montant reçu et le reste à encaisser avant/après. **Modifier** retrouve votre saisie.
4. Confirmez avec **Enregistrer le paiement**. Le solde de la facture et son écriture comptable sont enregistrés ensemble. Aucun virement n’est envoyé.

La virgule et le point sont acceptés. Un montant trop élevé, une date impossible ou future et une information manquante reçoivent une explication à côté du champ. La chronologie tient compte des avoirs déjà appliqués. Un solde ou compte modifié après la vérification impose une nouvelle relecture. **Actualiser les factures** conserve la saisie.

Un compte manquant ou une période fermée donne accès à la comptabilité. Après cette navigation, retrouvez la facture pour préparer à nouveau le paiement. Le message natif complet reste consultable. Une facture retirée des données courantes n’est pas remplacée par une ancienne copie.

Si l’enregistrement ou sa relecture est interrompu, utilisez la vérification proposée. Zentra recherche la même demande, son contenu et sa preuve comptable ; la reprise ne renvoie pas le paiement. Une lecture vide ou sans preuve reste à reprendre. Cette interface est vérifiée avec des données de recette ; les nouveaux contrôles natifs nécessitent une nouvelle compilation de l’application.


## Déduire ou rembourser un avoir client

Ouvrez l’avoir dans **Factures**, ou retrouvez-le depuis sa facture liée. **Déduire d’une facture** réduit une facture émise du même client et dans la même monnaie. **Enregistrer un remboursement** sert à noter un virement déjà versé au client ; Zentra n’envoie pas ce virement.

1. Choisissez la facture, ou le compte depuis lequel vous avez remboursé le client. Les factures les plus récentes sont proposées en premier. La référence de la facture se remplit automatiquement tant que vous ne l’avez pas remplacée.
2. Indiquez le montant réellement utilisé ou versé et sa date. Le montant commence vide ; **Utiliser le maximum** le remplit sans enregistrer. Une référence et une courte explication suffisent. Les erreurs restent indiquées sous leur champ.
3. Choisissez **Vérifier le règlement**. Le montant de l’opération et les soldes avant/après sont présentés avant confirmation. **Modifier** retrouve votre saisie.
4. Confirmez avec **Enregistrer le règlement**. Si un solde a changé entre-temps, actualisez les factures et reprenez la vérification.

Dans l’historique, **Corriger** conserve le montant et la référence du règlement initial. Indiquez la date réelle de correction et une courte explication, vérifiez son effet puis enregistrez. Les règlements initiaux et leurs justificatifs restent présents. Un règlement rapproché donne accès directement à **Banque** pour vérifier le lien avant la correction. Un problème d’exercice ou de compte donne accès au réglage concerné. Après avoir quitté ce formulaire pour ces réglages, retrouvez l’avoir et préparez à nouveau l’opération.

Si la réponse est interrompue, la demande exacte reste conservée même après fermeture du dossier ou de l’app. **Vérifier la même demande** relit son historique. Si elle y figure avec les bons montants et sa preuve comptable, la reprise se termine sans nouvel envoi. Sinon, **Reprendre la même demande** renvoie le même identifiant et le même contenu. Les soldes après opération ne sont pas simulés pendant cette attente. Une lecture interrompue garde la reprise ouverte. La consultation et cette vérification restent accessibles en lecture seule ; les écritures sont désactivées.

Lorsque la comptabilité est inactive, le parcours l’indique et conserve le fonctionnement existant des règlements à comptabiliser. Aucun calcul fiscal ni schéma de base n’est changé. Recette : `desktop/tests/customer-settlement-guided-journey.mjs` et `desktop/tests/customer-credit-settlement-journey.mjs`. Ces changements nécessitent une nouvelle compilation native ; aucun nouvel installateur n’est publié dans ce lot.
