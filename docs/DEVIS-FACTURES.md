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
