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
| Connexion depuis le paquet Windows 1.44 | Bouton visible, création réelle d'un code d'appareil, attente d'approbation et page de validation accessibles, déconnexion locale vérifiée | Approbation complète d'un compte abonné non testée |
| Paiement et accès collaborateurs | Tests des montants imposés par le serveur, droits issus de factures payées, invitations atomiques et refus des dépassements | Le parcours combiné Checkout payé → webhook → rattachement du compte → approbation native → invitation n'est pas encore démontré avec Stripe |
| E-mails Supabase | Tableau de bord : transport par défaut, invite à configurer SMTP ; intégration Resend préparée | Domaine à fournir par le propriétaire, SMTP personnalisé non activé |

Rapports locaux, exclus de Git : `.qa/goal-completion/public-plans.json`, `.qa/goal-completion/targeted-tests.log`, `.qa/goal-completion/live-catalog.json`, `.qa/pricing144/auth-browser-report.json`, `.qa/pricing144/auth-live-report.json`, `.qa/pricing144/native-account.json`, `.qa/pricing144/site-ui/report.json`.

## Travail restant avant ouverture publique

1. Recevoir le domaine d'envoi, vérifier ses DNS et activer Resend pour Supabase conformément à [EMAIL-AUTH.md](EMAIL-AUTH.md). Tester la réception et l'utilisation des liens d'inscription, d'invitation et de mot de passe oublié.
2. Terminer le parcours combiné en sandbox avec un compte propriétaire autorisé et des moyens de paiement Stripe de test. Vérifier le titulaire, les collaborateurs, le quota, le refus d'un accès supplémentaire et l'approbation native. Ne pas utiliser de paiement réel pour cette recette.
3. Recevoir le statut TVA du marchand et terminer les réglages de facturation correspondants. Configurer ensemble les prix live, la clé live, le portail et le webhook du même compte ; vérifier la livraison signée avant ouverture de Checkout. Suivre [STRIPE-INTEGRATION.md](STRIPE-INTEGRATION.md), y compris le traitement des anciens abonnements.
4. Recontrôler `/api/stripe/status?plan=solo`, `start` et `pro` ainsi que les parcours accessibles aux clients après bascule. Ne pas annoncer l'activation commerciale sur la seule base du catalogue ou de tests unitaires.

Références : [séparation des données Stripe de test et de production](https://docs.stripe.com/keys), [moyens de paiement de test Stripe](https://docs.stripe.com/testing), [restrictions du transport SMTP intégré Supabase](https://supabase.com/docs/guides/auth/auth-smtp).
