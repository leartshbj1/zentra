# Messagerie : périmètre livré et chronométrage des erreurs

28 septembre 2026. Ce complément corrige l’état récapitulatif, sans remplacer les preuves historiques du lot de messagerie.

## Connexion d’entreprise déjà implémentée

`MailSettings.tsx`, `SharedMailSettings.tsx` et `outgoingMail.ts` distinguent l’adresse Infomaniak partagée de la connexion SMTP locale. Ces fichiers applicatifs sont identiques à ceux du tag public 1.90.6. Le serveur contrôle l’appartenance à l’entreprise et les droits, chiffre la clé par entreprise/révision et conserve un journal partagé avec clé d’idempotence. Une tentative incertaine est interrogée, jamais renvoyée automatiquement.

Le dossier serveur `docs/COMPANY-MAIL-SHARED-20260927.md` conserve les 75 tests serveur du lot initial et les 18 tests natifs CircleCI 141. Les quatre langues et les parcours à pont fictif ont été contrôlés. Cette preuve ne vaut pas réception réelle : les comptes indisponibles empêchent encore la recette autorisée de bout en bout. Le SMTP générique reste local, et aucun support OAuth partagé n’est affirmé.

## Mesure d’erreur corrigée et publiée

Le GET `/api/company-mail` initialisait son chronomètre dans le bloc d’erreur. Un échec après attente apparaissait donc avec une durée de 0 ms. Le début est désormais enregistré avant le contrôle de session et la lecture de la connexion.

Deux contre-épreuves retardent de 1 500 ms la session puis la lecture de messagerie. Elles échouent avant correction (0 ms) et passent après (1 500 ms), en vérifiant la corrélation réponse/journal et l’absence de session ou d’entreprise dans les logs. Les cinq tests de diagnostic existants passent aussi : **7 tests**, TypeScript et compilation de production réussis. Ni authentification, ni secret, ni envoi modifiés.

**Sites 293 publié avec succès le 28 septembre à 02 h 38**, environnement 37 inchangé. Source `15b170780e0d55592005478dadf46c2b7c4a052b`, déploiement `appgdep_6ab9b6e0f8d081919573cb08bda62471`, archive `sha256:8267ac60a2b6ece624cd00379b53e1174ca040591f983171e180484dd0cb47f0` (29 726 720 octets, 696 fichiers).

L’aide de compilation Sites échoue sur l’invocation Windows du gestionnaire de paquets. Le même script déclaré a réussi avec `pnpm run build`, puis le workflow Sites a réutilisé ce résultat, enregistré/poussé la source et préparé l’archive. Dépendances et lockfile inchangés ; avertissement de métadonnées `patchedDependencies`, patch `image-size` confirmé présent dans les deux formats installés. Aucun contournement de contrôle d’application ni suppression de dépendances.

Cette publication améliore le diagnostic. Elle **ne rétablit pas les comptes** : dernière contre-épreuve distincte à 02 h 08, HTTP 503. L’intervention d’hébergement et la recette connectée restent nécessaires.
