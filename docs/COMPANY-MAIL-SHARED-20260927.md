# Envoi partagé par entreprise — état de développement

27 septembre 2026, suivi après la publication serveur de 15 h 46 (Europe/Zurich). Le serveur est publié dans Sites 285, source `59779ad217ed6531cfcc85673846f524d5f71ca9`, déploiement `appgdep_6ab91e01262c8191a2374f3fddc74ba8` réussi, configuration 36 inchangée. Les clients correspondants restent à publier. La vérification Windows CircleCI n°141 a réussi sur la source native `e862214ee73e20b2b5dc546ddf21adc5b7262dab`. Le correctif frontend de réouverture `9755b446` suit cette source sans modifier le moteur Rust testé. Aucun e-mail réel envoyé dans cette recette. Ne pas annoncer cette fonction comme disponible aux clients tant que les étapes restantes ne sont pas validées.

## Ce que cette source vérifie

- `GET /api/company-mail` expose uniquement l’état public et, pour un document donné, les dix dernières tentatives de l’entreprise. Les horodatages sont ISO et les statuts publics restent `pending`, `accepted`, `rejected`, `uncertain`. Les tentatives interrompues ne restent pas indéfiniment affichées comme actives.
- `POST` accepte `connect`, `disconnect`, `send`. Les mêmes vérifications de session, appartenance, place disponible et origine que les autres routes de compte s’appliquent. Propriétaire/administrateur configurent ; membre/comptable peuvent envoyer ; consultation seule ne peut pas envoyer. Gestion doit être actif pour connecter ou envoyer. Après préparation chez le fournisseur, les droits et la connexion sont vérifiés à nouveau avant la demande d’envoi.
- La connexion Infomaniak possède son propre secret chiffré, lié par authentification cryptographique à l’entreprise et à la révision de connexion. Le secret n’est jamais retourné au client. **Le connecteur entrant Support, annoncé en lecture seule, n’est ni copié ni modifié.**
- L’expéditeur provient de l’identité effective d’Infomaniak (`identity_id`) ; l’API ignore `from.name`. Le nom réellement confirmé est enregistré, et un changement chez le fournisseur exige une reconnexion. La vérification de connexion lit la boîte et les identités ; elle ne prouve pas à elle seule le droit d’envoyer.
- Chaque tentative explicite utilise un UUID stable. La réservation atomique empêche deux appareils ou deux workers d’envoyer la même tentative. Un UUID représenté en majuscules ne crée pas une deuxième tentative. Une nouvelle charge sous le même UUID est refusée. Les échecs ambigus ne sont jamais rejoués automatiquement.
- Les appels Infomaniak utilisent des origines HTTPS fixes, aucune redirection, un délai de 15 secondes par requête et une réponse bornée. Les erreurs du fournisseur et les clés ne sont pas exposées. Les quotas de sécurité sont communs à l’entreprise : 360 tentatives/heure et 1 000/jour.
- Le PDF est limité à 6 Mio. Le logo optionnel est un PNG produit par le compositeur natif, jusqu’à 256 Kio et 360 × 120 pixels, joint en ligne via le `content_id` retourné par Infomaniak. Aucun logo externe n’est téléchargé. L’enveloppe PNG et sa structure sont contrôlées, sans prétendre remplacer un décodeur d’image ou valider tous les CRC. Le hachage d’idempotence inclut les octets du logo.
- Les corps et pièces ne sont pas conservés dans D1 : seules les références, empreintes, métadonnées, auteur et résultat sont journalisés. `accepted` signifie accepté par le fournisseur, **pas remis au destinataire**.

## Migrations et vérifications

Migrations incluses dans l’archive publiée : `0063_company_mail.sql` (connexion et journal) et `0064_company_mail_identity.sql` (identité d’expédition). Elles conservent les tables existantes. La lecture directe de leur schéma distant reste à confirmer : l’outil d’aperçu D1 ne retourne que les 50 premières tables alphabétiques, sans les tables de messagerie ; cela ne prouve pas leur absence. Les scénarios locaux utilisent les vraies migrations, SQLite, le chiffrement AES et les vérifications de session/appartenance du projet, avec fournisseur et session navigateur simulés.

