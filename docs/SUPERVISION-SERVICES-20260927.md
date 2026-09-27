# Contrôle des services publié

Sites **290**, source `b9d433ebb365ff46a7adc912338586e12bfa393a`, déploiement réussi le 27 septembre 2026 à 18 h 29 (Europe/Zurich), configuration 37. Le code et la documentation détaillée sont dans le checkout serveur `zentra-workflows-publish-20260921/chantier`, fichier homonyme.

## Résultat réel à 18 h 30

`GET https://zentraapp.ch/api/operations/health`, avec la clé privée de supervision, renvoie **503** en **284 ms** :

- Service de comptes : `restricted`, réponse Supabase **402**, mesurée en 112 ms.
- Planificateur : `inactive`, aucune réussite enregistrée.
- Files : une boîte due et en retard, échéance `2026-09-24T23:38:25Z` ; aucun ticket ou workflow en erreur dans les compteurs lus.

L'accès anonyme et une mauvaise clé retournent **401**. Les réponses ne sont pas mises en cache. Le diagnostic n'expose que des états, dates et compteurs ; aucun identifiant d'entreprise ni contenu client. Il n'envoie pas d'e-mail, ne traite pas les files et ne crée aucun compte. Les attentes humaines ou futures ne déclenchent pas de faux retard.

## Validation

69 tests dans cinq fichiers, dont 29 spécifiques ; vraie base SQLite pour les files, droits, délais, panne et confidentialité. TypeScript, lint et production build réussis. La migration additive 0066 indexe les tickets à surveiller. Une recette avec workerd reproduit le rejet initial de `redirect: error` et valide le mode manuel sans suivi de redirection ; ce défaut de la première publication 289 a été corrigé avant le contrôle final.

Les artefacts anonymisés sont copiés dans `outputs/operations-monitor/` : déploiement, résultat final, résultat avant correction, vérification workerd et journal des tests. Les clés restent uniquement dans le secret serveur et la session d'exécution ; elles ne sont pas dans ces fichiers.

## Restant

Le diagnostic n'est **pas encore relié à un service externe d'alerte**. La réception d'une panne puis d'un rétablissement doit être testée. Le service de comptes est toujours restreint ; la demande de capture Usage/Billing Supabase reste en attente. Le planificateur doit être rétabli et son fonctionnement vérifié applications fermées. Aucun achat de capacité, suppression de document, envoi réel ou nouvelle version native n'a été réalisé par ce lot.
