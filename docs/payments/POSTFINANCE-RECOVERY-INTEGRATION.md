# Paiements suisses — état de l’intégration

État du 7 octobre 2026. Ce document distingue la préparation du code de
l’activation d’un compte marchand. Les rapports précédents décrivent leur
assemblage et leur date ; leurs mentions « recovery interne non appelée » ne
décrivent plus le parcours initial actuellement intégré.

## Stripe et TWINT

Une lecture du compte marchand suisse confirme que les encaissements sont
autorisés, que la capacité TWINT est active et que la configuration de paiement
par défaut l’affiche. L’identifiant et l’adresse du webhook correspondent aux
réglages du site publié. Les prix actuellement consultés sont actifs, en CHF et
mensuels. Aucun secret n’a été extrait et aucun paiement n’a été exécuté.

La dernière session existante consultée pour Gestion Pro inclut TWINT parmi
ses moyens de paiement. Elle est expirée et impayée : cette observation prouve
son admissibilité dans Checkout, pas un encaissement, un mandat ni un
renouvellement réussi. Les anciennes sessions gardent leurs réglages historiques.

Les quatre constructeurs Gestion, Support, Automation et Complet utilisent des
moyens de paiement dynamiques et le mode de facturation flexible. La revue de
leur code ne remplace pas un paiement complet pour chaque produit.

## TWINT et PostFinance Pay via PostFinance Checkout

Le choix direct est issu exclusivement des méthodes configurées et autorisées
par le serveur. Le mode TEST conserve un compte confirmé et une liste privée
autorisée. Le parcours PRODUCTION exige en plus
`POSTFINANCE_PRODUCTION_ENABLED=true`, une configuration marchande validée et
les preuves de règlement requises. Cet interrupteur est absent par défaut.
Il ne suffit pas de montrer un bouton pour accepter un paiement marchand réel.

Une tentative conserve un seul identifiant, sa méthode, sa cible et le contexte
serveur affiché avant l'achat. L'empreinte du contexte lie le compte, le produit,
l'environnement et les réglages marchands publics ; elle exclut les secrets.
Le serveur la recalcule avant toute préparation ou tout envoi financier.
Une page TEST ouverte avant un passage à PRODUCTION ne peut donc pas déclencher
un paiement réel. Les erreurs 400 et 409 ne remplacent pas l'identifiant.

Les anciens journaux contenant seulement un UUID restent des tentatives
PostFinance Pay. Les anciens journaux sans contexte restent consultables
uniquement en lecture. Un changement de configuration ne leur ajoute pas
silencieusement le contexte actuel. Les reçus historiques restent accessibles
au propriétaire indépendamment de la configuration courante. Une récupération
doit correspondre à l'environnement, l'origine API et au Space d'origine.

La récupération initiale et la récupération des renouvellements retrouvent
une opération CREATE déjà tentée par des lectures fournisseur stables. Elles ne
renvoient pas CREATE, ne réinitialisent pas un claim incertain et n’activent
aucun droit. La liaison retrouvée alimente une observation durable distincte ;
seules les preuves exactes de règlement permettent ensuite l’activation.

Les renouvellements utilisent leur propre file de reprise, distincte des baux
de nouvelle facturation. Une annulation ou une période dépassée peut encore
nécessiter de retrouver une ancienne opération ; cela n’autorise pas un nouveau
débit. Le contrat sélectionné pour un renouvellement normal est exclu de la
reprise pendant cette invocation. Un paiement PENDING retrouvé ne déclenche
pas ChargeFlow pendant la même invocation. Huit échecs terminent la reprise.

## Activation encore nécessaire

Les huit interrupteurs PostFinance restent absents, donc désactivés, dans la
configuration de production consultée (révision 41), y compris
`POSTFINANCE_PRODUCTION_ENABLED` et la récupération des renouvellements.
Leur déclaration ne leur attribue aucune valeur et n'active rien. Les
identifiants, connecteurs, autorisations de token et preuves de règlement d'un
compte marchand réel doivent encore être vérifiés avant l'activation des
achats, workers et rapprochements. Le code sait désormais accepter PRODUCTION
derrière ces contrôles ; aucun compte marchand n'a été activé par cette
publication. La procédure est décrite dans [POSTFINANCE-LAUNCH.md](POSTFINANCE-LAUNCH.md).

Les essais SQLite et D1 utilisent une vraie base locale avec des réponses
fournisseur fictives. Ils couvrent les courses, reprises, bornes et protections
de droits ; ils ne constituent pas des règlements bancaires réels. Les secrets,
objets fournisseur complets et données salariales ne doivent pas être ajoutés
aux journaux ou aux rapports de livraison.

La migration 0084 ajoute une seule table de récupération, son index et quatre
gardes SQL. Les 135 tables précédentes et les migrations 0000 à 0083 restent
inchangées. Drizzle a généré le nouveau snapshot et l’ajout au journal ; la
migration conserve les six instructions relues, avec uniquement une
normalisation des espaces SQL hors des chaînes et identifiants entre guillemets.
