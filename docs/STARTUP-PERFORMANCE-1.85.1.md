# Zentra 1.85.1 — ouverture du compte et Automation

## Chemin critique examiné

Moteur Tauri prêt → chargement local et licence → résolution de l’entreprise → interface Gestion → état Automation. La requête `/api/account/me` était attendue avant l’ouverture et conservait le verrou partagé des opérations de compte pendant le réseau. Ce verrou retardait aussi la résolution d’entreprise et la capture de session pour Automation. La confirmation d’un nouveau lien faisait une seconde lecture distante du compte alors que l’approbation avait déjà fourni sa session et sa licence signée.

## Corrections

- Ouverture depuis la session protégée et la licence signée locales, suivie immédiatement d’une revalidation en arrière-plan. Une session expirée invalide d’abord la licence locale.
- Verrou du compte limité à la capture et à l’application de la réponse. Une réponse ne s’applique que si la session, l’entreprise, le rôle et l’expiration sont encore identiques. Déconnexion et changement de compte protégés aussi côté interface.
- Réutilisation des connexions HTTPS, avec autorisation propre à chaque requête, délais, origine fixe et refus des redirections conservés.
- Suppression de la vérification réseau redondante à l’approbation du compte, préchargement du module de travail et sonde immédiate du moteur déjà prêt.
- Regroupement des retours de focus/visibilité pendant un chargement Automation. Une modification explicite continue de demander une actualisation suivante.
- Côté serveur, les cinq lectures indépendantes du bilan du jour démarrent ensemble, après validation des droits et uniquement pour l’entreprise demandée.

La première connexion et le transfert initial d’une entreprise restent des opérations en ligne. Aucun accès Automation persistant ni contournement d’abonnement n’est ajouté. Synchronisation métier et périodicité des vérifications de sécurité conservées.

## Mesure et contrôles

Le banc `mobile-harness.html?browsing=1&design=1&automation=1&startupPerformance=1` utilise le véritable composant App avec données fictives, session locale et une vérification de compte volontairement retardée de 10 secondes. Mesure observée dans le navigateur de développement : espace visible à 500 ms, résumé Automation à 537 ms. Après la réponse distante, l’espace reste affiché, sans écran de chargement ni erreur console. Ces valeurs ne sont pas une promesse de durée sur tous les appareils et n’incluent pas un lancement à froid du processus natif.

Tests ciblés : ouverture native immédiate et reprises, session locale/expirée, changement de compte pendant une requête, revalidation regroupée, résolution d’entreprise, demandes Automation, droits serveur et lectures du bilan en parallèle. Les preuves de tests, compilation et distribution sont conservées dans `outputs/release1851/`. Une compilation réussie ne remplace pas une mesure sur iPhone ou Mac physique.
