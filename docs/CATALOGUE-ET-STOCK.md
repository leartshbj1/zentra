# Produits et mouvements de stock

Dans **Produits & services**, chaque produit suivi affiche la quantité présente, les réservations des commandes et la quantité encore disponible. Les services restent sans stock.

## Ajouter ou modifier une référence

Le bouton **Nouvelle référence** se trouve dans la rubrique Produits & services. Choisissez **Service** pour une prestation ou **Produit** pour un bien. Renseignez le nom, l’unité et le prix de vente pour une unité, en CHF **hors TVA**. Les boutons heure, forfait, pièce, litre, etc. remplissent l’unité ; une unité personnalisée reste possible.

Le récapitulatif montre le prix hors TVA, la TVA ajoutée et le total pour une unité sans remise. Les taux proposés reprennent les réglages de l’entreprise. Un ancien taux reste affiché pour éviter de le remplacer silencieusement ; si l’entreprise est configurée comme non assujettie, choisissez 0 % avant d’enregistrer. Le libellé « aucune TVA ajoutée » ne détermine pas à lui seul la qualification fiscale de l’opération. Les taux légaux et leurs domaines d’application sont décrits par [l’AFC](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse).

**Référence, description et coût d’achat** regroupe les champs facultatifs. La description accepte les retours à la ligne et jusqu’à 10 000 caractères. Le coût est un repère interne ; un champ vide est enregistré à zéro. Il ne crée ni facture fournisseur ni TVA récupérable. Les prix acceptent un point ou une virgule et deux décimales au maximum ; une valeur incorrecte est expliquée au champ concerné au lieu d’être remplacée par zéro.

Pour un produit, **Suivre les quantités en stock** active ou conserve le suivi. Le seuil d’alerte compare les quantités disponibles après réservations. Zéro conserve l’alerte de rupture. Dès qu’un historique existe, le type et le suivi sont conservés ; une prestation distincte nécessite une nouvelle référence. Changer le libellé de l’unité ne convertit pas les quantités déjà enregistrées : conservez la même unité physique.

**Actualiser la fiche** relit ses données sans remplacer votre saisie. Si elle a changé, la comparaison affiche vos valeurs et les valeurs actuelles. **Conserver ma saisie** garde les champs que vous avez modifiés et reprend les changements indépendants des autres champs. **Utiliser les valeurs actuelles** reprend toute la fiche relue. Ces choix ne sauvegardent rien : vérifiez puis enregistrez. Le moteur natif compare également la version dans la transaction ; deux modifications fondées sur la même version ne peuvent pas toutes deux l’écraser.

Une réponse perdue est vérifiée par relecture. Après acquittement, une lecture interrompue, une configuration vide ou une référence absente garde la reprise ouverte. Les reprises n’envoient pas de nouvelle création ou modification et restent accessibles en lecture seule. Les saisies non enregistrées sont conservées tant que le formulaire est ouvert ; elles ne constituent pas un brouillon persistant après fermeture de l’application. La nouvelle fiche guidée et sa commande de modification sont incluses dans Windows 1.60.0.

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

Ce parcours et la commande native de comptage sont inclus dans la préversion Windows 1.60.0. Consultez [la note de livraison](RELEASE-WINDOWS-1.60.0.md) pour ses contrôles et leurs limites.
