# Adaptateur PostFinance Checkout / Wallee

Module serveur préparé, sans SDK et sans dépendance runtime. La réception signée `/api/payments/postfinance/webhook` est raccordée à l'inbox D1 ; aucune route d'achat ne l'utilise encore. Aucun compte marchand n'existe encore : conserver `enabled: false` pour les achats et laisser `POSTFINANCE_WEBHOOKS_ENABLED` absent ou différent de `true`. Les tests utilisent exclusivement un `fetch` simulé et des clés publiques de test. Ce résultat n'est pas une validation en production.

## Protocole vérifié le 6 octobre 2026

Sources officielles : [SDK PostFinance](https://github.com/pfpayments/typescript-sdk/tree/bb1e4c34ffa44bc1da8f54c86f984961aa886c30), [auth JWT](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/auth/HttpBearerAuth.ts), [SubscriptionsService](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/services/SubscriptionsService.ts), [modèle de création](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/models/SubscriptionCreateRequest.ts), [page de paiement](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/services/TransactionsService.ts), [clés de webhook](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/services/WebhookEncryptionKeysService.ts).

API v2 : `Authorization: Bearer <JWT HS256>`, en-tête JWT `{alg: HS256, typ: JWT, ver: 1}`, claims `sub`, `iat` en secondes, `requestPath` incluant `/api/v2.0`, `requestMethod`. Clé marchande Base64 de 32 octets. `Space` est un en-tête, pas un paramètre `spaceId`. Le protocole officiel ne signe ni le corps ni `Space` dans le JWT ; HTTPS et les permissions de l'utilisateur d'application restent nécessaires. Ne pas ajouter un protocole x-mac v1 ou un `Idempotency-Key` inventé.

Chemins utilisés :

- `POST /api/v2.0/subscriptions/subscribers`
- `POST /api/v2.0/subscriptions`
- `POST /api/v2.0/subscriptions/{id}/initialize-subscriber-present`
- `GET /api/v2.0/subscriptions/{id}`
- `GET /api/v2.0/payment/transactions/{id}/payment-page-url`
- `GET /api/v2.0/webhooks/encryption-keys/{keyId}` (sans `Space`, comme le SDK).

La création retourne une **SubscriptionVersion** : récupérer `response.subscription.id`, puis `initializeResponse.transaction.id`. L'ID de version n'est pas l'ID de l'abonnement. Les relations `product` et `subscription.subscriber` sont des IDs scalaires. `subscription.version` est obligatoire dans le modèle actuel : le propriétaire doit fournir la valeur attendue par le compte/API, à confirmer dans un essai de simulation ; l'asset n'invente pas une valeur par défaut. Le tarif et le cycle sont définis dans le produit du portail, pas par un montant transmis au client.

Ces opérations Subscriptions restent séparées du parcours prépayé retenu ci-dessous ; elles ne constituent pas le futur moteur de mensualités Zentra.

L'argument `method` du client applique une garde locale ; il ne sélectionne pas le moyen de paiement dans un champ API. Le choix et les moyens proposés par la page hébergée dépendent du produit/Space du marchand. Vérifier cette configuration en simulation avant de promettre une page dédiée exclusivement à PostFinance Pay ou TWINT.

## Configuration humaine nécessaire

1. Compte Checkout, contrat PSP/acquisition, KYC validé et versement configuré.
2. PostFinance Pay **token/on-file** activé. Pour TWINT, **User-on-File** activé. [TWINT](https://www.twint.ch/en/business-customers/products/twint-for-online-shops/automated-payments/) ; [PostFinance Pay](https://www.postfinance.ch/en/business/products/payment-collection/payment-solutions/postfinance-pay.html).
3. Fonction Subscriptions et **Charge Flow** activés, au moins un flux configuré. [Documentation](https://checkout.postfinance.ch/en-us/doc/subscription/overview).
4. Produit confirmé à **CHF, cycle mensuel**, prix et composants correspondant au plan Zentra ; moyens acceptés permettant le paiement sans carte. Les métadonnées `billingPeriod` et `priceChfMinor` sont des gardes locales, pas des champs API ni une preuve distante du tarif. Les vérifier contre le produit du portail et l'abonnement simulé.
5. Utilisateur d'application avec permissions minimales pour abonné, abonnement, page de paiement, lectures et clé de signature. Configurer côté serveur `applicationUserId`, `authenticationKeyBase64` comme secret Cloudflare, `spaceId`, `returnOrigin`, IDs produits et listeners. Aucun secret dans le navigateur, git ou logs.
6. N'activer les indicateurs de l'asset qu'après les vérifications correspondantes. Au départ tous absents/faux et `enabled: false`. Un paramètre de navigateur ne peut définir ces indicateurs ou le catalogue.

## Journaux durables D1

`postfinance-store.ts` implémente les deux interfaces avec les tables de la migration additive `0072_melodic_tinkerer.sql`. L'inbox est reliée à la réception signée ; le journal de mutations n'est pas encore raccordé aux achats, et le worker de rapprochement reste à implémenter. Cette réception n'active donc pas les achats PostFinance et ne crée aucun droit d'accès.

- `D1PostFinanceMutationLedger` réserve par insertion atomique, conserve le fingerprint et le résultat, et autorise uniquement le propriétaire de la réservation à terminer l'opération. Après un arrêt ou un résultat ambigu, la réservation ne peut jamais expirer ni être volée pour répéter le POST. Le résultat d'une opération terminée est rejoué sans appel fournisseur ; un autre corps est refusé.
- `D1PostFinanceWebhookInbox` persiste la réception et le travail dans une seule ligne. Son périmètre inclut l'origine API, le Space et les listeners configurés avec leur type d'entité. Un même événement reçu à nouveau ne crée aucun travail ; un contenu différent sous le même ID est refusé. Les champs non reconnus ne sont pas stockés.
- Un worker de rapprochement peut réserver un travail pendant cinq minutes, reprendre une lecture après expiration de sa lease, terminer ou demander une nouvelle tentative avec un code d'erreur sans donnée sensible. L'ancien propriétaire ne peut plus terminer le travail repris. Après huit essais, l'état `failed` reste visible pour une intervention, sans boucle infinie. Une lease n'est pas une garantie d'effet métier unique : les futurs droits doivent avoir leurs propres preuves et transactions idempotentes.

Les scopes sont stockés sous forme d'empreinte SHA-256, jamais écrits dans des logs. Les réponses fournisseur nécessaires au rejeu restent des données serveur protégées ; aucune route ne les expose. Ne pas supprimer une réservation incertaine ou terminée pour permettre un nouveau débit. Sa résolution exige un rapprochement explicite avec le prestataire, encore à implémenter.

## Réception HTTP signée

La route POST `/api/payments/postfinance/webhook` lit uniquement les bindings serveur suivants : `POSTFINANCE_WEBHOOKS_ENABLED`, `POSTFINANCE_API_ORIGIN`, `POSTFINANCE_APPLICATION_USER_ID`, `POSTFINANCE_AUTHENTICATION_KEY_BASE64`, `POSTFINANCE_SPACE_ID`, `POSTFINANCE_WEBHOOK_LISTENERS_JSON`. La liste JSON comporte uniquement des objets `{id, entityId, technicalName?}` provenant de la configuration réelle du portail. L'ID du type d'entité est distinct de l'ID de la transaction. Aucune clé, Space, URL ou activation ne vient du corps ou des paramètres du navigateur.

Sans configuration complète, la route retourne 503 sans réseau ni base de données. Elle borne le corps à 64 KiB même sans Content-Length, exige JSON et la signature ECDSA, vérifie les octets avant parsing, puis le Space/listener/type d'entité avant l'insertion. Une confirmation n'est accusée qu'après persistance atomique. Une panne du fournisseur de clé ou de D1 retourne 503 pour permettre une nouvelle livraison ; un rejeu accepté retourne 200 avec `duplicate: true`. Aucune réponse n'expose de donnée de paiement ni ne prétend qu'un événement encore `pending` est rapproché.

Ne pas activer cette réception en production avant que le worker de rapprochement et le suivi opérationnel soient raccordés. Une réception authentifiée et stockée prouve uniquement qu'un travail attend son traitement ; elle ne prouve ni encaissement, ni paiement d'une période, ni ouverture des droits.

## Contrat du rapprochement restant

`MutationLedger` doit utiliser une transaction/contrainte unique atomique en D1/DB ou un Durable Object. Les scopes incluent origin, space, méthode, chemin et clé métier stable. `SubscriptionCreateRequest` n'a pas d'`externalId` d'après le modèle v2 : le journal local est indispensable. Une reprise réussie retourne le résultat enregistré ; un timeout, une erreur ou une écriture de journal incertaine **bloque les reprises automatiques**. Réconcilier avec le prestataire avant toute nouvelle opération. L'`externalId` de l'abonné, lui, est officiellement pris en charge. Ne pas utiliser un KV `get` puis `put` pour une réservation atomique.

Webhook : vérifier les octets originaux avant `JSON.parse` ; en-tête `x-signature` avec `SHA256withECDSA`. La clé récupérée est une SPKI P-256 Base64 ; la fixture cryptographique officielle prouve ce format. Le client accepte DER et P1363, avec conversion stricte DER. Les autres courbes/algorithmes échouent fermés. Le propriétaire doit persister l'inbox et sa file de travail atomiquement, puis accuser réception des doublons sans répéter les effets. Relire l'abonnement/transaction chez le prestataire avant d'accorder ou de retirer les droits : un ancien webhook ne doit pas restaurer un ancien état.

`timestamp` représente l'événement, pas nécessairement la tentative de livraison. La limite d'âge est optionnelle pour préserver les reprises légitimes ; si elle est configurée, la choisir selon la politique de livraison. La protection de replay principale est l'inbox durable (origin/space/listener/eventId). [Webhooks officiels](https://checkout.postfinance.ch/en-us/doc/webhooks).

## Vérification locale

Depuis la racine du Site : `pnpm test:postfinance`. Les tests de journal exécutent le SQL de production sur SQLite, avec concurrence entre instances, réouverture d'un fichier, panne après réponse fournisseur, replays, leases expirées et séparation Space/origine/listener. Ce sont des tests locaux ; ils ne prouvent pas un paiement ni une livraison dans le compte marchand.

Tests : fixture officielle indépendante, falsification du corps, DER/P1363, mauvais algorithme, replay, scope Space/listener, HMAC indépendant, chemins/corps API exacts, résultat idempotent, conflit de corps, concurrence, timeout ambigu, refus sans configuration, CHF mensuel et URLs autorisées. Aucun appel réseau réel ni mutation marchande pendant les tests.

Restent avant production : raccordement du journal de mutations aux achats et de l'inbox au worker, permissions et configurations du compte, essai simulé du cycle complet, annulation/renouvellement/échec, rapprochement des paiements et intégration des droits Zentra. Les achats doivent conserver leur authentification et leur autorisation propres ; la signature d'un webhook n'autorise pas un achat ni un abonnement.

## Encaissement avant ouverture des droits

La documentation actuelle décrit l'encaissement natif Subscriptions après la période. Aucun paramètre de prépaiement n'a été confirmé dans les modèles consultés. Un `SetupFee` ne prouve pas à lui seul le paiement d'une mensualité `PERIOD_FEE`, et les écritures ne donnent pas de liaison publique directe et univoque avec le `PeriodBill`. Ne pas convertir `ACTIVE`, `BILLED` ou une date de fin prévue en mois futur payé. Le contrat marchand et un cycle simulé doivent clarifier cette corrélation avant ouverture de la route achat. L'alternative documentée est un [Charge Flow](https://checkout.postfinance.ch/en-us/doc/payment/charge-flows) sur token dont Zentra organise les échéances ; elle exigerait un moteur local de renouvellement distinct.

Le parcours choisi est désormais **Charge Flow avec échéancier Zentra**, pour facturer le mois avant d'en ouvrir l'accès. `prepaidProducts` comporte le tarif CHF mensuel et sa version provenant du catalogue Zentra, plus les IDs de configuration de moyen de paiement vérifiés dans le Space. Aucun ID de produit natif PostFinance n'est nécessaire. `prepaidFeatureEnabled`, `merchantApproved`, `chargeFlowEnabled`, le journal durable, un environnement explicite et l'activation du token sont obligatoires ; le flag native Subscriptions n'est pas requis pour ce parcours. Ces gardes sont encore désactivées dans le Site.

Le mode de paiement TEST/PRODUCTION se transmet par `environmentSelectionStrategy: FORCE_TEST_ENVIRONMENT | FORCE_PRODUCTION_ENVIRONMENT`. Ne pas le transmettre comme `TransactionCreate.environment` : ce dernier emploie l'enum LIVE/PREVIEW, distinct de l'environnement d'autorisation du paiement.

Les opérations API exactes sont implémentées, mais pas encore les routes d'achat ni l'échéancier :

- `createPrepaidTransaction` crée une transaction PENDING pour une référence de période locale immuable. Le prix vient du catalogue serveur ; les centimes sont convertis en CHF. Les champs officiels sont `merchantReference`, `invoiceMerchantReference`, `metaData`, `lineItems` et `allowedPaymentMethodConfigurations`, sans `externalId` inventé. Le paiement initial exige `FORCE_CREATION`, `VIRTUAL_PRESENT`, `autoConfirmationEnabled: false` et `COMPLETE_IMMEDIATELY` ; le renouvellement emploie le token vérifié et `NOT_PRESENT`, sans demander un nouveau token.
- `confirmPrepaidTransaction` appelle `/payment/transactions/{id}/confirm` avec la version actuelle relue chez le fournisseur et figée dans l'opération locale. Aucune version n'est devinée ou incrémentée par le client.
- `applyPrepaidChargeFlow` appelle `/payment/transactions/{id}/charge-flow/apply` **sans corps** sur la transaction PENDING de renouvellement. Ne pas confirmer cette transaction avant apply. Les conditions du Space sélectionnent le flow ; aucun `flowId` n'est envoyé.
- `cancelPrepaidChargeFlow` appelle `/payment/transactions/{id}/charge-flow/cancel` sans corps. Cela arrête un flow, sans rembourser un encaissement. L'annulation locale doit d'abord empêcher les prochaines créations, puis rapprocher une éventuelle course avec le paiement.
- Les lectures de transaction, facture, token et version active sont raccordées aux chemins officiels. Une facture doit être corrélée par `linkedTransaction` à la période locale ; un token doit avoir sa version active, son environnement et son moyen vérifiés avant un débit sans présence du client.

Toutes les mutations passent par le journal durable, y compris les POST sans corps. Un résultat perdu bloque un second POST ; les lectures n'ouvrent aucun droit à elles seules. [TransactionCreate](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/models/TransactionCreate.ts), [TransactionsService](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/services/TransactionsService.ts), [TokensService](https://github.com/pfpayments/typescript-sdk/blob/bb1e4c34ffa44bc1da8f54c86f984961aa886c30/src/services/TokensService.ts).

La suite doit enregistrer des contrats internes et des périodes payées distincts des identifiants Stripe, raccorder leur lecteur commun aux licences/places/Support/Automation, réserver les achats qui se chevauchent entre prestataires, puis connecter les achats et le worker au rapprochement. La simulation marchande reste nécessaire pour confirmer la facture PAID, son montant CHF et son solde, le FULFILL de la transaction, le token et le règlement réel du connecteur. Aucun de ces résultats de production n'est inféré des tests.

## Droits et abonnement Zentra

Les identifiants PostFinance ne doivent pas être enregistrés comme des identifiants Stripe. Prévoir une liaison explicite du prestataire à l'abonnement, au compte propriétaire et à l'entreprise, ainsi qu'une réservation d'achat atomique commune aux produits qui se chevauchent. Un abonnement Stripe existant reste géré par Stripe ; ne pas créer un second abonnement PostFinance pendant une migration de prestataire.

L'état PostFinance `ACTIVE` signifie que le token peut être débité, pas qu'une période a été payée. Seules une charge réussie rapprochée et ses dates couvertes peuvent ouvrir les droits Zentra. Le cycle de facturation doit correspondre à un abonnement payé en avance ; cela reste à confirmer avec le marchand et en simulation. Une annulation confirmée doit arrêter le prochain renouvellement et préserver la période déjà payée. [Cycle de vie](https://checkout.postfinance.ch/en-us/doc/subscription/lifecycle) ; [Facturation et prélèvement](https://checkout.postfinance.ch/en-us/doc/subscription/billing-and-charging).
