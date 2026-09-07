# Formules et comptes — état vérifié le 7 septembre 2026

Les trois formules sont présentes dans le site et dans Zentra depuis 1.44.0. La version publiée est 1.45.0. Le catalogue Stripe de production a été préparé, mais les paiements publics restent fermés : le serveur utilise toujours la sandbox privée du propriétaire. La réception des e-mails de confirmation et de récupération reste à vérifier après configuration du domaine d'envoi.

## Contrat des formules

| Formule | Prix mensuel | Personnes pouvant se connecter |
| --- | --- | --- |
| Solo | 49 CHF | 1 |
| Start | 59 CHF | 3 |
| Pro | 89 CHF | 10 |

Le titulaire compte dans ce total. Les invitations en attente réservent une place. Une personne peut utiliser plusieurs appareils. Les fiches de salariés de la paie ne consomment pas de place. Toutes les fonctionnalités actuelles et futures sont incluses dans chaque formule. Les abonnements historiques à 50 CHF conservent leur contrat ; aucune migration automatique n'a été réalisée.

## Catalogue Stripe de production préparé

Compte marchand **Elyko**, `acct_1UAaBrRTk1mJWGz3`, mode **live**. Produits et prix lus dans le tableau de bord Stripe après création le 7 septembre. Les trois prix sont actifs, fixes, en CHF, mensuels, par défaut pour leur produit et avec `tax_behavior=inclusive`. Chaque prix affichait zéro abonnement actif au contrôle.

| Variable de déploiement | Product live | Price live |
| --- | --- | --- |
| `STRIPE_PRICE_SOLO_ID` | `prod_VDIbp28gbmiBfm` | `price_1UCs0eRTk1mJWGz3FTvA3LSs` |
| `STRIPE_PRICE_START_ID` | `prod_VDIdfwyVTzuhUf` | `price_1UCs2ORTk1mJWGz3lLXWF3s5` |
| `STRIPE_PRICE_PRO_ID` | `prod_VDIgM8nm6ecy7a` | `price_1UCs4gRTk1mJWGz3zsOIkqOL` |

Le code produit `txcd_10000000` reprend la catégorie déjà utilisée dans ce compte marchand. Ce choix de catalogue ne confirme ni l'assujettissement ni les obligations fiscales de l'entreprise. Le propriétaire doit préciser son statut TVA avant activation ; aucune immatriculation fiscale n'a été ajoutée.

Le produit historique live `prod_VAwCw8J8LkrEOo` et son prix mensuel de 50 CHF `price_1UAaJqRTk1mJWGz3sEv1czCO` ont uniquement été consultés et restent inchangés. Le comportement fiscal de ce prix historique n'a pas été contrôlé lors de cette passe.

Ces identifiants live **ne sont pas installés dans l'environnement public**. Aucune clé live n'a été manipulée, aucun paiement ni abonnement réel n'a été créé pour ce contrôle.

## Sandbox actuellement déployée

Compte de test distinct : `acct_1UAaBzRBjxA0A8ve`. Ne pas mélanger ses identifiants avec ceux du compte live.

| Formule | Product sandbox | Price sandbox |
| --- | --- | --- |
| Solo | `prod_VDG6mC3ejnCJB2` | `price_1UCpajRBjxA0A8veW89PiG7H` |
| Start | `prod_VDGEEKg4EnNhro` | `price_1UCpiLRBjxA0A8veTBDERJNE` |
| Pro | `prod_VDGTb3Mq5xUyil` | `price_1UCpwNRBjxA0A8veIrqm4v7Z` |

La révision d'environnement 22 conserve ces trois prix de test, la clé de test et `STRIPE_TEST_MODE=owner_only`. Le 7 septembre, le site public renvoie les bons montants et quotas pour les trois formules ; un visiteur non connecté reçoit `ready:false`, `testMode:true`, `authenticated:false`, `accessRestricted:true`. Ce résultat confirme la fermeture publique, pas la disponibilité de Checkout pour un propriétaire connecté.

## Preuves et limites

