# Documents des projets et fonctionnement hors ligne

Les plans, photos et fichiers ajoutés avec « Ajouter des documents » sont enregistrés d’abord sur l’appareil. Un poste connecté à un compte Zentra partage ensuite ces fichiers avec les appareils autorisés de la même entreprise. Sur un nouvel appareil configuré, le dossier du projet est créé au premier document reçu, sans inventer de client ni de données comptables.

La copie locale reste disponible sans réseau. Les ajouts et suppressions en attente sont conservés dans SQLite et dans les sauvegardes Zentra. La synchronisation reprend à l’ouverture de l’espace, au retour du réseau, au retour au premier plan et périodiquement tant que l’application est ouverte. Les systèmes mobiles peuvent suspendre une application fermée : la reprise se fait alors à sa prochaine ouverture. Le bouton « Synchroniser » relance immédiatement une tentative.

Chaque fichier est limité à 25 Mo. Les formats acceptés restent PDF, PNG, JPEG, WebP, HEIC/HEIF, Word, Excel, PowerPoint, OpenDocument, TXT et CSV. Un fichier reçu doit correspondre à sa taille, son empreinte SHA-256 et son format avant de remplacer un cache manquant ou altéré. Les fichiers sont conservés localement sans éviction automatique. Une session de compte valide est nécessaire pour communiquer avec le serveur.

La suppression d’un fichier est partagée. Un événement conservé côté serveur empêche un ancien appareil hors ligne de remettre ce même fichier en ligne. Pour ajouter une nouvelle version d’un plan, ajoutez un nouveau fichier. Les envois répétés d’une même référence ne créent pas de doublon. Les fichiers d’un profil déjà lié à une entreprise ne sont jamais envoyés vers une autre entreprise si le compte change.

Cette synchronisation porte sur les fichiers ajoutés aux projets. Elle ne réplique pas les écritures comptables, clients, devis, factures, justificatifs rattachés aux dépenses ni le planning. Le nom du dossier reçu provient du projet lors de l’ajout du document. Le rôle « Lecture seule » autorise la réception et bloque l’envoi et la suppression sur le serveur.

## Implémentation

- Migration locale 58 : liaison à l’entreprise, curseur de réception et file d’attente transactionnelle déclenchée par les ajouts/suppressions de pièces de projet.
- Migration D1 `0010_even_fenris.sql` : événements immuables par entreprise/document/action avec curseur monotone.
- `GET/PUT/DELETE /api/projects/sync` et `GET /api/projects/sync/file` : sessions d’appareils contrôlées par le serveur et droits de l’abonnement existant. Les fichiers privés sont dans R2 ; aucune URL publique de document n’est retournée.
- Un transfert interrompu garde son opération en attente. Le curseur avance après écriture locale vérifiée. Les reprises utilisent les mêmes identifiants, et une suppression a priorité sur un ancien envoi.
- Les sauvegardes locales restent nécessaires : la suppression partagée ne constitue pas une conservation légale ou un historique de toutes les versions.
