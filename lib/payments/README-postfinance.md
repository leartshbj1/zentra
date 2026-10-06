# Adaptateur PostFinance Checkout / Wallee

Module serveur préparé, sans SDK et sans dépendance runtime. Aucune route de paiement du Site ne l'utilise encore. Aucun compte marchand n'existe encore : conserver `enabled: false`. Les tests utilisent exclusivement un `fetch` simulé et des clés publiques de test. Ce résultat n'est pas une validation en production.

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

L'argument `method` du client applique une garde locale ; il ne sélectionne pas le moyen de paiement dans un champ API. Le choix et les moyens proposés par la page hébergée dépendent du produit/Space du marchand. Vérifier cette configuration en simulation avant de promettre une page dédiée exclusivement à PostFinance Pay ou TWINT.

## Configuration humaine nécessaire

1. Compte Checkout, contrat PSP/acquisition, KYC validé et versement configuré.
2. PostFinance Pay **token/on-file** activé. Pour TWINT, **User-on-File** activé. [TWINT](https://www.twint.ch/en/business-customers/products/twint-for-online-shops/automated-payments/) ; [PostFinance Pay](https://www.postfinance.ch/en/business/products/payment-collection/payment-solutions/postfinance-pay.html).
3. Fonction Subscriptions et **Charge Flow** activés, au moins un flux configuré. [Documentation](https://checkout.postfinance.ch/en-us/doc/subscription/overview).
4. Produit confirmé à **CHF, cycle mensuel**, prix et composants correspondant au plan Zentra ; moyens acceptés permettant le paiement sans carte. Les métadonnées `billingPeriod` et `priceChfMinor` sont des gardes locales, pas des champs API ni une preuve distante du tarif. Les vérifier contre le produit du portail et l'abonnement simulé.
5. Utilisateur d'application avec permissions minimales pour abonné, abonnement, page de paiement, lectures et clé de signature. Configurer côté serveur `applicationUserId`, `authenticationKeyBase64` comme secret Cloudflare, `spaceId`, `returnOrigin`, IDs produits et listeners. Aucun secret dans le navigateur, git ou logs.
6. N'activer les indicateurs de l'asset qu'après les vérifications correspondantes. Au départ tous absents/faux et `enabled: false`. Un paramètre de navigateur ne peut définir ces indicateurs ou le catalogue.

## Fiabilité à intégrer par le propriétaire

`MutationLedger` doit utiliser une transaction/contrainte unique atomique en D1/DB ou un Durable Object. Les scopes incluent origin, space, méthode, chemin et clé métier stable. `SubscriptionCreateRequest` n'a pas d'`externalId` d'après le modèle v2 : le journal local est indispensable. Une reprise réussie retourne le résultat enregistré ; un timeout, une erreur ou une écriture de journal incertaine **bloque les reprises automatiques**. Réconcilier avec le prestataire avant toute nouvelle opération. L'`externalId` de l'abonné, lui, est officiellement pris en charge. Ne pas utiliser un KV `get` puis `put` pour une réservation atomique.

Webhook : vérifier les octets originaux avant `JSON.parse` ; en-tête `x-signature` avec `SHA256withECDSA`. La clé récupérée est une SPKI P-256 Base64 ; la fixture cryptographique officielle prouve ce format. Le client accepte DER et P1363, avec conversion stricte DER. Les autres courbes/algorithmes échouent fermés. Le propriétaire doit persister l'inbox et sa file de travail atomiquement, puis accuser réception des doublons sans répéter les effets. Relire l'abonnement/transaction chez le prestataire avant d'accorder ou de retirer les droits : un ancien webhook ne doit pas restaurer un ancien état.

`timestamp` représente l'événement, pas nécessairement la tentative de livraison. La limite d'âge est optionnelle pour préserver les reprises légitimes ; si elle est configurée, la choisir selon la politique de livraison. La protection de replay principale est l'inbox durable (origin/space/listener/eventId). [Webhooks officiels](https://checkout.postfinance.ch/en-us/doc/webhooks).

## Vérification locale

Avec Node 24 : `node --test postfinance-client.test.mjs`. TypeScript peut être vérifié avec `tsc --noEmit --strict --target ES2022 --module ESNext --lib ES2022,DOM postfinance-client.ts`.

Tests : fixture officielle indépendante, falsification du corps, DER/P1363, mauvais algorithme, replay, scope Space/listener, HMAC indépendant, chemins/corps API exacts, résultat idempotent, conflit de corps, concurrence, timeout ambigu, refus sans configuration, CHF mensuel et URLs autorisées. Aucun appel réseau réel ni mutation marchande pendant les tests.

Restent avant production : implémentation durable des deux interfaces, permissions et configurations du compte, essai simulé du cycle complet, annulation/renouvellement/échec, rapprochement des paiements et intégration des droits Zentra. Les routes, leur authentification et leur autorisation sont à la charge du propriétaire du Site.

## Droits et abonnement Zentra

Les identifiants PostFinance ne doivent pas être enregistrés comme des identifiants Stripe. Prévoir une liaison explicite du prestataire à l'abonnement, au compte propriétaire et à l'entreprise, ainsi qu'une réservation d'achat atomique commune aux produits qui se chevauchent. Un abonnement Stripe existant reste géré par Stripe ; ne pas créer un second abonnement PostFinance pendant une migration de prestataire.

L'état PostFinance `ACTIVE` signifie que le token peut être débité, pas qu'une période a été payée. Seules une charge réussie rapprochée et ses dates couvertes peuvent ouvrir les droits Zentra. Le cycle de facturation doit correspondre à un abonnement payé en avance ; cela reste à confirmer avec le marchand et en simulation. Une annulation confirmée doit arrêter le prochain renouvellement et préserver la période déjà payée. [Cycle de vie](https://checkout.postfinance.ch/en-us/doc/subscription/lifecycle) ; [Facturation et prélèvement](https://checkout.postfinance.ch/en-us/doc/subscription/billing-and-charging).
