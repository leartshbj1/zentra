# Paiements suisses — état de l’intégration

État du 6 octobre 2026. Ce document distingue la préparation du code de
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
par le serveur. Le parcours public reste limité au TEST privé, avec compte
confirmé et liste autorisée. Il ne suffit pas de montrer un bouton pour accepter
un paiement marchand réel.

Une tentative conserve un seul identifiant, sa méthode et sa cible. Les anciens
journaux contenant seulement un UUID restent des tentatives PostFinance Pay.
Si une méthode disparaît, la vérification en lecture seule demeure possible,
mais une reprise financière avec une autre méthode est refusée.

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

Les interrupteurs PostFinance restent absents, donc désactivés, dans la
configuration de production consultée (révision 41), y compris le nouvel
interrupteur de récupération des renouvellements. La déclaration
`POSTFINANCE_RENEWAL_CREATE_RECOVERY_ENABLED` n’attribue aucune valeur et
n’active rien. Les identifiants, connecteurs, autorisations de token et preuves
de règlement d’un compte marchand réel doivent encore être vérifiés avant
l’activation des achats, workers et rapprochements. Le parcours public direct
refuse encore PRODUCTION : les seuls réglages ne suffisent pas à l’ouvrir.
Après validation marchande et vrais essais de règlement, mandat, renouvellement
et remboursement, il faudra lever explicitement ces barrières de TEST.

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
