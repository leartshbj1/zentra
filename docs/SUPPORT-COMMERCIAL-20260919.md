# Zentra Support — lancement des trois formules

Décision du propriétaire : trois formules mensuelles, par espace d’entreprise, sans tarif par collaborateur ni dépassement automatique.

| Formule | CHF / mois | Analyses terminées / période payée |
| --- | ---: | ---: |
| Starter | 29 | 2 000 |
| Équipe | 49 | 5 000 |
| Business | 99 | 15 000 |

Les échecs avant résultat et les validations manuelles ne consomment pas d’unité. Les reprises qui produisent une nouvelle analyse comptent. Le quota est réservé atomiquement avant l’appel IA, puis consommé ou libéré. À épuisement, aucune facturation supplémentaire : les nouveaux traitements sont suspendus. La source garde ses tickets. Pas de rattrapage automatique promis après suspension.

Le site de présentation et la préparation des connexions restent ouverts. Les opérations de tri, consultation des tickets, invitations et routage exigent une période payée vérifiée. L’accès du propriétaire est distinct des abonnements payants. Aucun droit ERP ou licence native n’est créé par un paiement Support.

## Paiements

Stripe Checkout, un seul paiement en cours par espace, prix stables validés, consentement versionné conservé séparément. L’accès vient d’une facture payée exacte : formule, devise, montant, quantité, entreprise, mode et période vérifiés. Les notifications rejouées ne prolongent pas la période et les anciens événements ne la reculent pas. Retour de Checkout avec réconciliation si le webhook est en retard. Portail propre à Support : factures, moyen de paiement et résiliation à échéance. Changement de formule par assistance avant renouvellement, sans promesse de changement automatique/prorata.

L’éditeur a déclaré ne pas être assujetti à la TVA suisse. Paiement CHF, taxe automatique désactivée pour cette offre. Toute évolution fiscale doit être revue avant de changer les prix. Ne pas annoncer un paiement client testé sans transaction confirmée. Aucun débit réel ne fait partie des essais de développement.

## Connexions

- Freshdesk : parcours guidé, domaine accepté depuis une URL copiée, vérification des équipes et agents, clé chiffrée. La règle de notification doit être configurée dans Freshdesk une fois ; le guide reste accessible. Nécessite les droits API/webhooks du forfait source.
- Zendesk : flux OAuth serveur, état aléatoire lié au compte et à l’espace, dix minutes, usage unique, PKCE S256, clés chiffrées et rotation des refresh tokens avec verrou entre travailleurs. Mode de développement limité au domaine déclaré et au propriétaire. Ouverture commerciale uniquement après approbation globale déclarée par le propriétaire. Installation de la notification ensuite guidée ; ne pas promettre une installation automatique de webhook.
- Gorgias : annoncé à venir. Pas de nouvelles clés personnelles pour une intégration publique. L’authentification publique OAuth et la validation partenaire restent à faire.
- API : guide technique Make/n8n ou intégration sur mesure, décision appliquée par le connecteur puis confirmée. Ce n’est pas un connecteur universel sans configuration.

Sources officielles consultées le 19 septembre 2026 :

- [Zendesk — client OAuth global obligatoire pour une intégration distribuée](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/)
- [Zendesk — renouvellement et rotation des jetons](https://developer.zendesk.com/documentation/authentication/refresh-token/)
- [Zendesk — flux, PKCE et scopes](https://developer.zendesk.com/api-reference/ticketing/oauth/grant_type_tokens/)
- [Gorgias — OAuth obligatoire pour une application publique](https://developers.gorgias.com/docs/oauth2-authentication-for-creating-apps-with-gorgias)
- [Freshdesk — trouver la clé API](https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key)

## Économie et capacités du modèle

Version épinglée `jev-1.13.0` pour conserver un comportement évaluable. TypeSafe annonce 0,042 USD par million de tokens d’entrée, sortie gratuite. À **2 000 tokens d’entrée par analyse, hypothèse illustrative**, 5 000 analyses coûtent environ 0,42 USD d’inférence. Ce calcul exclut hébergement, stockage, frais Stripe, support et maintenance ; ne pas le présenter comme un coût total ou une marge garantie.

Le modèle produit des décisions structurées pour classer et évaluer du texte. Il ne rédige pas les réponses des agents ; il n’analyse pas directement les pièces jointes. Le fournisseur indique de meilleures performances en anglais ; mesurer les autres langues sur des tickets représentatifs. Les comparaisons numériques et calendaires restent dans le code. Les instructions distinguent sujet, priorité et besoin humain, traitent le ticket comme non fiable et limitent le contexte. Un score de confiance n’est pas une garantie d’exactitude.

- [TypeSafe — versions, tarification et limites](https://docs.typesafe.ai/models)
- [TypeSafe — limites de Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Zendesk — tarifs par agent, produit de périmètre différent](https://www.zendesk.com/pricing/)
- [Intercom — Fin facturé par résultat, périmètre différent](https://www.intercom.com/pricing)

Les économies de temps affichées sont des simulations selon les hypothèses de l’utilisateur. L’objectif de 20–30 % n’est pas une mesure client validée.

## Validation locale

155 tests ciblés passent : Support, OAuth, factures payées, quotas concurrents, isolation et régression Stripe ERP. TypeScript et build de production passent. Essai HTTP contre le véritable Workerd/D1 local : création d’espace, configuration gratuite, refus 402 des traitements impayés, masquage des tickets, séparation de l’administration. Vérification visuelle du choix de connecteur à 390 × 844 et des trois tarifs sur ordinateur.

Les tests de transport Zendesk/Freshdesk/Gorgias sont simulés. Une connexion de fournisseur réelle, autorisation et réception/affectation d’un ticket témoin restent nécessaires avant de certifier le parcours de ce fournisseur.
