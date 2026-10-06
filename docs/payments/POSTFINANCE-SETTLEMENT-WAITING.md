# PostFinance — une attente ne bloque plus les autres vérifications

Un paiement en attente de règlement produisait la même observation `partial`
qu'une erreur du fournisseur. Le relais suspendait donc toutes les vérifications
pendant dix minutes, même si une autre entreprise avait un paiement à vérifier.

Le worker distingue désormais `settlementWaiting` de `failures`. Le relais
enregistre `normal_settlement_wait` sans changer l'état `partial`. Seule une
réponse HTTP 200 corrélée, avec des compteurs entiers cohérents et au plus un
travail, peut lever cette pause globale. La décision doit être une attente
explicite, issue de recherches complètes et de lectures stables, avant la
huitième tentative. Les anciens payloads et les erreurs gardent la pause.

Le délai individuel D1, les baux, les huit tentatives maximales, les preuves de
règlement et les droits restent inchangés. Aucun appel financier supplémentaire
n'est ajouté. La facturation garde sa classification existante.

La migration additive `20261006153908_fair_postfinance_settlement_waiting.sql`
a été créée par la CLI Supabase. Elle ajoute une colonne privée et remplace
la fonction du relais, sans modifier les migrations déjà appliquées, les flags,
le job cron ou les secrets. La fonction conserve son `search_path` vide et ses
restrictions d'accès.

Validation : 69 tests worker/route et 67 contrôles dans PGlite 0.5.8 passent,
avec zéro diagnostic TypeScript. Le scénario de deux entreprises conserve la
date du prochain essai du premier paiement et vérifie le second immédiatement.
Le moteur PostgreSQL est réel ; cron, pg_net et Vault sont des stubs SQL locaux.
Ces contrôles ne prouvent ni une livraison cron réelle ni un paiement marchand.

Le relais et les routes PostFinance restent désactivés en production. Ce
correctif ne configure aucun compte marchand. Le polling de secours, la reprise
opérateur après huit échecs et le branchement de la récupération CREATE restent
des travaux distincts. La récupération CREATE publiée est encore une brique
interne non appelée par les routes ou workers.
