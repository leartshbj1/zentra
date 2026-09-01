# Intégration Stripe Elyko

Ce plan a été produit avec le planificateur d’implémentation Stripe officiel pour Elyko, logiciel de comptabilité Windows vendu 50 CHF par mois. L’ordre obligatoire est sandbox, recette complète, puis production.

## Architecture retenue

1. Le site demande au serveur une Session Stripe Checkout hébergée en mode `subscription`.
2. Le serveur impose un Price stable, une quantité de 1, CHF 50 par mois, Stripe Tax, l’adresse de facturation, le nom et l’identifiant fiscal.
3. Stripe Billing crée l’abonnement et les factures récurrentes. La page de succès ne sert jamais de preuve de paiement.
4. Le webhook vérifie la signature du corps brut et traite les événements de manière idempotente dans D1.
5. Seule une facture `paid`, Tax complète, contenant l’unique ligne non proratisée du Price Elyko peut avancer la période payée.
6. Le serveur signe une licence courte Ed25519 liée à l’installation Windows. Les données comptables du client restent dans son SQLite local.
7. Le portail Stripe présente l’historique des factures, permet de remplacer le moyen de paiement et de résilier à la fin de la période.

## Configuration sandbox

Ne jamais réutiliser une clé secrète copiée dans une conversation, un ticket, un dépôt ou une capture. La révoquer dans Stripe, créer une nouvelle clé de sandbox et la saisir uniquement comme secret d’hébergement.

Créer dans le même environnement Stripe :

- un Product actif « Elyko — licence Windows »;
- un Price actif `CHF 50.00`, récurrent chaque mois, quantité/licence unitaire, `tax_behavior=inclusive`;
- un code fiscal produit explicite adapté au logiciel téléchargeable pour entreprise, à faire valider par la fiduciaire avant production;
- Stripe Tax actif, siège fiscal complet et enregistrements fiscaux appropriés;
- le portail client par défaut actif, avec connexion de récupération par e-mail, historique des factures, changement du moyen de paiement et résiliation `at_period_end`;
- un endpoint webhook vers `https://elyko.alb-leart1.chatgpt.site/api/stripe/webhook`, version `2026-02-25.clover`.

Événements à envoyer au webhook :

- `checkout.session.completed`;
- `checkout.session.async_payment_succeeded` si un moyen asynchrone est autorisé;
- `invoice.paid`;
- `invoice.payment_failed`;
- `invoice.finalization_failed`;
- `customer.subscription.updated`;
- `customer.subscription.deleted`.

Variables serveur :

| Variable                           | Type     | Usage                                                     |
| ---------------------------------- | -------- | --------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                | secret   | clé serveur sandbox ou live, jamais exposée au navigateur |
| `STRIPE_WEBHOOK_SECRET`            | secret   | secret `whsec_` de cet endpoint et de ce mode             |
| `STRIPE_PRICE_ID`                  | variable | Price mensuel Elyko stable                                |
| `LICENSE_SIGNING_KEY_PKCS8_B64URL` | secret   | clé privée Ed25519 correspondant à l’EXE                  |
| `PUBLIC_SITE_URL`                  | variable | `https://elyko.alb-leart1.chatgpt.site`                   |

La clé publiable `pk_` n’est pas nécessaire au Checkout hébergé actuel : la Session est créée côté serveur puis le navigateur est redirigé vers l’URL Stripe.

## Contrôle de préparation

`/api/stripe/status` ne renvoie `ready: true` qu’après vérification réelle de :

- la forme et le mode des identifiants Stripe;
- le Price actif CHF 50/mois, taxe comprise, et son Product actif avec code fiscal;
- Stripe Tax actif dans le même mode;
- la configuration par défaut du portail client;
- la paire de clés Ed25519 serveur/EXE;
- toutes les tables et colonnes D1 requises;
- l’origine publique HTTPS exacte.

Le même contrôle est rejoué juste avant de créer Checkout afin de ne jamais encaisser si Elyko ne peut pas ensuite émettre la licence.

## Recette obligatoire

Exécuter dans une sandbox isolée, avec Stripe Test Clocks lorsque le scénario est temporel :

1. Checkout initial payé : facture Tax correcte, enregistrement D1 et licence installable.
2. Deuxième livraison du même webhook, y compris concurrente : aucun double traitement.
3. Renouvellement payé : la licence avance jusqu’à la période exacte de la nouvelle ligne de facture.
4. Ancienne facture livrée après la nouvelle : aucune régression ni extension vers une période non payée.
5. Paiement échoué et finalisation Tax échouée : aucune extension; portail utilisable pour régulariser.
6. Paiement récupéré après échec : l’échec actif est effacé et la période payée avance une seule fois.
7. Résiliation dans le portail : accès conservé jusqu’à la fin déjà payée, puis aucun renouvellement.
8. Activation tardive : une ancienne Session Checkout utilise le dernier droit payé stocké, jamais le `current_period_end` courant.
9. Corps webhook altéré, timestamp expiré, mauvais mode et mauvaise version API : rejet systématique.
10. Bascule production : recréer Product, Price, portail, endpoint et secrets dans le mode live; ne jamais mélanger les identifiants test/live.

## Exploitation

- Activer les Smart Retries et les e-mails Stripe de paiement échoué.
- Surveiller `invoice.finalization_failed`, notamment `requires_location_inputs` et `failed` pour Stripe Tax.
- Réconcilier régulièrement les factures Stripe payées avec les droits D1.
- Définir avant production la politique explicite pour remboursement, avoir et litige. Un remboursement ne doit pas modifier silencieusement une période de licence sans décision métier auditée.
- Faire valider les obligations fiscales, les enregistrements et le code fiscal produit par une fiduciaire; Stripe Tax calcule et trace, mais ne décide pas seul de l’obligation d’immatriculation.
