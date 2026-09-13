# Produits et mouvements de stock

Dans **Produits & services**, chaque produit suivi affiche la quantité présente, les réservations des commandes et la quantité encore disponible. Les services restent sans stock.

## Enregistrer une arrivée ou une sortie

1. Sur le produit, choisissez **Entrée** ou **Sortie**.
2. Indiquez la quantité, la date et le motif. Vous pouvez choisir un motif habituel, puis le compléter. La référence d’un justificatif est facultative.
3. Choisissez **Vérifier le mouvement**. Rien n’est enregistré à cette étape.
4. Relisez le récapitulatif, puis confirmez l’entrée ou la sortie. **Modifier ma saisie** retourne au formulaire.

Une quantité accepte jusqu’à trois décimales, avec une virgule ou un point. Pour un produit nouvellement créé à zéro, une **Entrée → Stock de départ** permet de renseigner la quantité initiale. Les réceptions fournisseurs et livraisons déjà enregistrées dans leurs écrans ont déjà modifié le stock : ne les ressaisissez pas ici.

## Faire un inventaire

Choisissez **Inventaire**, puis renseignez la **Quantité réellement comptée**. Par exemple, si Zentra affiche 10 litres et que vous en comptez 8,125, saisissez **8,125** ; l’application enregistre la différence de −1,875 litre. Aucun calcul de différence à faire vous-même.

Une quantité identique au stock affiché ne crée pas de mouvement. Un comptage à zéro est possible si aucune quantité n’est réservée. Pour saisir une différence directement, choisissez **Écart (+ ou −)**. Les deux méthodes conservent chacune leur quantité tant que le formulaire reste ouvert.

**Actualiser les quantités** relit le produit sans changer la saisie. Si le stock a changé depuis le début du comptage, l’application indique l’ancienne quantité et la nouvelle. **Utiliser le stock actuel** prépare une nouvelle vérification ; il faut encore confirmer le mouvement. Le contrôle se fait également dans la même transaction que l’enregistrement, pour éviter deux corrections simultanées sur une ancienne quantité.

## Corriger un problème

- Une quantité, date, référence ou un motif incorrect est expliqué près du champ concerné. Les autres informations restent présentes.
- Les quantités réservées à des commandes ne peuvent pas être retirées par une sortie manuelle ou un inventaire. Vérifiez la saisie et les réservations dans **Commandes clients** avant de reprendre le comptage.
- Un produit disparu, archivé ou sans suivi de stock ne peut pas recevoir de nouveau mouvement. **Revenir au catalogue** permet de consulter sa fiche.
- Pendant l’enregistrement, les modifications, la fermeture et les doubles validations sont bloquées.

Si la réponse est perdue, **Vérifier l’enregistrement** recherche le mouvement exact dans l’historique. Si l’enregistrement est confirmé mais la relecture échoue, **Enregistrement effectué → Actualiser les données** permet de terminer la lecture. Ces reprises ne renvoient aucune entrée, sortie ou correction. Elles restent accessibles en lecture seule. La reprise conserve le formulaire jusqu’à ce que le résultat soit vérifiable ; les saisies non enregistrées ne sont pas sauvegardées comme brouillons après fermeture de l’application.

## Retrouver un mouvement

Le bouton **Historique** affiche les mouvements du plus récent au plus ancien, leur date, leur motif, la référence éventuelle et la quantité après chacun d’eux. Une ligne enregistrée reste conservée : une nouvelle correction rectifie le stock sans effacer l’ancienne explication.

Ces opérations modifient les quantités du catalogue. Elles ne créent pas de facture fournisseur ni d’écriture de valorisation de stock.

Ce parcours est ajouté au code après Windows 1.59.0. Il nécessite un nouveau programme natif pour la commande de comptage ; aucun nouvel installateur ou IPA n’est publié avec ce lot.
