# Factures récurrentes

Dans **Ventes → Commandes & livraisons**, ouvrez une commande de services confirmée puis **Planifier cette commande**.

## Choisir les dates

Choisissez une fréquence, la première date et le délai de paiement. La date de fin est facultative.

L’aperçu affiche les trois prochaines dates et leurs échéances de paiement. Une planification commencée au dernier jour du mois conserve ce repère : par exemple, le 31 janvier 2028 donne le 29 février puis le 31 mars. Un départ le 30 janvier revient au 30 mars après le mois court de février.

Si des dates sont déjà passées, le nombre de brouillons à préparer est indiqué avant l’activation. Le premier lot est limité à 12 ; contrôlez-le avant de demander la suite du rattrapage.

Zentra prépare des **brouillons**. Ouvrez chaque facture pour la vérifier puis l’émettre ; la planification ne l’envoie pas automatiquement.

## Modifier la fin

**Modifier la date de fin** permet de prolonger, raccourcir ou retirer la fin d’une planification. Une date de fin est incluse : si elle correspond à la prochaine facture prévue, cette facture reste prévue.

La fin ne peut pas précéder le début ou une date pour laquelle une facture a déjà été préparée. Le formulaire indique pourquoi et propose la première date possible.

La modification conserve la pause. Une planification qui demandait une vérification reste également en pause ; il faut la reprendre explicitement après contrôle.

Si la fin choisie précède la prochaine date, la planification sera terminée définitivement. Le formulaire l’explique avant le bouton **Enregistrer et terminer**. Les factures et leur état sont conservés. Pour une interruption temporaire, annulez puis utilisez **Mettre en pause**.

**Terminer définitivement** ouvre aussi une fenêtre de confirmation. Une planification terminée ne peut pas être réactivée.

## En cas d’erreur

La date saisie reste présente après un refus. Corrigez le point indiqué ou réessayez. Pendant l’enregistrement, les commandes sont verrouillées.

Si l’enregistrement a réussi mais que l’affichage n’a pas pu être actualisé, utilisez **Actualiser les données**. Cette action relit les informations sans répéter l’enregistrement.

## Validation du lot — code non distribué

- 36 tests d’interface : dates, calendrier, formulaires, états et appels au moteur.
- 6 tests du moteur natif : fins de mois, année bissextile, rattrapage limité, reprises, brouillons, pause et arrêt.
- 8 parcours Edge/WebKit dans chacun des deux dossiers de travail : 320×568, 390×844, 844×390 et 1440×900. Validation des dates, conservation de la saisie, double clic, échec de lecture puis reprise, retrait de la fin en pause, arrêt par date et conservation des factures existantes.
- 10 parcours de non-régression dans Edge sur la base de livraison : rattrapage de 20 dates en deux lots, plusieurs planifications, historique récent d’abord, pause/reprise, confirmation d’arrêt et ouverture du brouillon.
- TypeScript et Vite compilent. Les captures ont été inspectées. Données de recette uniquement ; aucun envoi de facture.

Recettes : `desktop/tests/recurrence-dates-journey.mjs` et `desktop/tests/recurrence-journey.mjs`. Les preuves locales sont dans `desktop/.qa/recurrence-dates/` et `desktop/.qa/recurrence/`.

Aucun nouvel installateur ni IPA n’est publié dans ce lot. La recette sur une application installée et la synchronisation entre appareils restent à vérifier.
