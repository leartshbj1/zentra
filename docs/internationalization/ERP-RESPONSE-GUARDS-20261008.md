# Postflight ERP US et rejeu — livraison locale

Base : ae426dafefa0a5b4e1013450fbe60d42ae40ec8b. Travail isolé local, flags fermés, aucun déploiement.

La revue suivante a identifié deux frontières : executeErp retourne un reçu de rejeu sans revalider l'acteur après la lecture ; les handlers HTTP et sync ne revérifient les flags qu'à l'entrée. Cette tranche ajoute des tests intercalés, puis une validation fraîche de l'acteur, du rôle et des droits pour le rejeu ; la fermeture du flag refuse aussi commit/projection/reçu. Les réponses finales HTTP ne doivent pas renvoyer un reçu au mauvais acteur après un commit lent.

Conserver toutes les clés/requêtes originales et les transactions. Une autorisation révoquée après le commit ne supprime pas cette transaction : le serveur retient seulement sa réponse. Le client doit reprendre exactement la même clé après réauthentification, sans fabriquer une nouvelle opération. Les contrôles de taxe/vendeur restent fermés et les transports CH inchangés.

## Modifications terminées

Le moteur revalide les droits, le rôle, l'entreprise et la session après la lecture d'un reçu existant. Le rejeu conserve la clé et le contenu originaux et ne réalise aucune seconde écriture.

Les handlers ERP rechargent la configuration privée sous l'acteur initial, puis vérifient une seule autorité fraîche et enfin les flags, avant commit et après le résultat. Les lectures ERP, de révision et de changements contrôlent aussi les flags après leur dernière attente. La réponse refuse tout changement de rôle, session ou entreprise. Les erreurs et diagnostics ne contiennent aucun document, secret, détail fiscal ou reçu privé.

Une transaction déjà enregistrée reste intacte si l'accès change pendant le commit : seul son résultat est retenu. Ce contrôle ne rend pas la révocation D1 et le commit PostgreSQL atomiques. La récupération exige une nouvelle admission et exactement la même requête, sans nouvelle clé.

Fichiers modifiés : `lib/international/runtime.ts`, `runtime.test.ts`, `runtime-server.ts`, `runtime-sync-server.ts`. Fichiers créés : `lib/international/runtime-response-guards.test.ts`, ce rapport et `docs/evidence/erp-response-guards-20261008.json`.

## Vérifications exécutées

- Cinq défauts de rejeu reproduits avant correction ; les 36 tests du cœur passent ensuite.
- 23 nouveaux tests HTTP/sync discriminants. L'agent rapporte 20 échecs et un témoin vert sur les 21 premiers cas avant correction ; cette baseline est dans les sorties d'outils, sans fichier de log conservé. Les cas finaux figurent dans le résultat durable ci-dessous.
- Suite `lib/international` : **1 034 tests passent, zéro échec, zéro test ignoré, 31 fichiers sélectionnés**. PGlite et preuve locale workerd/D1 activés. Les sous-comptages sont inclus dans ce total, pas additionnels.
- Typecheck global, lint des cinq fichiers, build de production et `git diff --check` passent.
- 107 fichiers SQL historiques comparés aux objets Git de la base : inchangés. Aucune migration proposée ou exécutée.
- Revue indépendante du lot HTTP : aucun défaut matériel relevé. Coût des lectures d'autorité borné : GET/sync deux, POST normal/rejeu trois, émission quatre avec le contrôle après calcul fiscal.

Preuves durables : `.qa/erp-response-guards/` et `docs/evidence/erp-response-guards-20261008.json`. Les tests HTTP sont déterministes et simulés ; ils ne certifient ni sessions réelles, ni latence multi-appareil, ni atomicité entre deux bases.

## Limites et prochaine phase

Les transports et abonnements CH sont inchangés. Aucun déploiement, migration de production, tarif USD, paiement réel vérifié ou paquet natif n'est livré. L'ERP US reste expérimental, fermé par flags et par les dépendances vendeur/fiscalité. Le prochain lot doit relier un petit parcours navigateur aux API durables et conserver la reprise exacte après réponse perdue, sans présenter un moteur fiscal fictif comme opérationnel.
