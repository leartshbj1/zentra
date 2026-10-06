# Mise en service des paiements directs suisses

Le code est préparé pour TWINT et PostFinance Pay via PostFinance Checkout.
Les réglages marchands ne sont pas activés sur le site. Le compte Stripe déjà
consulté permet TWINT via Stripe ; cette capacité ne configure pas PostFinance.

## Prérequis marchands

1. Disposer d'un compte PostFinance Checkout et d'un Space de production avec
   les contrats d'acceptation des moyens de paiement souhaités. Confirmer que
   l'offre et chaque connecteur acceptent les abonnements et leurs tokens.
2. Vérifier les frais et conditions avant de signer une offre. Une inscription
   gratuite en simulation n'autorise pas un encaissement réel.
3. Configurer les identifiants et secrets uniquement dans le gestionnaire des
   variables de déploiement. Ne pas les mettre dans le navigateur, un rapport,
   un dépôt, un fichier d'exemple ou une commande affichée.
4. Fournir un catalogue CHF/P1M qui correspond exactement aux produits et prix
   Zentra, avec les identifiants de méthodes et connecteurs du bon Space.
5. Vérifier la signature et le routage des webhooks et la lecture des preuves
   de règlement. Un retour du navigateur ne vaut jamais confirmation de paiement.

## Contrôles avant ouverture

Le mode TEST exige un compte confirmé et une liste autorisée. Il n'accorde
aucun droit de production. Tester les quatre familles Gestion, Support,
Automation et Complet, puis vérifier sur le compte marchand réel un règlement,
le token consenti, un renouvellement, une annulation et un remboursement.
Les essais locaux avec réponses fictives ne remplacent pas ces opérations.

Les achats nécessitent `POSTFINANCE_PURCHASES_ENABLED=true`. PRODUCTION
nécessite séparément `POSTFINANCE_PRODUCTION_ENABLED=true`, l'approbation
marchande, les connecteurs et les preuves de règlement validées. Activer les
observations, rapprochements, récupérations et workers seulement après leurs
vérifications respectives. Aucun interrupteur n'est activé par ce document.

Une ancienne tentative garde son identifiant et sa méthode. Elle reste
consultable quand les réglages changent ; sa récupération utilise uniquement
des lectures de la transaction d'origine. Ne jamais vider les journaux ou
relancer CREATE pour contourner une réponse incertaine.

## Documentation officielle

- [Compte, Space, contrats, simulation et activation](https://www.postfinance.ch/fr/assistance/paiements/transactions/questions-sur-les-solutions-de-check-out.html)
- [API et documentation Checkout](https://checkout.postfinance.ch/doc)

État documenté le 7 octobre 2026 : huit interrupteurs absents dans le déploiement
consulté, révision 41 ; aucune opération marchande réelle effectuée.
