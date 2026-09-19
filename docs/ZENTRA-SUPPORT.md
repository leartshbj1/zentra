# Zentra Support

Application web distincte à `/support`, avec démonstration fictive à `/support/demo`. L’ERP, ses licences, son abonnement et ses données restent indépendants. Chaque titulaire possède un espace ; des membres peuvent rejoindre plusieurs espaces avec leur adresse vérifiée. Rôles : propriétaire, administrateur, validation, lecture seule.

## Configuration

1. Se connecter avec son compte Zentra et créer son espace.
2. Connexions → Jev : le propriétaire de la plateforme peut activer sa clé TypeSafe pour les espaces. Un administrateur d’espace peut utiliser sa propre clé à la place. Le serveur vérifie la clé sur un texte fictif avant de la chiffrer. Aucune clé ne revient dans les réponses de lecture.
3. Ajouter Zendesk, Freshdesk, Gorgias ou « Autre outil · API ». Pour un connecteur natif, fournir le sous-domaine officiel et une clé permettant lecture des équipes/agents/tickets et modification de l’affectation/priorité. Certains abonnements du fournisseur peuvent restreindre ces APIs.
4. Copier l’adresse et la clé de webhook affichée une seule fois. Dans l’outil, configurer un POST JSON lors de la création d’un ticket avec `Authorization: Bearer <clé>` et `{"ticketId":"<identifiant dynamique>"}`. Choisir uniquement l’événement de création pour éviter les boucles lors des affectations. Tester avec un ticket non client.
5. Routage → associer catégories et équipes, éventuellement un agent. D’abord valider quelques décisions, puis activer le mode automatique et choisir le seuil.

Pour les autres outils, l’intégration nécessite une API ou un scénario Make/n8n capable d’envoyer le ticket ET de modifier son affectation. Ce n’est pas une promesse de connecteur natif pour tous les logiciels.

## Contrat API générique

Sur `/api/support/hooks/<connectionId>`, authentification Bearer de la connexion :

- POST `{"ticketId":"123","subject":"Objet","body":"Message","version":"1"}`. Limites : objet 300 caractères, message 24 000, corps HTTP 48 000 octets. Le texte est considéré non fiable et n’est jamais exécuté.
- La réponse contient `ticket.id` (identifiant Zentra), `ticket.revision`, `ticket.state` et `ticket.decision` : `category`, `priority`, `destination.teamId`, `destination.agentId` facultatif.
- En mode automatique au-dessus du seuil, état `ready`. En dessous du seuil, en catégorie Autre, sans règle, ou en mode validation, état `review` : ne rien appliquer.
- GET renvoie jusqu’à 50 décisions `ready`. Interroger périodiquement pour recevoir également les validations humaines.
- Appliquer uniquement les décisions `ready` dans l’outil de destination, puis POST `{"action":"acknowledge","ticketId":"<id Zentra>","revision":2,"status":"applied"}` avec la révision exacte reçue. La répétition du même acquittement est idempotente. Une ancienne révision est refusée.
- Les réponses 503 et 429 nécessitent une nouvelle tentative avec temporisation et le même identifiant. Une clé révoquée (401) nécessite une intervention. Ne pas acquitter une affectation refusée.

Les catégories sont `bug`, `billing`, `product`, `refund`, `shipping`, `account`, `other`. Les priorités sont `low`, `normal`, `high`, `urgent`. L’API générique ne contacte aucune URL arbitraire fournie par les clients et attend une confirmation de l’outil.

## Fiabilité et limites

Le traitement est réalisé par le serveur lors de la réception du webhook, indépendamment d’un navigateur ouvert. Le tableau de bord relit les données toutes les 15 secondes lorsqu’il est visible. Aucune réponse au client, clôture de ticket ou exécution de remboursement n’est effectuée.

Déduplication par connexion, identifiant externe et empreinte de contenu ; verrou temporaire et contrôle de révision pour éviter les analyses concurrentes et validations périmées. L’échec d’une analyse conserve le ticket et le motif. Le fournisseur doit réémettre les événements en cas d’erreur temporaire : il n’y a pas de scheduler autonome de reprise des erreurs. L’interface permet aussi une reprise explicite.

Les connecteurs relisent le ticket avant écriture et vérifient affectation ET priorité après écriture. Zendesk bénéficie en plus de `safe_update`/`updated_stamp`. Freshdesk et Gorgias n’offrent pas ici une comparaison-écriture atomique : une modification humaine pendant cet intervalle peut nécessiter une correction. Une affectation déjà faite à une personne empêche le routage automatique.

Les historiques trop longs sont signalés pour validation : au-delà de 30 conversations Freshdesk, d’une page de 100 commentaires/messages Zendesk/Gorgias, ou de 24 000 caractères. Les pièces jointes ne sont pas analysées. Les répertoires sont limités à 2 000 entrées par type. Limite d’entrée : 1 000 nouveaux tickets par espace et jour UTC, 1 200 appels par connexion/adresse/heure ; interface : 180 mutations par compte/adresse/heure. Ces limites sont techniques, pas des tarifs.

`SUPPORT_ENCRYPTION_KEY` : secret serveur aléatoire 32 octets en base64, nécessaire au chiffrement AES-256-GCM des clés TypeSafe et des outils. Ne pas le remplacer sans réencrypter les secrets enregistrés. `TYPESAFE_API_KEY` est une alternative d’exploitation à la clé plateforme chiffrée en base. Aucun secret ne doit être ajouté à Git.

Migration additive `0041_mysterious_brother_voodoo.sql` : six tables Support et leurs index. Aucun changement des anciennes migrations. Suppression/export d’un espace : via le support de l’éditeur pour cette version ; déconnecter l’outil conserve l’historique.

Les minutes affichées correspondent aux affectations automatiques non corrigées multipliées par un temps manuel configurable. L’objectif de 20–30 % de gain doit être mesuré chez les clients ; il n’est pas présenté comme un résultat prouvé. La confiance Jev ne représente pas une garantie de justesse.

## Vérification du 19 septembre 2026

- `tsc --noEmit`, compilation Vinext.
- `vitest run --config vitest.config.ts lib/support/support.test.ts` : contrats Jev, chiffrement contextualisé, contrôle des domaines, champs des trois connecteurs, conflit/confirmation d’affectation, parcours SQL réel, modes, droits, révision, rejeu, reprise et concurrence.
- `node scripts/test-support-local.mjs` : compte fictif du serveur de développement uniquement, vraie D1 locale, création/connexion/réception sans clé/validation manuelle/GET décisions/acquittement/compteurs/absence de clé dans les réponses/refus non authentifié.
- Aperçu navigateur : validation fictive, sélection de fournisseurs, champs adaptés au fournisseur, sections ordinateur et mobile jusqu’à 320 px sans dépassement horizontal mesuré.
- L’appel réel à Jev et les affectations sur de vrais comptes Zendesk/Freshdesk/Gorgias nécessitent les clés du propriétaire et des clients. Les tests de transport utilisent des réponses contrôlées ; ils ne prouvent pas que ces comptes externes sont configurés.

## Documentation primaire consultée

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/api
- https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
- https://developer.zendesk.com/api-reference/ticketing/groups/groups/
- https://developers.freshdesk.com/api/
- https://developers.gorgias.com/reference/update-ticket
- https://developers.gorgias.com/reference/list-messages
- https://developers.gorgias.com/docs/sync-gorgias-data-with-a-database
