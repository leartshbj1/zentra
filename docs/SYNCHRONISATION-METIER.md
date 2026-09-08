# Synchronisation métier : réalisation et critères d’activation

La réplication métier complète n’est pas encore active. Les fichiers de projet et les sauvegardes distantes restent deux parcours distincts ; ils ne fusionnent pas les écritures métier de plusieurs appareils.

## Journal transactionnel local, schéma 60 en préparation

La branche de réalisation ajoute un journal local des modifications avant tout transport réseau. Il ne faut pas confondre cette capture avec une synchronisation déjà disponible pour les clients ; la version distribuée 1.46.1 conserve le schéma 59.

- Un contrat explicite décrit les clés et les colonnes de 106 tables métier. Les compteurs techniques `sequence` restent propres à l'installation ; les lignes utilisent leur identifiant stable. Huit tables locales sont exclues, notamment les licences, les réservations de numéros, l'état du transport et les chronomètres encore actifs.
- Les insertions, modifications et suppressions conservent l'état avant et après dans la même transaction SQLite que l'opération. Les effets des déclencheurs et des relations entre tables sont également capturés. Un échec de contrainte, un retour au point de sauvegarde ou l'annulation complète ne laisse pas d'envoi fantôme.
- Un identifiant de transaction commun relie la facture, le paiement, les lignes comptables et les preuves d'audit. Les connexions réutilisées, les redémarrages et les transactions distinctes conservent des identifiants distincts. Le journal est non modifiable et non supprimable ; les futurs accusés de réception sont stockés séparément.
- Aucun profil ordinaire ne crée de liaison active. Pour ne pas alourdir chaque ouverture de base, les déclencheurs de capture ne sont installés qu'avec une liaison activée dans une transaction. Une table incomplète ou un champ non classé bloque cette installation entièrement. Le parcours d'initialisation serveur qui autorisera cette transaction reste à réaliser.
- Une sauvegarde conserve les changements en attente mais désactive la capture et retire ses déclencheurs sur la copie. La restauration conserve l'identité de l'appareil destinataire et exige une réconciliation avant d'envoyer de nouveau. Les anciennes demandes ne peuvent donc pas reprendre silencieusement comme si la copie était encore l'appareil d'origine.

La capture conserve des états locaux, y compris des champs de paie et des références de fichiers. Ils ne constituent pas un corps HTTP prêt à partager : le transport doit appliquer les droits des collaborateurs, séparer les données confidentielles, convertir les références de fichiers et préserver les branches d'audit. Une application des lignes reçues sans ces contrôles ne serait pas acceptable. Il faut également traiter les effets des déclencheurs sans les exécuter deux fois et vérifier les conflits portant sur les paiements, les soldes de stock et les clôtures.

## Réception de l'historique initial

Le service `GET/POST/PUT/DELETE /api/sync/bootstrap` prépare le transfert initial. L'entreprise vient de la session authentifiée. Seuls le titulaire et les administrateurs peuvent choisir et annuler cette base de référence ; cela ne réduit pas l'accès de travail complet annoncé aux rôles collaborateur et comptable pour la future réplication métier.