| Parcours | Preuve disponible | Limite |
| --- | --- | --- |
| Prix, quotas, invitations, droits et sessions | 51 tests ciblés réussis sur la source `538bc200dc965beb147947cff8e95441e8c5d7ee` ; transactions sur SQLite avec les migrations D1 pour les tests d'équipe | Les appels Stripe des tests automatisés sont simulés |
| Connexion par le formulaire publié | 15 contrôles réussis avec une identité Supabase temporaire : mauvais mot de passe refusé, session protégée, renouvellement, changement de mot de passe, déconnexion et nettoyage | Pas de réception d'e-mail testée |
| Comptes personnels distincts | Connexion de deux identités Supabase temporaires, renouvellement et révocation globale vérifiés ; comptes supprimés | Ces identités ont été préparées par l'administration de test, sans parcours de confirmation par e-mail |
| Interface mobile et bureau | 24 contrôles Edge/WebKit, largeurs 320, 390 et 1440, pages tarifs, connexion et mots de passe | Ne prouve pas l'approbation d'un appareil natif |
| Connexion depuis le paquet Windows 1.45 | Des installations isolées ont accepté les licences Solo, Start et Pro signées après approbation du titulaire. Une autre installation a validé l'accès Start d'un collaborateur et conservé sa connexion personnelle et sa licence après redémarrage | Contrôle sur Windows ; ne prouve pas ce parcours complet sur un téléphone physique |
| Paiement et accès collaborateurs | Checkout sandbox à 49, 59 et 89 CHF, événements `checkout.session.completed` et `invoice.paid` traités dans D1, association des trois entreprises et licences Windows valides avec la bonne formule. Sur Start : invitation nominative, connexion Supabase et approbation native du collaborateur | Titulaire connecté via son accès Sites existant ; identité Supabase du collaborateur préparée sans envoi d'e-mail |
| Quotas Solo et Pro après paiement | Solo affiche 1/1, titulaire compris, et désactive la création d'invitation. Pro affiche 1/10 et neuf places disponibles. D1 conserve respectivement les limites 1 et 10 | La saturation à dix personnes et les courses concurrentes sont couvertes par les tests SQLite, sans créer dix identités externes pour cette recette |
| Indication de connexion dans le menu | Le menu utilise désormais la même identité que les pages du compte, y compris l'accès Sites existant. 13 tests du parcours d'authentification réussissent, dont le renouvellement personnel, le refus d'une substitution d'identité et la distinction avec le formulaire de connexion Supabase | Aucun changement du fournisseur utilisé par le formulaire de connexion personnel |
| Limite et révocation réelles | Une invitation réserve la troisième place ; une quatrième personne est refusée par le serveur depuis un onglet conservant un ancien quota. Le retrait du membre révoque sa session ; Windows se déconnecte et passe en lecture seule au contrôle suivant | La révocation immédiate nécessite une connexion au serveur ; un appareil hors ligne conserve les limites de son bail signé |
| E-mails Supabase | Tableau de bord : transport par défaut, invite à configurer SMTP ; intégration Resend préparée | Domaine à fournir par le propriétaire, SMTP personnalisé non activé |

Rapports locaux, exclus de Git : `.qa/goal-completion/public-plans.json`, `.qa/goal-completion/targeted-tests.log`, `.qa/goal-completion/live-catalog.json`, `.qa/goal-completion/native-owner-approved.json`, `.qa/goal-completion/native-collaborator-approved.json`, `.qa/goal-completion/native-collaborator-revoked.json`, `.qa/goal-completion/start-e2e.json`, `.qa/pricing144/auth-browser-report.json`, `.qa/pricing144/auth-live-report.json`, `.qa/pricing144/native-account.json`, `.qa/pricing144/site-ui/report.json`.

La recette Start a utilisé uniquement la carte fictive de Stripe, sans débit réel. Le compte Supabase temporaire a été supprimé après révocation du membre et de sa session. Les processus Windows isolés sont arrêtés. L'abonnement de test a été annulé et son événement `customer.subscription.deleted` a été traité dans D1. L'entreprise et la facture de test conservent une trace de cette recette ; leur présence ne représente pas un abonnement client réel. Le nettoyage restant est suivi dans le rapport local `start-e2e.json`.

Deux libellés issus de cette recette ont été corrigés : l'invitation parle du compte personnel utilisé pour se connecter, et l'autorisation parle d'un appareil afin d'inclure les téléphones.

La recette complémentaire Solo/Pro est conservée dans `.qa/goal-completion/solo-pro-e2e.json`, avec les preuves Windows dans `native-solo/approved.json` et `native-pro/approved.json` sous ce même dossier. Les deux abonnements de test sont annulés ; leurs événements d'annulation sont traités dans D1. Les deux sessions d'appareils ont été révoquées par la déconnexion normale de l'application et les processus isolés sont arrêtés.

## Travail restant avant ouverture publique

1. Recevoir le domaine d'envoi, vérifier ses DNS et activer Resend pour Supabase conformément à [EMAIL-AUTH.md](EMAIL-AUTH.md). Tester la réception et l'utilisation des liens d'inscription, d'invitation et de mot de passe oublié.
2. Étendre la recette à un titulaire utilisant sa connexion Supabase. Les Checkout Solo, Start et Pro jusqu'à leur licence Windows sont vérifiés avec l'accès Sites du titulaire. Ne pas utiliser de paiement réel pour cette recette.
3. Recevoir le statut TVA du marchand et terminer les réglages de facturation correspondants. Configurer ensemble les prix live, la clé live, le portail et le webhook du même compte ; vérifier la livraison signée avant ouverture de Checkout. Suivre [STRIPE-INTEGRATION.md](STRIPE-INTEGRATION.md), y compris le traitement des anciens abonnements.
4. Recontrôler `/api/stripe/status?plan=solo`, `start` et `pro` ainsi que les parcours accessibles aux clients après bascule. Ne pas annoncer l'activation commerciale sur la seule base du catalogue ou de tests unitaires.

Références : [séparation des données Stripe de test et de production](https://docs.stripe.com/keys), [moyens de paiement de test Stripe](https://docs.stripe.com/testing), [restrictions du transport SMTP intégré Supabase](https://supabase.com/docs/guides/auth/auth-smtp).