- 75 tests de messagerie partagée et logo réussis. La récupération d’un reçu par GET et le changement de révision de connexion sont couverts.
- Lot élargi : 160 tests réussis, 3 ignorés, dans 9 fichiers (compte, équipe, intégrité du partage, webhook Stripe, droits Automation et planificateur inclus).
- TypeScript sans erreur ; lint ciblé sans erreur ; compilation de production Vinext réussie.
- Correction transversale dans `lib/automation/access.ts` : conserver un refus d’origine en HTTP 403 au lieu de le présenter comme une panne de compte 500.
- Journaux locaux : `.qa/company-mail-critical.log`, `.qa/company-mail-types.log`, `.qa/company-mail-build.log`.

## Intégration native et interface

Le transport HTTPS est limité au domaine de compte et lie la session à l’entreprise ouverte avant et après chaque appel. Il libère le verrou de données pendant le réseau. Le PDF et son logo proviennent du moteur natif, avec contrôle de la révision du document et de la connexion avant réservation. Le journal local conserve l’instantané nécessaire aux preuves et aux relances, sans y conserver la clé ni les octets du PDF.

Une tentative interrompue peut être interrogée par `GET /api/company-mail?requestId=…` : contrôle frais de la session et de l’appartenance, entreprise et reçu liés, aucun nouvel envoi. Le client vérifie destinataire, objet, pièce et expéditeur contre son instantané avant de compléter l’audit. Les décisions de paiement et d’annulation sont préservées. Le journal utilise le nom d’audit historique `smtp_accepted` pour compatibilité, avec un champ `channel: company_mail` explicite.

Les réglages distinguent adresse partagée Infomaniak et SMTP sur cet appareil. Les modèles restent communs à l’entreprise. Les nouveaux textes et principales erreurs existent en FR/DE/IT/EN. L’interface indique l’expéditeur effectif et distingue acceptation et réception. La récupération ne bascule jamais automatiquement vers SMTP. Après réouverture, une ancienne tentative incertaine doit être montrée avant l’action d’envoi, avec récupération ou vérification manuelle explicite.

Recette navigateur à pont natif fictif : Edge et WebKit, 390 px sombre / 1440 px clair, langues DE/IT/EN à 390 px ; connexion, confirmation de déconnexion partagée, unicité, récupération, réouverture, lecture seule et choix local explicite. 32 tests frontend e-mails/relances passent ; TypeScript et Vite compilent. Windows refuse l’exécution locale des tests natifs (contrôle d’applications 4551), mais la CI n°141 a exécuté avec succès les 18 tests e-mails, dont quatre nouveaux scénarios partagés : vrai PDF et logo avec récupération sans renvoi, états non acceptés, refus des reçus périmés ou d’une autre entreprise, préservation des factures payées ou annulées. La revue UX confirme le correctif de réouverture résolu. Ceci ne prouve ni envoi réel, ni installation native, ni validation physique iOS ; cette CI de vérification ne publie aucun installateur.

## Travail restant avant activation

1. Vérifications natives et correction issue de la relecture UX terminées ; conserver leur traçabilité jusqu’au paquet client correspondant.
2. Vérifier deux appareils réels, changement d’espace et destinataire autorisé : nom effectivement reçu, image intégrée et pièce séparément de l’accusé de l’API.
3. Serveur et archive des migrations publiés ; confirmer la lecture distante du schéma et publier les clients correspondants, puis activer le parcours. La fonction demeure incomplète jusqu’à cette recette.
4. La connexion au compte public renvoie encore HTTP 503 à 15 h 01 (compte inexistant synthétique, aucun compte créé ni e-mail envoyé). Cette panne empêche une recette client de bout en bout.

Les fournisseurs SMTP génériques et OAuth ne sont pas rendus partagés par ce seul connecteur Infomaniak.

## Sources du contrat fournisseur

Consultées le 27 septembre 2026, pour le comportement HTTP ; aucun code tiers copié dans le produit :

- [Client officiel Infomaniak — identités, pièces, brouillons et envoi](https://github.com/Infomaniak/mcp-server-mail/blob/main/src/mail-client.ts).
- [Application iOS officielle — disposition inline à l’envoi des pièces](https://github.com/Infomaniak/ios-kMail/blob/master/MailCore/API/MailApiFetcher/MailApiFetcher%2BCommon.swift).
- [Modèle de pièce officielle — content ID](https://github.com/Infomaniak/ios-kMail/blob/master/MailCore/Models/Attachment.swift).
- [Décodeur officiel — noms JSON snake_case](https://github.com/Infomaniak/ios-kMail/blob/master/MailCore/API/MailApiFetcher/MailApiFetcher.swift).
