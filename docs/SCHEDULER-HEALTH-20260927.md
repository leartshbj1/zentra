# Réception serveur : état durable et contrôlable

27 septembre 2026. Complément du correctif de poursuite des files Support et Automation.

## Ce qui change

La présence du réglage `SUPPORT_MAIL_BACKGROUND_ENABLED=1` ne suffit plus à afficher que la réception continue lorsque Support est fermé. Il faut aussi un traitement réussi récent. Les réglages de la boîte et l’administration affichent l’état, une action utile et la date du dernier passage confirmé. L’administration peut actualiser cet état sans lancer un traitement.

La migration additive `0062_scheduler_health.sql` crée une seule ligne pour le worker partagé `support.mail`. Elle conserve les dernières dates de début, fin, réussite, échec et une référence technique opaque. Aucun contenu de message, secret, identifiant client ou montant n’y est enregistré. Les dates ne reculent pas lorsqu’un cycle plus ancien écrit après un cycle récent.

Les cycles anonymes ne lisent ni n’écrivent ce suivi. Une erreur de stockage du suivi est journalisée sans son message potentiellement sensible et n’empêche pas le worker de traiter les files. Une absence de table ou une panne de lecture donne un état indisponible, jamais un état sain.

## Lecture des états

| État | Condition | Réception en arrière-plan annoncée |
| --- | --- | --- |
| Inactif | Réglage d’arrière-plan absent ou désactivé | Non |
| À vérifier | Aucun cycle terminé avec succès | Non |
| En cours | Un début plus récent que la dernière fin | Seulement si une réussite date de moins de 15 minutes |
| Vérifié | Cycle récent terminé sans erreur | Oui |
| En retard | Dernière fin de plus de 15 minutes, ou début inachevé de plus de 10 minutes | Non |
| Échec | Dernier cycle terminé en échec | Non |
| Indisponible | Lecture du suivi impossible | Non |

Un lot partiel sans erreur est un passage réussi du worker ; il ne signifie pas que toutes les files sont vides. L’état est global : il ne prouve ni la livraison d’un e-mail précis ni le bon fonctionnement de chaque boîte. La dernière récupération et l’erreur propres à chaque boîte restent affichées séparément. Une réussite ultérieure rétablit l’état sain ; ce tableau n’est pas un historique d’incidents.

## Point de contrôle pour la supervision

`GET https://zentraapp.ch/api/support/mail-sync` nécessite le même en-tête `Authorization: Bearer …` que le worker. Aucun secret dans l’URL. Ce GET est strictement en lecture : il ne traite aucun message, ne renouvelle pas la date du worker et ne masque donc pas un arrêt.

- 200 : réglage actif et exécution récente vérifiée.
- 503 : réception autonome non établie, retard, échec ou stockage indisponible.
- 401 : secret manquant ou refusé.

Les réponses sont `no-store`. Un moniteur extérieur peut vérifier cet endpoint toutes les cinq minutes et déclencher une alerte après deux échecs successifs. Le token doit rester dans le coffre du moniteur, jamais dans un journal, une capture, le code ou un ticket.

## Validation du lot

363 tests ciblés dans 24 fichiers : Support, Automation, diagnostics et santé. Inclut la vraie migration SQLite, le refus des requêtes non autorisées, les écritures arrivant hors ordre, l’expiration sans nouveau passage, les erreurs de stockage, l’absence de fuite dans les logs, la reprise après échec et le GET sans effet de bord. TypeScript, ressources de marque et compilation de production réussis.

16 parcours et captures locales des composants réels avec données fictives : Chromium et WebKit, 320, 390 et 1440 pixels ; états vérifié, retard, échec, inactif, indisponible et non vérifié. Aucune erreur JavaScript ni débordement horizontal dans ces captures. Le bouton d’actualisation admin relit les données et reste utilisable au clavier. Les captures locales utilisent la police de repli Arial ; elles ne constituent pas une validation sur iPhone physique.

## Limites de publication

Ce lot ne crée pas de planificateur et n’active pas le drapeau d’arrière-plan. Le contrôle actuel des quotas Supabase bloque toujours l’authentification (constat distinct dans l’audit). Après publication, vérifier la présence de la nouvelle table et le refus d’accès anonyme, puis constater un vrai cycle distant avant d’activer la réception autonome. Le moniteur extérieur et son alerte réelle restent à configurer et tester. Aucun nouvel installateur natif n’est produit par ce lot serveur.
