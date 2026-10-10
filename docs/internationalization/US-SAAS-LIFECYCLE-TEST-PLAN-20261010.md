# US SaaS lifecycle TEST — plan incrémental

Base vérifiée : `05e47ae`, admission initiale TEST `cf53d3a`. Cette phase ne modifie ni les offres CHF ni les abonnements clients existants et n'active aucun paiement US réel.

## Périmètre et règles

- Conserver l'autorité initiale 0087 et la preuve 0091 immuables. Ajouter des périodes payées vérifiées et des observations auditables, liées au même achat, compte Stripe TEST, client et abonnement. Aucun changement de plan, de prix ou de sièges.
- Renouveler uniquement après lecture serveur de la facture USD intégralement payée et de son graphe de paiement. Une page de retour, un statut d'abonnement ou une signature seuls ne prouvent pas le paiement.
- Échec de paiement ou annulation : aucune nouvelle période accordée ; la période déjà payée reste valable jusqu'à sa borne exclusive. Une annulation ne supprime pas les données.
- Remboursement partiel/total ou contestation confirmée : restriction terminale conservatrice de cet abonnement TEST, journalisée, sans effacer l'historique et sans réactivation automatique. Cette politique pilote demande validation commerciale avant production.
- Événements hors ordre : relire l'état actuel du prestataire, résoudre les ressources par leurs relations de premier niveau et les rapprocher de la liaison persistée. Ne jamais accorder par métadonnées. Une observation tardive payée ne lève pas une révocation.
- Projection effective commune pour Gestion, Automation, Team et appareils. Les replays d'admission et la découverte restent sur la preuve initiale. Les anciens credentials conservent leurs propres limites temporelles ; le renouvellement n'allonge aucun token existant.
- Nouvelle gate TEST fermée par défaut, profil sandbox explicite, clé SaaS dédiée, webhook signé. Aucun nouveau service, secret, tarif ou webhook n'est créé sans étape de déploiement approuvée.

La nouvelle gate est `INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED=true`, avec le secret serveur distinct `INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET`. Elle dépend aussi des gates `INTERNATIONAL_CORE_ENABLED`, `INTERNATIONAL_US_CREATION_ENABLED`, `INTERNATIONAL_US_SAAS_TEST_ENABLED` et de toute la configuration sandbox SaaS dédiée. L'endpoint dédié est `/api/international/billing/test/lifecycle/webhook`. L'endpoint SaaS initial peut composer le lifecycle après vérification de sa propre signature ; leurs secrets ne sont pas interchangeables. Fermer une gate prérequise bloque aussi les nouvelles observations de restriction : cela ne révoque pas implicitement les autorités existantes.

## Architecture et migrations proposées

Le contrat privé `us-saas-test-lifecycle-contract.ts` définit une liaison issue de l'admission, un locator signé sans autorité et une observation serveur marquée. Les actions sont `paid_period`, `observe` et `revoke`. Les observations de faits distincts peuvent partager un eventId ; un retry identique conserve le premier instant enregistré.

Une nouvelle migration D1 0092 ajoute les tables et une vue effective. Les migrations 0087–0091 ne sont pas réécrites. Les gardes de membres, Team et appareils sont adaptées dans cette nouvelle migration ; l'absence de période additionnelle conserve la sémantique antérieure. Aucun SQL PostgreSQL, backfill ou déplacement de région n'est prévu.

Le runtime webhook résout l'abonnement vers la preuve initiale persistée et revalide les gates, le catalogue, l'achat et l'entreprise autour des lectures externes et de l'écriture. Aucun endpoint public n'accepte des preuves financières arbitraires.

## Validation requise

Tests de renouvellement, expiration initiale, replay, perte de réponse, désordre, remboursement d'une ancienne facture, contestation, révocation concurrente, faux graphe, mauvais compte/devise/prix/entreprise, gate fermée et absence de migration. Vérifier les consommateurs réels de droits et préserver les bornes des tokens et les quotas Automation. Régressions CH ciblées, typecheck, lint et build par défaut après intégration.

## Limites et rollback

La recette locale ne prouve pas Stripe, D1, Auth ou PostgreSQL hébergés. Les migrations staging restent à approuver ; les ressources internationales PostgreSQL ne sont pas encore déployées. Les taxes SaaS réelles, inscriptions fiscales et permissions de clé doivent être validées séparément avant tout lancement américain.

Fermer la gate lifecycle arrête son ingestion, sans supprimer preuves, périodes ou données métier. Elle ne révoque pas à elle seule les droits déjà payés ; les gates ERP constituent une fermeture distincte. Ne jamais annuler une révocation terminale, réécrire une migration ou supprimer une entreprise pour revenir en arrière. Après arrêt, redélivrer les webhooks en attente sous contrôle avant reprise.
