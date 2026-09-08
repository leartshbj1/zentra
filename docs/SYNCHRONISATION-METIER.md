# Synchronisation métier : réalisation et critères d’activation

La réplication métier complète n’est pas encore active. Les fichiers de projet et les sauvegardes distantes restent deux parcours distincts ; ils ne fusionnent pas les écritures métier de plusieurs appareils.

## Numérotation réservée par appareil

La première brique évite qu’une émission hors ligne réutilise le compteur d’un autre appareil.

- Le service `POST /api/sync/numbers` réserve une plage avec une insertion SQLite atomique. L’entreprise et l’installation proviennent de la session authentifiée, jamais du corps envoyé par le client. Un rôle en lecture seule, un abonnement expiré ou un accès révoqué est refusé.
- L’espace de numéros est commun à un préfixe et une année dans l’entreprise, y compris si plusieurs types de documents partagent ce préfixe. La demande contient une borne minimale issue des documents historiques et de la configuration. Maximum : 1 000 numéros par demande, valeur maximale 999 999 999. Les préfixes existants de 12 caractères, lettres, chiffres et tirets sont acceptés et normalisés en majuscules.
- Une demande porte un UUID durable et reste liée au même appareil. Sa répétition après perte de réponse renvoie la plage initiale. Les plages ne sont jamais recyclées après résiliation, révocation, désinstallation ou restauration.
- Le client enregistre maintenant sa demande SQLite avant l’appel HTTPS. Après redémarrage, il reprend les mêmes paramètres ; une réponse répétée ne remet jamais le prochain numéro au début de la plage. Une réponse incohérente, une plage recouvrante ou une réponse arrivée après restauration est refusée. Le seuil de préparation est de 40 numéros restants, avec des réservations de 200 (réduites en fin de compteur).
- Le planificateur réseau recharge les séries d'une entreprise déjà initialisée après le passage de synchronisation des fichiers. Il couvre l'année courante, les années voisines et les années des documents encore non numérotés ; il regroupe les préfixes partagés et leurs bornes locales maximales. Huit envois maximum par passage, en privilégiant l'année courante. Une entreprise non initialisée ne prépare ni ne télécharge de plage.
- Le schéma local 59 ajoute une liaison d’entreprise et les plages propres à l’appareil. La consommation du numéro est dans la même transaction que l’émission du document ou du journal : un échec annule les deux. Une entreprise liée dont les plages sont épuisées est bloquée avant émission ; aucun repli sur un compteur indépendant.
- Les réservations, y compris les demandes encore en attente, sont retirées des sauvegardes à la création **et** à la restauration. Restaurer une ancienne archive sur le même ordinateur ne rend donc pas réutilisables des numéros déjà consommés après cette archive.

## Porte d’activation

Le client ne crée pas automatiquement `shared_numbering_binding`. La connexion cloud seule ne doit pas activer cette logique tant que l’historique de l’entreprise n’est pas publié et contrôlé. Une activation prématurée depuis un appareil vide pourrait réserver des numéros déjà utilisés dans l’ancienne base.

Avant d’activer pour des clients :

1. Terminer l’initialisation de l’espace partagé à partir de la base de référence, avec publication des bornes historiques de chaque préfixe et année.
2. Compléter le préchargement pour les écritures manuelles portant sur une année ancienne qui n'apparaît pas encore dans un document local. Vérifier l'équité des demandes et les séries épuisées lors de l'initialisation d'entreprises avec un long historique. La connexion cloud seule ne crée pas la liaison d'entreprise.
3. Tester une émission réelle sur deux bases, une coupure pendant la réservation, une réponse reçue deux fois, une restauration sur les deux types d’appareil et le changement d’année.
4. Livrer le moteur de réplication des agrégats métier avec traitement explicite des modifications concurrentes, liens entre tables, paiements, stocks et preuves d’audit. Une chaîne d’audit linéaire ne peut pas être remplacée par l’autre appareil : conserver les preuves des deux branches.
5. Valider le parcours avec deux comptes et deux installations, puis publier les installateurs. Les essais de protocole en mémoire ne remplacent pas cette recette.

## Preuves intermédiaires

Les 11 tests serveur utilisent le schéma D1 réellement migré sur SQLite : vingt appareils concurrents, requête répétée, minimum historique, isolation, changement de paramètres, refus des rôles, bornes et épuisement. Avec cette brique, la suite serveur comporte 240 tests réussis. Le service de numérotation est publié dans la version du site 70, source `75d5bb4`, et refuse une requête sans session (401). Son activation après initialisation et le téléchargement automatique des plages restent à intégrer.

Les douze tests natifs ciblés couvrent consommation transactionnelle, absence de repli, isolation, restauration, redémarrage avec réponse perdue, réponse contradictoire, compteur avancé, préparation concurrente, bornes, planification et changement d'année. Avant les huit derniers scénarios, la suite native complète du schéma 59 passait avec 636 tests réussis, zéro échec et un test HTTPS volontairement ignoré. Le contrôle HTTPS natif public a ensuite été exécuté séparément et passe ; il ne constitue pas une émission partagée réelle.