- Le manifeste classe exactement les 106 tables du contrat natif. Son empreinte repose sur un tableau JSON ordonné, indépendant des fins de ligne Windows ou macOS. Les huit tables propres à l'installation restent exclues.
- Une préparation est liée à une entreprise, un appareil, un UUID de demande et une génération attribuée une seule fois par le serveur. Deux appareils concurrents ne créent pas deux bases de référence. Une réponse perdue reprend le même manifeste et les mêmes accusés de réception.
- Chaque fragment contient au maximum 200 lignes et 4 Mio. Une ligne est limitée à 1 Mio ; un transfert à 200 000 lignes, 1 024 fragments et 512 Mio au total. Les octets sont contrôlés avant stockage, puis conservés dans R2 ; les lignes et accusés de réception sont insérés ensemble dans une transaction D1. Une référence répétée ou un dépassement du nombre déclaré annule le fragment entier.
- Les lignes conservent le texte JSON natif exact, notamment les valeurs réelles comme `1.0` et le JSON stocké dans des colonnes texte. Les références incohérentes, champs inconnus, nombres non représentables sans perte, séquences Unicode invalides et clés JSON répétées sont refusés. Ces dernières n'ont pas la même interprétation avec JavaScript et SQLite.
- Recevoir tous les fragments produit l'état `uploaded`, pas une publication. L'espace reste `initializing`, avec une révision nulle, et aucune ligne ne devient une base métier partagée. Le passage autoritaire vers `ready`, les relations, les invariants financiers, les fichiers associés, les bornes historiques des numéros et le client natif restent à terminer.
- L'annulation d'une préparation non publiée retire les lignes temporaires et ses fragments attendus, y compris un fragment dont la réponse aurait été perdue. Un administrateur peut reprendre ce parcours depuis un autre appareil si le premier est perdu. Un nettoyage interrompu reste reprenable ; un envoi retardé qui reprend après annulation retire sa copie au lieu de réactiver l'ancienne génération. Une préparation déjà publiée et les autres entreprises sont protégées.
- Le service de numérotation exige maintenant un espace `ready` avec une révision publiée, à la fois lors de la réservation atomique et lors de sa relecture. La réception d'un manifeste ou d'un fragment ne suffit jamais à ouvrir les compteurs. Les réservations historiques sont conservées même si la base partagée devient temporairement indisponible.

La migration D1 `0013_concerned_goliath.sql` ajoute uniquement quatre tables et leurs index. Les 22 tests du transfert emploient toutes les migrations réelles sur SQLite avec une simulation transactionnelle de D1 et un stockage R2 en mémoire. Les 13 tests de numérotation passent aussi ; la suite serveur complète comporte 264 tests réussis. TypeScript, le contrôle statique et le build de production passent. Ces tests ne constituent pas un transfert natif authentifié sur deux appareils réels.

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

Le 8 septembre 2026, la suite Windows GNU du schéma 60 en préparation passe avec **658 tests réussis, zéro échec et deux essais HTTPS explicitement ignorés**, en 825,92 secondes. Elle comprend douze scénarios de capture : contrat complet, absence d'activation implicite, atomicité facture/paiement, effets des déclencheurs et des relations, annulation, redémarrage, notes et suppressions, identité d'installation, migration 59 vers 60, sauvegarde puis restauration dans un autre profil, facture émise avec journal équilibré et paiement répété sans doublon. Clippy sur toutes les cibles et le format du nouveau module passent. Les essais HTTPS publics attestés pour la release 1.46.1 ne sont pas réexécutés par cette suite.

La première exécution générale avec les déclencheurs installés sur chaque profil a été interrompue pour réduire ce coût inutile. Son journal est conservé séparément ; ce n'est pas un contrôle réussi. La suite complète ci-dessus utilise l'installation différée des déclencheurs. Ces résultats ne prouvent pas encore les performances d'un profil synchronisé chargé ni une fusion concurrente réelle.

Un dernier contrôle ajouté après le lancement de la suite générale refuse un champ non classé et annule la liaison ainsi que tous les déclencheurs partiellement installés. La suite ciblée finale passe avec **13 tests sur 13**, en 16,55 secondes. Aucun code de production n'a changé entre les deux exécutions.

Les 11 tests serveur utilisent le schéma D1 réellement migré sur SQLite : vingt appareils concurrents, requête répétée, minimum historique, isolation, changement de paramètres, refus des rôles, bornes et épuisement. Avec cette brique, la suite serveur comporte 240 tests réussis. Le service de numérotation est publié dans la version du site 70, source `75d5bb4`, et refuse une requête sans session (401). Son activation après initialisation et le téléchargement automatique des plages restent à intégrer.

Les douze tests natifs ciblés couvrent consommation transactionnelle, absence de repli, isolation, restauration, redémarrage avec réponse perdue, réponse contradictoire, compteur avancé, préparation concurrente, bornes, planification et changement d'année. Avant les huit derniers scénarios, la suite native complète du schéma 59 passait avec 636 tests réussis, zéro échec et un test HTTPS volontairement ignoré. Le contrôle HTTPS natif public a ensuite été exécuté séparément et passe ; il ne constitue pas une émission partagée réelle.
