# Vérifier et valider une facture fournisseur

## Recevoir les marchandises d’une commande

Dans **Achats & fournisseurs → Commandes**, choisissez **Saisir la réception** sur une commande confirmée.

1. **Ce qui est arrivé** : indiquez la date réelle d’arrivée et la quantité reçue pour chaque article. Une livraison partielle est possible : laissez zéro sur les lignes absentes. **Tout est arrivé** remplit les quantités restantes sans les enregistrer. La référence du bon et les notes sont facultatives.
2. **Vérifier et valider** : **Continuer vers la validation** conserve un brouillon et ouvre le récapitulatif. Relisez la date, les quantités et l’effet sur le stock, cochez la confirmation puis validez. Seuls les articles suivis entrent dans le stock ; le brouillon ne crée aucun mouvement.

Vous pouvez saisir une virgule ou un point, jusqu’à trois décimales. Une valeur vide, invalide ou trop précise reste affichée avec une explication au champ. La quantité ne peut pas dépasser le reste à recevoir. La date doit être réelle, comprise entre la commande et aujourd’hui. Les boutons restent accessibles pendant le défilement, sur ordinateur et sur mobile.

**Corriger les quantités** retrouve le brouillon. Si quelqu’un l’a modifié ailleurs, une comparaison conserve votre saisie et montre la version actuelle. Choisissez laquelle reprendre avant de sauvegarder. Une modification survenue après votre contrôle empêche la validation de l’ancienne version ; relisez les quantités actualisées et cochez à nouveau la confirmation.

Une période comptable fermée propose **Ouvrir les exercices**. Après votre vérification, retrouvez le même brouillon dans **Achats → Réceptions → Vérifier et valider**. L’application ne change pas automatiquement la date et ne rouvre pas la période. Les problèmes de stock donnent accès au catalogue ; une facture liée donne accès à cette facture.

Après une interruption de réponse, la vérification relit l’état de la réception avant toute nouvelle tentative. Après un enregistrement confirmé, une relecture incomplète reste dans la fenêtre de reprise. Ces actions relisent les données sans répéter l’écriture. La fermeture et les doubles clics sont bloqués tant que l’opération est en cours ; les actualisations restent accessibles en lecture seule.

Pour corriger une réception validée, **Annuler la réception** affiche les quantités qui seront retirées et demande un motif. Cette annulation concerne la réception entière et conserve son historique. Elle est refusée si les marchandises nécessaires ne sont plus en stock, si une facture est encore liée ou si la période ne permet pas la correction. Vos informations restent présentes après un refus. Une facture déjà validée doit suivre le parcours de correction des achats.

Ces ajouts sont intégrés au code après 1.59.0 ; aucun nouvel installateur ou IPA n’est publié avec ce lot. Recette : `desktop/tests/receipt-guided-journey.mjs`.

## Vérifier une facture reçue

Dans **Achats & fournisseurs**, ouvrez **Factures et avoirs**, puis **Valider** sur le brouillon. Vous pouvez ouvrir cette vérification même si un compte ou un rapprochement demande une correction.

1. **Comparez le total** avec la facture reçue. Relisez la date, l’échéance et, si nécessaire, les lignes dans « Comparer les achats ».
2. **Joignez le document original** : le bouton ouvre les justificatifs du même brouillon. Vous pouvez y ajouter le PDF ou une photo, puis terminer et utiliser « Reprendre la facture fournisseur ».
3. **Vérifiez les commandes** : si une commande de ce fournisseur existe, ouvrez directement le rapprochement. Vous pouvez aussi choisir explicitement de garder la facture indépendante de cette commande.
4. **Validez et comptabilisez** après vérification. Les informations et justificatifs deviennent non modifiables. La confirmation affiche le montant restant à payer et propose de saisir le paiement déjà effectué.

La validation ne signifie pas que le fournisseur a reçu l’argent et n’envoie aucun ordre bancaire. Le paiement est une action distincte. Vous pouvez enregistrer un paiement partiel ; le solde restant est conservé.

## Corriger un point signalé

- **Numéro manquant** : « Compléter la référence » place le curseur dans « Numéro / référence fournisseur ». Recopiez le numéro du document reçu, enregistrez, puis reprenez la vérification.
- **Période fermée** : « Vérifier les exercices » ouvre cette rubrique comptable. Corrigez une date uniquement si elle a été mal recopiée.
- **Compte absent ou non disponible** : le bouton ouvre **Plan & liaisons**. Après correction, « Reprendre la facture fournisseur » retrouve le même achat.
- **Écart de rapprochement** : le bouton ouvre les liens entre commande, réception et facture. La validation reste indisponible tant que l’écart demeure.
- **Brouillon déjà rapproché** : ses informations sont protégées. Retirez les liens avant de modifier ses lignes ou sa référence, puis refaites le rapprochement. Les justificatifs restent accessibles avant validation.
- **Justificatif refusé** : contrôlez la pièce du brouillon. Pour un import par e-mail, la pièce doit correspondre à l’original de l’import. Le message complet reste consultable.

Si vous choisissez de continuer sans pièce jointe, cochez l’option correspondante. Si la facture ou ses liens changent pendant la vérification, ces choix doivent être relus et cochés à nouveau.

En cas de lecture interrompue après un enregistrement confirmé, **Actualiser les données** relit les achats sans répéter la validation. Si une réponse a été perdue, l’état actuel du document est contrôlé avant de proposer une nouvelle tentative.

Cette amélioration est intégrée au code local. Aucun nouvel installateur ou IPA n’est publié avec ce lot. Les recettes utilisent des données synthétiques et ne remplacent pas une vérification sur une installation client.
