# Premier adaptateur Gestion — contrat à implémenter

Ce document décrit le prochain lot. Aucune commande native Action Engine n'est encore livrée. Base inspectée : `app-current-corrections`, desktop 1.90.15, schéma local 61, commit `56daec734529c06bae6dd73729c74b3a655edb86`.

## Une commande, une transaction

Le chemin sera une commande Rust dédiée, sous le verrou existant de l'entreprise et le contexte membre capturé avant toute attente (`commands.rs:1949`, `workspaceMemberOrigin.ts:26`). Les commandes génériques client puis document ouvrent deux transactions distinctes : ne pas les enchaîner.

Dans une transaction SQLite IMMEDIATE unique :

1. Vérifier l'origine locale, l'entreprise liée, l'utilisateur, la capacité de créer un client et un brouillon, le contrat de réservation serveur et son empreinte. Aucun ID d'installation déclaré par la WebView ne vaut identité authentifiée.
2. Rechercher le reçu historique de cette réservation avant toute nouvelle écriture. Un reçu trouvé renvoie le résultat sans écraser les modifications ultérieures.
3. Relire et corroborer source, client et catalogue. Le client existant doit rester actif et unique par e-mail ; un nouveau client ne doit pas avoir été créé entre-temps. Contrôler révisions et génération, unités, prix, devise et taux configurés.
4. Créer, si nécessaire, le client avec l'ID réservé ; insérer le devis avec l'ID réservé, statut `brouillon`, numéro NULL et lignes détaillées. Ne pas émettre, envoyer, payer ou comptabiliser.
5. Recalculer chaque ligne en entiers `i128`, quantités en millièmes et cents bornés, avec les mêmes arrondis que le noyau TypeScript. Conserver la quantité exacte dans la preuve. Éviter le chemin existant qui recalcule en `f64` et sature silencieusement.
6. Écrire provenance, acteur, reçu, audit et outbox SQL privé d'acquittement dans la même transaction. Aucun bearer ou secret dans l'outbox.
7. Commit, puis publication par le mécanisme Supabase existant. Le rapprochement serveur du reçu avec une publication métier vérifiée reste à implémenter : les archives/chunks ne fournissent pas encore de projection serveur clients/catalogue ni de preuve canonique Action Engine. Le prototype D1 business-sync de l'ancien desktop est une piste distincte, pas le raccord livré de cette baseline.

## Détails du modèle actuel

- Catalogue : `schema.rs:303–319`, prix en cents, taux en points de base, `updated_at`. Aucune devise par article : utiliser la devise d'entreprise capturée, jamais celle du mail.
- Clients : `schema.rs:284–301`, pays par défaut CH. Ne pas l'appliquer aveuglément à une autre édition et ne pas déduire un pays de la langue de l'expéditeur.
- Brouillons : `quotes.number` nullable (`schema.rs:367–369`). La numérotation se fait à l'émission ; un numéro artificiel activerait les protections d'un document finalisé.
- Document/lignes/reçu actuels : `database.rs:3031`, `5794` ; réutiliser leurs invariants, sans appeler deux fonctions qui ouvrent chacune une transaction.
- Créateur et horloge de synchronisation : `company_collaboration.rs:144` et triggers locaux. Le `pending` d'archive est construit hors transaction (`:887–896`) : ce fichier de préférences ne constitue pas l'outbox atomique requis.
- Audit append-only : `audit.rs:13`. Ne pas utiliser un simple message de journal comme preuve d'un commit métier.

## Reprise entre appareils

La réservation D1 n'expire pas et ne change pas d'installation automatiquement. Un délai réseau ne prouve pas l'absence de commit local. Après une réponse perdue, le même appareil rapproche d'abord son reçu/outbox et la version Supabase publiée correspondante, avec corroboration métier encore à développer. Une autre installation reste en attente tant que cette situation n'est pas résolue ; elle ne reçoit pas de nouveaux IDs pour recommencer.

Avant une nouvelle écriture, l'admission et les versions sont revalidées. La récupération d'un reçu confirmé reste possible après modification du catalogue. L'ouverture du devis doit relire le document dans son état actuel : un reçu historique de création ne signifie pas qu'il est encore brouillon aujourd'hui.

## Essais à réaliser

Crash avant commit, après commit et avant publication, perte d'accusé, réouverture du même appareil, second appareil concurrent, changement d'entreprise/compte pendant HTTP, révocation/abonnement expiré, restauration locale sans reçu, article ou client modifié/archivé, même e-mail créé simultanément, collisions d'IDs, devis émis après création et nouvelle tentative. Ces essais natifs ne sont pas remplacés par les tests du registre D1.
