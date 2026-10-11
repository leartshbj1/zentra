# Contexte Gestion publié — contrat du prochain raccord

## Version réellement utilisée

La baseline native 1.90.15, schéma 61 (`app-current-corrections`, commit `56daec734529c06bae6dd73729c74b3a655edb86`) publie des archives `.zentra` via `/api/account/collaboration`. Les têtes et révisions se trouvent dans Supabase. Elle ne possède pas le protocole D1 `business_sync_*` du desktop ancien embarqué dans la copie serveur.

`backup.rs:598–635` écrit `manifest.json`, `database.sqlite3` et `attachments/*`. La commande `export_json` est distincte : aucun catalogue JSON n'est actuellement disponible dans ces archives. Les ressources natives Automation existantes ne couvrent que fournisseurs, projets et catégories ; elles ne suffisent pas à préparer un devis.

Ce document décrit une extension proposée, **pas une projection déjà livrée**. Aucune lecture de véritable archive client ni modification native/Supabase n'a été effectuée dans ce lot.

## Extension additive proposée

Une entrée interne versionnée `automation/resources.v1.json` serait produite depuis la copie SQLite figée par `snapshot_database`, sous l'origine entreprise capturée. Elle ne doit pas relire la base vivante après création de cette copie. Le manifeste ZIP interne peut recevoir un descripteur optionnel (format, version, chemin, SHA-256, taille et nombres de lignes). Le manifeste de transport strict `cloud_backup::Manifest` reste inchangé.

Les anciennes routines de restauration et de digest ignorent les entrées hors fichiers métier connus. Cette compatibilité lue dans le code devra être vérifiée par des tests de restauration avant activation. Écrire manifeste et sidecar sans compression au début du ZIP permettrait une extraction serveur bornée ; le lecteur strict de ZIP et les protections contre entrées dupliquées, tailles trompeuses, traversée de chemins et décompression abusive restent à développer.

Projection minimale :

| Table native | Champs |
| --- | --- |
| `settings`, ligne 1 | pays, devise, onboarding terminé, révision |
| `clients` | ID, nom, e-mail, archive et révision |
| `catalog_items` | ID, type, SKU, nom, description, unité, prix de vente en cents, taux configuré, archive et révision |

La devise appartient à l'entreprise : aucun champ devise par article n'existe dans cette baseline. Conserver les clients archivés empêche de recréer un doublon. Ne pas exporter notes privées, prix d'achat, stocks ou coordonnées bancaires. L'expéditeur est issu de l'enveloppe du connecteur Support ; aucune identité, permission ou adresse n'est inventée à partir d'une instruction contenue dans le mail.

Inclure explicitement `updated_at` dans les révisions/hash du sidecar : le digest partagé existant ignore cette colonne et ne peut pas, seul, prouver les versions attendues par Action Engine.

Bornes proposées à aligner sur le noyau : 4 MiB UTF-8, 5 000 clients et 5 000 articles ; noms 200 caractères, descriptions 1 000, SKU 100, unités 40, prix entiers 0…1 000 000 000 cents et taux configurés 0…10 000 points de base. Dépassement : refus explicite, jamais troncature ou conversion flottante. Le pays historique par défaut CH ne vaut pas validation d'une autre édition.

## Autorité et révision

Réutiliser `collaborationHead`, `collaborationSnapshot`, `downloadCollaborationChunk`, `companyContentManifest` et leurs contrôles SHA. Charger seulement une version publiée pour l'entreprise authentifiée. Lier le contexte à : entreprise + ID snapshot + révision Supabase publiée + SHA archive + SHA sidecar. La révision finale est attribuée après upload/commit ; elle ne peut pas être préinscrite comme si elle était acquise dans le ZIP.

Relire tête et admission après les attentes ; refuser une tête changée, un snapshot non publié ou un sidecar absent/corrompu. Aucun fallback vers le prototype D1. Un hash de contexte TypeScript prouve l'identité des valeurs chargées, pas leur provenance ni leur actualité.

Une lecture Supabase puis une mutation D1 ne forment pas une transaction atomique entre les deux systèmes. Cette frontière devra être résolue explicitement avant activation, avec revalidation native au commit et gestion des conflits. Un simple booléen préflight ne constitue pas une barrière de publication.

## Reçu métier distinct

L'inclusion d'un JSON dans une archive vérifiée ne prouve pas, face à un producteur malveillant, son égalité avec les tables SQLite. La commande native devra corroborer les faits réels avant son commit. Le sidecar clients/catalogue seul ne prouve pas la création d'un devis : la confirmation du registre reste fermée jusqu'au raccord d'un reçu durable, de son outbox et des faits du devis dans la même version publiée.

Le reçu doit être partagé et immuable ; l'outbox d'acquittement doit rester liée à l'installation propriétaire. Un nom `company_local_*` l'exclut du digest/merge, mais `strip_private` ne purge actuellement que ses tables explicitement connues. La nouvelle outbox devra donc être purgée ou rattachée explicitement lors des sauvegardes/restaurations ; un autre appareil ne doit pas hériter de son droit d'acquitter.
